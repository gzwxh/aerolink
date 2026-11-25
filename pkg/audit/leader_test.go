package audit

import (
	"context"
	"testing"
	"time"

	"aerolink/pkg/model"
)

// withAuditLeadership 直接设定「本副本是否负责周期性全局任务」并负责还原。
//
// 选主的真实路径是 runAuditLeaseLoop 里的租约续约（10 秒级心跳），租约本身的语义在
// pkg/model 的单测里覆盖；这里只验证「执行权 → 任务是否跑」的接线。
func withAuditLeadership(t *testing.T, leading bool) {
	t.Helper()
	previous := auditLeading.Load()
	t.Cleanup(func() { auditLeading.Store(previous) })
	auditLeading.Store(leading)
}

// 多副本下保留策略巡检必须只由一个副本执行：它是全局操作，N 个副本同时跑会互相抢同一批行，
// 并各自写一条重复的「prune」留痕记录（这正是重复归档里最典型的一类）。
func TestRetentionLoopOnlyPrunesWhenLeading(t *testing.T) {
	setupRetentionTestDB(t)

	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })
	model.AuditSink = model.AuditSinkDatabase

	seedExpired := func() {
		row := model.ResourceHistory{
			ResourceType: "pods", ResourceName: "web", OperationType: "update", Success: true,
		}
		row.CreatedAt = time.Now().AddDate(0, 0, -100)
		if err := model.DB.Create(&row).Error; err != nil {
			t.Fatalf("seeding an expired record: %v", err)
		}
	}
	countExpired := func() int64 {
		var rows int64
		model.DB.Model(&model.ResourceHistory{}).
			Where("resource_type = ?", "pods").
			Count(&rows)
		return rows
	}

	// 保留 30 天：上面那条 100 天前的记录属于过期数据。
	setting := model.DefaultAuditSettingData()
	setting.RetentionDays = 30
	if _, err := model.UpdateAuditSetting(setting); err != nil {
		t.Fatalf("saving audit setting: %v", err)
	}

	// 非主副本：巡检空转，数据必须原样留着。
	withAuditLeadership(t, false)
	seedExpired()
	runRetentionLoopOnce(t, 0)
	if got := countExpired(); got != 1 {
		t.Fatalf("非主副本不该执行清理, got %d 条过期记录", got)
	}

	// 主副本（或接管后）：正常清理。
	auditLeading.Store(true)
	runRetentionLoopOnce(t, 0)
	if got := countExpired(); got != 0 {
		t.Fatalf("主副本应当清掉过期记录, got %d 条", got)
	}
}

// runRetentionLoopOnce 跑一轮保留策略循环（首次延迟 0，跑完一轮就取消）。
func runRetentionLoopOnce(t *testing.T, delay time.Duration) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// 间隔取很长：这一轮跑完就随 cancel 退出，不会等到第二轮。
		runRetentionLoop(ctx, delay, time.Hour)
	}()

	// 等初始化完成（循环已进入 select）后取消；给首次触发留出执行时间。
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("保留策略循环没有随 ctx 退出")
	}
}

// 持有者标识要能区分副本，且不依赖任何需要协调的外部状态。
func TestAuditLeaseHolderIdentifiesTheReplica(t *testing.T) {
	holder := auditLeaseHolder()
	if holder == "" || holder == "unknown-0" {
		t.Errorf("持有者标识不该为空/回落值: %q", holder)
	}
	if again := auditLeaseHolder(); again != holder {
		t.Errorf("同一进程内的持有者标识必须恒定: %q != %q", again, holder)
	}
	if len(holder) > 128 {
		t.Errorf("持有者标识必须放得进 holder 列（<=128），got %d", len(holder))
	}
}

// 续约成功后本副本成为执行者；被别人接管后必须让出（不再跑全局任务）。
func TestRenewAuditLeaseTracksOwnership(t *testing.T) {
	db := setupRetentionTestDB(t)
	withAuditLeadership(t, false)

	renewAuditLease("this-replica")
	if !auditLeading.Load() {
		t.Fatal("首次续约成功后应当成为执行者")
	}

	// 另一个副本持有未过期的租约（直接改写租约行来模拟接管）：本副本让出。
	if err := db.Model(&model.LeaderLease{}).Where("name = ?", auditRetentionLeaseName).
		Updates(map[string]any{
			"holder":     "another-replica",
			"expires_at": time.Now().Add(time.Minute),
		}).Error; err != nil {
		t.Fatalf("把租约改写成别的副本持有: %v", err)
	}
	renewAuditLease("this-replica")
	if auditLeading.Load() {
		t.Error("租约被接管后不该继续认为自己是执行者")
	}
}

// 数据库抖动时**保持现状**，不主动放弃：放弃等于保留策略停摆（过期数据只涨不降），
// 而继续跑着的最坏情况只是与接管者重复巡检一次（删除本身是幂等的）。
func TestRenewAuditLeaseKeepsLeadingWhenDatabaseFails(t *testing.T) {
	db := setupRetentionTestDB(t)
	withAuditLeadership(t, true)

	// 让租约表消失：续约必然报错。
	if err := db.Migrator().DropTable(&model.LeaderLease{}); err != nil {
		t.Fatalf("删掉租约表: %v", err)
	}

	renewAuditLease("this-replica")
	if !auditLeading.Load() {
		t.Error("续约失败（库抖动）时不该放弃执行权")
	}
}
