package model

import (
	"errors"
	"time"

	"gorm.io/gorm"
)

// UserSession 记录一个用户当前会话的元数据：会话序号（用来让更新的登录顶掉旧令牌）、
// 开始时间与最近活动时间（用来执行空闲/绝对生存期限制）。
//
// 它放在数据库里而不是进程内存里：控制台可能跑多个副本，两个限制必须跨副本一致。
// 每个用户一行——同一个用户只需要保留最新一次登录的状态。
type UserSession struct {
	UserID    uint      `gorm:"primaryKey" json:"user_id"`
	Seq       uint64    `gorm:"not null;default:0" json:"seq"`
	StartedAt time.Time `gorm:"not null" json:"started_at"`
	LastSeen  time.Time `gorm:"not null" json:"last_seen"`
	UpdatedAt time.Time `json:"updated_at"`
}

// GetUserSession 读取某个用户的会话状态；没有记录时返回 gorm.ErrRecordNotFound。
func GetUserSession(userID uint) (*UserSession, error) {
	var session UserSession
	if err := DB.Where("user_id = ?", userID).First(&session).Error; err != nil {
		return nil, err
	}
	return &session, nil
}

// userSessionStartAttempts 是序号自增遇到并发冲突时的重试次数。同一个用户的并发登录
// 本来就罕见，给足余量即可；用尽仍失败时调用方会退化成「不记录会话」（失败开放）。
const userSessionStartAttempts = 8

// StartUserSession 记录一次新登录：序号自增，同时刷新开始时间与最近活动时间。
//
// 用「读 + 比较并交换」而不是 `seq = seq + 1` 直接 UPDATE：后者本身没问题，但**读回**
// 新序号的那一步不是原子的——两个并发登录可能读到同一个（更新的那次留下的）序号，于是
// 两个会话拿到同一个 seq，顶下线就失效了。这里把「当前值」作为 UPDATE 的条件，
// `RowsAffected == 1` 才说明这次递增属于自己，序号因此唯一。
//
// 选 CAS 而不是事务加行锁：`SELECT ... FOR UPDATE` 在 SQLite 上不存在，
// 而 `INSERT ... ON CONFLICT DO UPDATE` 的表达式列引法三家 SQL 各不相同。
func StartUserSession(userID uint, now time.Time) (*UserSession, error) {
	for attempt := 0; attempt < userSessionStartAttempts; attempt++ {
		session, err := GetUserSession(userID)
		if err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
			// 还没有这一行：建 seq=1。撞主键说明另一个登录抢先建好了，重试走下面的分支。
			err = DB.Create(&UserSession{
				UserID:    userID,
				Seq:       1,
				StartedAt: now,
				LastSeen:  now,
			}).Error
			if err == nil {
				// 同样只返回自己写进去的值：读回来的话可能已经被并发的
				// 登录推进到更大的序号，那个序号属于别人。
				return &UserSession{
					UserID:    userID,
					Seq:       1,
					StartedAt: now,
					LastSeen:  now,
				}, nil
			}
			if !isUniqueConstraintError(err) {
				return nil, err
			}
			continue
		}

		next := session.Seq + 1
		result := DB.Model(&UserSession{}).
			Where("user_id = ? AND seq = ?", userID, session.Seq).
			Updates(map[string]interface{}{
				"seq":        next,
				"started_at": now,
				"last_seen":  now,
			})
		if result.Error != nil {
			return nil, result.Error
		}
		if result.RowsAffected == 1 {
			// 序号来自自己这次成功的递增，不必（也不该）再读一次。
			return &UserSession{
				UserID:    userID,
				Seq:       next,
				StartedAt: now,
				LastSeen:  now,
				UpdatedAt: now,
			}, nil
		}
		// 另一个登录抢先推进了序号：重新读一次再试。
	}
	return nil, errors.New("failed to start the user session: too many concurrent sign-ins")
}

// TouchUserSession 只刷新最近活动时间。
func TouchUserSession(userID uint, lastSeen time.Time) error {
	return DB.Model(&UserSession{}).Where("user_id = ?", userID).
		Update("last_seen", lastSeen).Error
}

// DeleteUserSession 丢弃某个用户的会话状态（例如空闲超时被踢下线）。
func DeleteUserSession(userID uint) error {
	return DB.Where("user_id = ?", userID).Delete(&UserSession{}).Error
}

// CleanupExpiredUserSessions 删除早于 cutoff 就已开始、且最近也没有活动的行。
//
// 只清「按任何策略都不可能仍然有效」的行：策略里的空闲/生存期上限由 auth 层决定，
// 这里用一个宽松的界限，避免误删仍然有效的会话状态（删了下一次登录就会从 1 重新计数）。
func CleanupExpiredUserSessions(cutoff time.Time) error {
	return DB.Where("started_at < ? AND last_seen < ?", cutoff, cutoff).Delete(&UserSession{}).Error
}
