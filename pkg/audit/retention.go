package audit

import (
	"context"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// retentionInterval 是保留策略的检查间隔。按天保留的策略不需要更频繁的检查；
// 启动时会先跑一次，之后每天一次。
const retentionInterval = 24 * time.Hour

// retentionStartDelay 让启动检查稍晚一点执行，避免和集群同步、RBAC 初始化抢数据库。
const retentionStartDelay = 2 * time.Minute

// StartRetentionWorker 启动审计记录保留策略的后台任务（等保三级「安全审计」：
// 审计记录的存储与管理）。它随 ctx 退出，与其它后台任务一致。
//
// 只有**按时间自动滚动**这一种删除途径：没有任何接口可以手工删除单条或清空审计记录
// （见 main_test.go 的 TestAuditRoutesAreReadOnly）。保留天数由审计管理员在
// 「日志审计 → 审计设置」里配置，默认 0 = 永久保留（不配置就不会删）。
func StartRetentionWorker(ctx context.Context) {
	go runRetentionLoop(ctx, retentionStartDelay, retentionInterval)
}

// runRetentionLoop 是 worker 的循环本体，抽出来是为了能直接验证它随 ctx 退出。
func runRetentionLoop(ctx context.Context, startDelay, interval time.Duration) {
	// 首次延迟与后续间隔不同，所以用 Timer 手动 Reset，而不是固定周期的 Ticker。
	timer := time.NewTimer(startDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			PruneExpiredAuditRecords(time.Now())
			timer.Reset(interval)
		}
	}
}

// retentionDeleteBatch 是一次删除的行数上限。在 MySQL 上一条不带 LIMIT 的 DELETE 会
// 撑成一个大事务：undo/redo 膨胀、长时间持锁，还会挡住同时进行的审计写入。
const retentionDeleteBatch = 5000

// pruneBefore 分批删除 created_at 早于 cutoff 的记录，返回删除的总条数。
//
// 「先按时间取主键、再按主键删」而不是 `DELETE ... ORDER BY ... LIMIT`：后者在单表
// DELETE 上只有 MySQL 支持，SQLite / PostgreSQL 会直接报语法错误。
func pruneBefore(target interface{}, cutoff time.Time) (int64, error) {
	deleted := int64(0)
	for {
		var ids []uint
		if err := model.DB.Model(target).
			Where("created_at < ?", cutoff).
			Order("created_at").
			Limit(retentionDeleteBatch).
			Pluck("id", &ids).Error; err != nil {
			return deleted, err
		}
		if len(ids) == 0 {
			return deleted, nil
		}

		result := model.DB.Where("id IN ?", ids).Delete(target)
		if result.Error != nil {
			return deleted, result.Error
		}
		deleted += result.RowsAffected
		if result.RowsAffected == 0 {
			// 查得到却删不掉（权限或并发），不要在这里空转。
			return deleted, nil
		}
	}
}

// PruneExpiredAuditRecords 按保留策略清理过期的审计记录，返回删除的总条数。
//
// 导出的（可测）形式：worker 只是按固定间隔调用它。删除行为本身也会写一条审计记录，
// 使得「谁在什么策略下删了多少审计记录」永远可追溯。
func PruneExpiredAuditRecords(now time.Time) int64 {
	setting, err := model.GetAuditSetting()
	if err != nil {
		klog.Errorf("audit retention skipped: failed to load audit setting: %v", err)
		return 0
	}
	if setting.RetentionDays <= 0 {
		// 0 = 永久保留：默认行为，不做任何删除。
		return 0
	}

	cutoff := now.AddDate(0, 0, -setting.RetentionDays)
	deleted := int64(0)

	// 三张审计表一起滚动，否则「登录日志还在、操作日志没了」会让审计结论失真。
	targets := []struct {
		name  string
		model interface{}
	}{
		{"resource_histories", &model.ResourceHistory{}},
		{"login_records", &model.LoginRecord{}},
		{"password_change_logs", &model.PasswordChangeLog{}},
	}
	for _, target := range targets {
		pruned, err := pruneBefore(target.model, cutoff)
		if err != nil {
			klog.Errorf("audit retention failed to prune %s: %v", target.name, err)
			continue
		}
		deleted += pruned
	}

	if deleted == 0 {
		return 0
	}

	// 给删除动作本身留痕：这条记录本身也会在之后的轮次里按同样的策略过期。
	record := model.ResourceHistory{
		ResourceType:    "system/audit-retention",
		ResourceName:    cutoff.Format(time.RFC3339),
		OperationType:   "prune",
		OperationSource: "system",
		Success:         true,
	}
	if err := model.DB.Create(&record).Error; err != nil {
		klog.Errorf("audit retention could not record its own prune: %v", err)
	}
	klog.Infof("audit retention pruned %d record(s) older than %d days (before %s)",
		deleted, setting.RetentionDays, cutoff.Format(time.RFC3339))
	return deleted
}
