package audit

import (
	"context"
	"strings"
	"time"

	"aerolink/pkg/model"
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
//
// 多副本下巡检只由主副本执行（见 leader.go）：它是**全局**操作（删共享库里的过期行 + 删共享
// ES 的过期索引 + 自己写一条「prune」留痕），N 个副本同时跑只会互相抢同一批行，并各自留下一
// 条重复的留痕记录。
func StartRetentionWorker(ctx context.Context) {
	go runAuditLeaseLoop(ctx)
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
			if auditLeading.Load() {
				PruneExpiredAuditRecords(time.Now())
			}
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

// PruneExpiredAuditRecords 按保留策略清理过期的审计记录，返回删除的总条数（数据库行数）。
//
// 导出的（可测）形式：worker 只是按固定间隔调用它。删除行为本身也会写一条审计记录，
// 使得「谁在什么策略下删了多少审计记录」永远可追溯。
//
// 删除分工（五种 sink 各自不同，见 plans/2026-09-21-新增审计落地方式.md §3.4）：
//   - database      ：下面的库表删除就是全部（sink=其他时这些表本来就是空的，是空转）；
//   - elasticsearch ：除库表外还删过期的按天索引（pruneExpiredESIndices）；
//   - parquet       ：文件滚留自己管（archive.RetentionDays / MaxBytes），不在这里删；
//   - victorialogs  ：**服务端** -retentionPeriod 负责，客户端根本无删除接口可调；
//   - openobserve   ：**服务端** stream 的 data_retention 负责，同上。
//
// 后两种的保留天数不由本进程决定，界面上必须明说，否则就是「配了没生效」的静默失效。
func PruneExpiredAuditRecords(now time.Time) int64 {
	setting, err := model.GetAuditSetting()
	if err != nil {
		klog.Errorf("audit retention skipped: failed to load audit setting: %v", err)
		return 0
	}
	if setting.RetentionDays <= 0 {
		// 0 = 永久保留：默认行为，不做任何删除（ES 也同样不动）。
		return 0
	}

	cutoff := now.AddDate(0, 0, -setting.RetentionDays)
	deleted := pruneAuditTables(cutoff)
	// 与库里的删除互不影响：ES 不可达只记日志与指标，不会让库里的清理半途而废。
	pruneExpiredESIndices(setting, now)

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
	// 后台任务没有请求上下文：传 context.TODO()（而不是 nil）——语义一样（这条链路上都拿不到
	// request_id、也都退回默认数据库会话），但 staticcheck 的 SA1012 会拦下 nil。
	if err := model.RecordAudit(context.TODO(), &record); err != nil {
		klog.Errorf("audit retention could not record its own prune: %v", err)
	}
	klog.Infof("audit retention pruned %d record(s) older than %d days (before %s)",
		deleted, setting.RetentionDays, cutoff.Format(time.RFC3339))
	return deleted
}

// pruneAuditTables 清理三张审计表里 created_at 早于 cutoff 的记录，返回删除的总条数。
func pruneAuditTables(cutoff time.Time) int64 {
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
	return deleted
}

// esIndexRetentionDays 返回 ES 按天索引的保留天数：审计与访问日志保留期的**较大值**。
func esIndexRetentionDays(setting *model.AuditSettingData) int {
	days := setting.RetentionDays
	if access := setting.Archive.AccessLog.RetentionDays; access > days {
		days = access
	}
	return days
}

// pruneExpiredESIndices 删除 Elasticsearch 里过期的按天索引。
//
// 只在 sink=elasticsearch 时执行（五者互斥：ES 以外的 sink 不往 ES 写任何东西，也就没有 ES 索引要清）。
// 保留天数取「审计保留天数」与「访问日志保留天数」的**较大值**：四类记录共用按天索引
// （见 esDocumentFromMessage），删除粒度只能是整天，取较大值可以保证不会把还在各自保留期内的
// 记录先删掉——多留几天只占磁盘，早删就是真丢了。
//
// 注意 VictoriaLogs / OpenObserve **没有**对应动作：它们不按天建索引/流（单流 + 服务端分区），
// 也没有删除过期数据的客户端接口，保留完全由服务端配置决定。不要为它们在这里加删除逻辑。
func pruneExpiredESIndices(setting *model.AuditSettingData, now time.Time) {
	if !model.AuditSinkUsesElasticsearch() {
		return
	}

	esConfig := setting.Archive.Elasticsearch
	// ES 通道由 sink 决定：不依赖那个由 sink 推导的开关，升级前存下的 enabled=false 也照样生效。
	esConfig.Enabled = true
	sink, err := NewESSink(esConfig)
	if err != nil {
		klog.Errorf("audit retention skipped the elasticsearch indexes: %v", err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), archiveWriteTimeout)
	defer cancel()

	deleted, err := sink.DeleteIndicesBefore(ctx, now.AddDate(0, 0, -esIndexRetentionDays(setting)))
	if len(deleted) > 0 {
		klog.Infof("audit retention deleted %d expired elasticsearch index(es): %s",
			len(deleted), strings.Join(deleted, ", "))
	}
	if err != nil {
		archiveESPruneFailures.Add(1)
		klog.Errorf("audit retention failed to delete expired elasticsearch index(es): %v", err)
	}
}
