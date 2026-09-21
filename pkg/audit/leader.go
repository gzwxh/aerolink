package audit

import (
	"context"
	"fmt"
	"os"
	"sync/atomic"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// —— 周期性全局任务的选主（多副本去重）——
//
// 先说清一件容易搞错的事：**多副本下各副本并不都会写同一份归档**。审计记录的投递是纯进程内的
// （model.forwardAuditMessage 遍历的是本进程注册的回调，没有任何跨副本广播），而绝大多数记录产生
// 在各自的 HTTP 请求路径上——一个请求只落在一个副本，于是那条记录也只在那一个副本上被归档。
// 所以「选一个副本写归档」是**错的**：非主副本上产生的记录会直接没人写，sink≠database 时这些
// 记录连库都没有（model.RecordAudit 不落库），等于静默丢掉整段审计。
//
// 真正会重复的是**周期性任务**：它们由每个副本的进程各自启动，操作的是全局共享的状态，于是
// 同一个动作被做 N 遍、并在审计里留下 N 条一模一样的记录。目前这类任务只有审计保留策略巡检
// （PruneExpiredAuditRecords：删全局共享的库里过期行 + 删全局共享的 ES 按天索引 + 自己写一条
// 「prune」留痕记录）。本文件的租约就是给它选执行者的。
//
// 这种「把全局任务锁到单个执行者」的做法在本仓库已有先例：pkg/scheduler 给定时任务加锁
// （`ScheduledTask.lock_until` + `locked_by`）也是同一个思路，只是那把锁随任务行走。
//
// 用数据库里的一把租约（`leader_leases`，见 pkg/model/leader.go）决定谁执行：多副本本就共用
// 同一个库，不值得为选主引入 etcd/Redis。语义与 K8s 的 Lease 一致——持有者按 TTL 续约，租约
// 过期（进程挂死、网络分区）后其它副本接管；接管瞬间可能重复跑一次巡检，这好过保留策略永久
// 停摆（过期数据只涨不降）。
const (
	// auditRetentionLeaseName 是「谁来跑审计保留策略巡检」的租约名。
	auditRetentionLeaseName = "audit-retention"
	// auditLeaseTTL 是租约有效期。主副本每 auditLeaseHeartbeat 续约一次，连续三次没续上
	// （进程挂死、网络分区）才允许别人接管。
	auditLeaseTTL = 30 * time.Second
	// auditLeaseHeartbeat 是续约间隔：TTL 的 1/3，留两次重试的余量。
	auditLeaseHeartbeat = 10 * time.Second
)

// auditLeading 报告本副本当前是否负责跑审计的周期性全局任务。
var auditLeading atomic.Bool

// auditLeaseFailed 记录「上一次续约是否失败」，用于把库不可用时的日志从每 10 秒一条压成
// 「出问题时一条、恢复时一条」——高频错误日志会被淹没，等于没有。默认为 false（健康）。
var auditLeaseFailed atomic.Bool

// auditLeaseHolder 返回本副本的持有者标识。
//
// 用「主机名-进程号」而不是随机 ID：K8s 每个 Pod 的主机名唯一，宿主机上多进程部署靠进程号
// 区分，且日志里一眼能认出是哪个副本在跑。
func auditLeaseHolder() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown"
	}
	return fmt.Sprintf("%s-%d", host, os.Getpid())
}

// runAuditLeaseLoop 持续争取（并续约）周期性任务的执行权，随 ctx 退出。
func runAuditLeaseLoop(ctx context.Context) {
	holder := auditLeaseHolder()
	ticker := time.NewTicker(auditLeaseHeartbeat)
	defer ticker.Stop()

	for {
		renewAuditLease(holder)
		select {
		case <-ctx.Done():
			// 主动让位：正常退出（滚动升级）时下一个副本不必等 TTL 到期。
			auditLeading.Store(false)
			if err := model.ReleaseLeaderLease(auditRetentionLeaseName, holder); err != nil {
				klog.Warningf("audit retention lease could not be released: %v", err)
			}
			return
		case <-ticker.C:
		}
	}
}

// renewAuditLease 续约一次（或首次抢），并同步本副本的执行权状态。
func renewAuditLease(holder string) {
	held, err := model.AcquireLeaderLease(auditRetentionLeaseName, holder, auditLeaseTTL)
	if err != nil {
		// 库抖动时**保持现状**，不主动放弃：放弃等于保留策略停摆（过期数据只涨不降，而巡检本身
		// 还会写留痕记录），而继续跑着的最坏情况是与接管者重复巡检一次（删除是幂等的）。
		if !auditLeaseFailed.Swap(true) {
			klog.Errorf("failed to renew the audit retention lease, keeping the current state: %v", err)
		}
		return
	}
	if auditLeaseFailed.Swap(false) {
		klog.Infof("the audit retention lease is renewable again (holder=%s)", holder)
	}

	switch {
	case held && !auditLeading.Swap(true):
		klog.Infof("this replica now runs the audit retention worker (holder=%s)", holder)
	case !held && auditLeading.Swap(false):
		// 只有确认租约已被别人拿走才让出：此时继续跑就会重复执行全局任务。
		klog.Warningf("another replica took over the audit retention worker, standing down (holder=%s)", holder)
	}
}
