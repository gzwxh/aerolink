package audit

import (
	"context"
	"sync/atomic"
	"time"

	"aerolink/pkg/model"
	"k8s.io/klog/v2"
)

// —— 多副本下让设置收敛 ——
//
// 为什么需要这个：`UpdateAuditSetting` 只在**处理这次请求的那个副本**上重载配置，其它副本内存里
// 还是启动时的旧值（`internal.StartConfigWatcher` 盯的是配置文件，不是库里的设置）。多副本部署下
// 改完外发/归档设置，只有 1/N 个副本按新配置工作，要等重启才收敛——这属于「配了没生效」，必须修。
//
// 做法：给审计设置算一个内容指纹，每个副本低频轮询比较；变了就把各链路按最新设置重载一遍。
// 不能无条件周期重载：`reloadArchiveConfig` 会重建归档运行时（停掉 writer 再建），无谓重建会不停
// 切文件、把小批次都冲成单独文件，所以必须先判断「真的变了」。

// auditSettingPollInterval 是收敛设置的轮询间隔。审计设置是低频操作，30 秒足够；
// 一次轮询只读一行的一个字段算哈希，开销可以忽略。
const auditSettingPollInterval = 30 * time.Second

// appliedSettingRevision 是本进程**已经应用到内存里**的设置指纹。
//
// 用原子指针而不是互斥量：只在轮询 goroutine 与保存设置的请求路径上读写，两者都不需要
// 与其它状态保持一致。
var appliedSettingRevision atomic.Pointer[string]

// StartSettingWatcher 启动设置收敛轮询，随 ctx 退出。
//
// 由 app.go 在启动各外发/归档链路**之后**调用：此时内存里已经是库里的最新设置，先把指纹记下来，
// 之后只在指纹变化时才重载。
func StartSettingWatcher(ctx context.Context) {
	markAuditSettingApplied()
	go runSettingWatchLoop(ctx, auditSettingPollInterval)
}

// runSettingWatchLoop 是轮询本体（间隔可注入，便于直接验证收敛行为）。
func runSettingWatchLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			convergeAuditSetting()
		}
	}
}

// convergeAuditSetting 检查设置是否变过，变了就重载。
func convergeAuditSetting() {
	revision, err := model.AuditSettingRevision()
	if err != nil {
		klog.Warningf("failed to read the audit setting revision: %v", err)
		return
	}
	if applied := appliedSettingRevision.Load(); applied != nil && *applied == revision {
		return
	}
	applyAuditSettingChanges()
	klog.Infof("applied updated audit settings on this replica")
	appliedSettingRevision.Store(&revision)
}

// markAuditSettingApplied 记下当前库里的设置指纹。
//
// 调用点：启动各链路之后、以及保存设置之后（不留这个标记的话，保存设置的副本会在下一轮
// 把同一份配置再重载一遍——归档运行时会被无谓重建）。
func markAuditSettingApplied() {
	revision, err := model.AuditSettingRevision()
	if err != nil {
		// 读不到就先不记：这种情况下一轮会走「指纹为空 → 重载一次」，是安全的方向。
		klog.Warningf("failed to read the audit setting revision: %v", err)
		return
	}
	appliedSettingRevision.Store(&revision)
}
