package model

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// LoginAttempt 记录某个登录来源的失败计数与封锁状态。
//
// Key 形如 `ip:1.2.3.4` 或 `user:alice`——两个维度各自独立计数。状态放在数据库里而不是
// 进程内存里：控制台跑多个副本时，各算各的等于把「错 N 次锁定」的上限放大 N 倍，
// 管理员手动拉黑的 IP 也只对其中一个副本生效。
//
// ⚠ 列名 key 是 **MySQL 的保留字**：在原始 SQL 条件里引用它必须走 map 条件或 clause
// （两者都会按方言加引号）。裸写 "key = ?" 在 MySQL 8 上是 1064 语法错误，而 SQLite /
// PostgreSQL 把它当普通标识符、照常通过——所以这种问题只在 MySQL 上暴露，本地用
// PG/SQLite 联调发现不了。
type LoginAttempt struct {
	Key string `gorm:"primaryKey;size:255" json:"key"`
	// FailureCount 是当前窗口内的失败次数；触发封锁时会清零（与封锁前的老实现一致）。
	FailureCount int `gorm:"not null;default:0" json:"failure_count"`
	// WindowStart 是当前计数窗口的起点。窗口过期后下一次失败会把计数重置为 1，
	// 所以这是一个固定窗口计数，而不是逐条记录失败时刻的滑动窗口。
	WindowStart time.Time `gorm:"column:window_started_at" json:"window_started_at"`
	// BlockedUntil 为 noBlock（1970-01-01）表示未封锁，见 noBlock 的说明。
	BlockedUntil time.Time `gorm:"index" json:"blocked_until"`
	// ManualBlock 标记管理员手动拉黑：它优先于 IP 白名单豁免。
	ManualBlock bool      `gorm:"not null;default:false" json:"manual_block"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// noBlock 是「未被封锁 / 计数窗口早已过期」在库里的表示，用来代替 time.Time 的零值。
//
// 为什么不能用零值：go-sql-driver 会把零值时间渲染成 '0000-00-00 00:00:00'，MySQL 严格模式
// （默认带 NO_ZERO_DATE + STRICT_TRANS_TABLES，5.7 / 8.0 都是）直接报 Error 1292，而 SQLite /
// PostgreSQL 照收——于是登录失败计数与自动锁定在 MySQL 上会静默失效（错误只留一条 Warning）。
// 纪元时间在三家库上都是合法日期，且与零值在所有比较里的结果完全一致：
//   - now.Before(BlockedUntil) → false（attemptBlocked 视为未封锁）
//   - blocked_until > now → 不匹配、window_started_at < cutoff → 匹配（与零值相同）
var noBlock = time.Unix(0, 0).UTC()

// keyEquals 是把 key 列名交给 GORM 做方言引号的等值条件（见类型注释）。
func keyEquals(key string) map[string]interface{} {
	return map[string]interface{}{"key": key}
}

// GetLoginAttempt 读取某个来源的计数行；没有记录时返回 gorm.ErrRecordNotFound。
func GetLoginAttempt(key string) (*LoginAttempt, error) {
	var attempt LoginAttempt
	if err := DB.Where(keyEquals(key)).First(&attempt).Error; err != nil {
		return nil, err
	}
	return &attempt, nil
}

// RecordCredentialLoginFailure 为某个来源原子地记一次失败，返回该来源在窗口内的失败次数。
//
// 「窗口过期就重置、否则加一」写在同一条 UPDATE 里（CASE 表达式三家 SQL 都支持），
// 避免读-改-写导致并发失败互相覆盖计数。返回的次数在并发下可能略高于本次调用
// 自己的贡献——那只会让封锁早一点生效，是安全的方向。
func RecordCredentialLoginFailure(key string, now time.Time, window time.Duration) (int, error) {
	cutoff := now.Add(-window)
	assignments := map[string]interface{}{
		"failure_count": gorm.Expr(
			"CASE WHEN window_started_at < ? THEN 1 ELSE failure_count + 1 END", cutoff),
		"window_started_at": gorm.Expr(
			"CASE WHEN window_started_at < ? THEN ? ELSE window_started_at END", cutoff, now),
	}
	result := DB.Model(&LoginAttempt{}).Where(keyEquals(key)).Updates(assignments)
	if result.Error != nil {
		return 0, result.Error
	}
	if result.RowsAffected == 0 {
		// 还没有这一行：建一行计数为 1。撞主键说明另一个失败抢先建好了，重试 UPDATE。
		err := DB.Create(&LoginAttempt{
			Key:          key,
			FailureCount: 1,
			WindowStart:  now,
			// 零值时间在 MySQL 严格模式下写不进去（见 noBlock）。
			BlockedUntil: noBlock,
		}).Error
		if err == nil {
			return 1, nil
		}
		if !isUniqueConstraintError(err) {
			return 0, err
		}
		result = DB.Model(&LoginAttempt{}).Where(keyEquals(key)).Updates(assignments)
		if result.Error != nil {
			return 0, result.Error
		}
	}

	attempt, err := GetLoginAttempt(key)
	if err != nil {
		return 0, err
	}
	return attempt.FailureCount, nil
}

// BlockLoginAttempt 把某个来源封锁到给定时间，并清空失败计数。
// manual 为 true 表示管理员手动拉黑（优先于白名单豁免）。
func BlockLoginAttempt(key string, until time.Time, manual bool) error {
	assignments := map[string]interface{}{
		"blocked_until": until,
		"failure_count": 0,
	}
	if manual {
		assignments["manual_block"] = true
	}
	result := DB.Model(&LoginAttempt{}).Where(keyEquals(key)).Updates(assignments)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		attempt := &LoginAttempt{
			Key:          key,
			BlockedUntil: until,
			ManualBlock:  manual,
			// 同上：window_started_at 也不能留零值。
			WindowStart: noBlock,
		}
		if err := DB.Create(attempt).Error; err != nil {
			if !isUniqueConstraintError(err) {
				return err
			}
			return DB.Model(&LoginAttempt{}).Where(keyEquals(key)).Updates(assignments).Error
		}
	}
	return nil
}

// DeleteLoginAttempts 删除给定来源的计数行（成功登录、管理员解除封锁）。
func DeleteLoginAttempts(keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	values := make([]interface{}, 0, len(keys))
	for _, key := range keys {
		values = append(values, key)
	}
	return DB.Where(clause.IN{Column: clause.Column{Name: "key"}, Values: values}).
		Delete(&LoginAttempt{}).Error
}

// ListLoginAttempts 返回某个前缀（例如 "ip:"）下、当前仍处于封锁状态的记录，
// 按封锁到期时间倒序。
func ListLoginAttempts(prefix string, now time.Time) ([]LoginAttempt, error) {
	var attempts []LoginAttempt
	err := DB.Where(clause.Like{Column: clause.Column{Name: "key"}, Value: prefix + "%"}).
		Where("blocked_until > ?", now).
		Order("blocked_until DESC").
		Find(&attempts).Error
	return attempts, err
}

// CleanupLoginAttempts 删除既已解除封锁、计数窗口也早已过期的行。
//
// 计数窗口过期的行留着也不会造成误锁（下次失败会重置计数），这里只是别让表无限增长。
func CleanupLoginAttempts(now time.Time, window time.Duration) error {
	return DB.Where("blocked_until <= ? AND window_started_at < ?", now, now.Add(-window)).
		Delete(&LoginAttempt{}).Error
}
