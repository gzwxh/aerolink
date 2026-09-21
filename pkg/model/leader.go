package model

import (
	"time"

	"gorm.io/gorm"
)

// LeaderLease 是「某个周期性全局任务由哪个副本执行」的租约行（按 name 唯一）。
//
// 为什么需要它：多副本部署下每个副本的进程都会启动同一批周期性任务，而这些任务操作的是
// **全局共享**的状态（同一个库、同一批外部资源）。各自都跑一遍的后果有两类：一类是纯粹的
// 重复动作（审计里出现 N 条一模一样的记录），一类是互相抢同一批行（N 个副本同时删同一段
// 过期数据，互相把对方的删除弄成 0 行）。执行权用一把库里的租约选定，与 pkg/scheduler 给
// 定时任务加锁（`ScheduledTask.lock_until`）同一个思路——多副本本就共用同一个数据库，
// 不值得为选主引入 etcd/Redis。
//
// 语义与 Kubernetes 的 Lease 相同：持有者按 TTL 续约，租约过期（进程挂死、网络分区）后
// 其它副本可以接管。这里不追求强一致——租约保证「正常情况下只有一个执行者」，接管瞬间
// 可能重复执行一次，好过任务永久停摆。
type LeaderLease struct {
	// Name 是租约名（全局唯一），多副本抢同一把；不同任务用不同的名字互不干扰。
	Name string `gorm:"primaryKey;size:64" json:"name"`
	// Holder 是持有者标识（主机名 + 进程号，见 pkg/audit 的 auditLeaseHolder）。
	Holder string `gorm:"size:128;not null" json:"holder"`
	// ExpiresAt 是租约到期时间：过期即可被别的副本抢走。
	ExpiresAt time.Time `gorm:"not null;index" json:"expires_at"`
	// Renewals 是续约次数。它存在的意义是让每次续约都**确实改变这一行**：MySQL 的
	// RowsAffected 统计的是「值真的变了的行数」，若只写 expires_at（时间精度截断时可能写成
	// 同一个值），会拿到 0 而被误判成「丢了租约」。
	Renewals  uint64    `gorm:"not null;default:0" json:"renewals"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (LeaderLease) TableName() string {
	return "leader_leases"
}

// AcquireLeaderLease 尝试把租约抢到 holder 名下，返回本副本是否持有它。
//
// 抢的条件是「自己已经是持有者（续约）」或「租约已过期（接管）」，写在同一条 UPDATE 的
// WHERE 里：并发抢同一把租约时数据库只会让一个副本拿到（RowsAffected=1），不需要额外的事务
// 或应用层锁。
func AcquireLeaderLease(name, holder string, ttl time.Duration) (bool, error) {
	now := time.Now()
	expiresAt := now.Add(ttl)
	assignments := map[string]any{
		"holder":     holder,
		"expires_at": expiresAt,
		"renewals":   gorm.Expr("renewals + 1"),
	}

	result := DB.Model(&LeaderLease{}).
		Where("name = ? AND (holder = ? OR expires_at < ?)", name, holder, now).
		Updates(assignments)
	if result.Error != nil {
		return false, result.Error
	}
	if result.RowsAffected > 0 {
		return true, nil
	}

	// 没有抢到：要么这一行还不存在（首次启动），要么被别人持有且尚未过期。
	// 先按「还不存在」试建；撞主键说明另一个副本刚刚建好，这一轮不抢（下一轮再走上面的续约）。
	lease := LeaderLease{Name: name, Holder: holder, ExpiresAt: expiresAt, Renewals: 1}
	if err := DB.Create(&lease).Error; err != nil {
		if isUniqueConstraintError(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// ReleaseLeaderLease 主动让出租约（进程正常退出时调用，让其它副本立刻接管而不是等 TTL）。
//
// 只删自己持有的那一行：条件里带上 holder，避免把已经被别人接管的租约误删。
func ReleaseLeaderLease(name, holder string) error {
	return DB.Where("name = ? AND holder = ?", name, holder).Delete(&LeaderLease{}).Error
}
