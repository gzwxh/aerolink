package audit

import (
	"errors"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// 审计链路自监控指标的描述符，统一用 kite_ 前缀（与项目其它指标一致）。
//
// 这一组指标的作用是**把闭环合上**：日志系统自己坏了（丢记录、传不上去、写不进磁盘）必须能
// 从 /metrics 看出来，而不是等到真的需要查日志时才发现缺了一段。
// 见 docs/dev/plans/2026-09-20-log-closed-loop-design.md 第 ⑦ 环。
var (
	archiveWrittenDesc = prometheus.NewDesc(
		"kite_audit_archive_written_total",
		"Number of audit records successfully written into local parquet archive files.",
		[]string{"kind"}, nil,
	)
	archiveDroppedDesc = prometheus.NewDesc(
		"kite_audit_archive_dropped_total",
		"Number of audit records dropped because the parquet write buffer was full.",
		[]string{"kind"}, nil,
	)
	forwardDroppedDesc = prometheus.NewDesc(
		"kite_audit_forward_dropped_total",
		"Number of audit records dropped because a forwarding queue was full.",
		[]string{"sink"}, nil,
	)
	archiveFailuresDesc = prometheus.NewDesc(
		"kite_audit_archive_failures_total",
		"Number of failures while flushing, uploading, indexing or deleting audit archive records.",
		[]string{"stage"}, nil,
	)
	archivePendingDesc = prometheus.NewDesc(
		"kite_audit_archive_pending_files",
		"Number of local archive files seen by the last upload-retry scan (a growing value means uploads keep failing).",
		nil, nil,
	)
	archiveRetainedUnuploadedDesc = prometheus.NewDesc(
		"kite_audit_archive_retained_unuploaded_files",
		"Number of expired archive files kept by the last cleanup run because they are not uploaded yet (disk grows, but no data loss).",
		nil, nil,
	)
	// 队列指标的作用是**提前发现堵**：积压持续上涨、或背压开始增长，都说明下游（磁盘 / S3 /
	// ES）跟不上。这时记录还没丢，是扩容或排查的最佳时机，而不是等 dropped 指标动了才反应。
	archiveQueueDesc = prometheus.NewDesc(
		"kite_audit_archive_queue_depth",
		"Number of queued archive tasks waiting for a worker (disk = writing parquet files, upload = s3 uploads / es bulk writes).",
		[]string{"pool"}, nil,
	)
	archiveBackpressureDesc = prometheus.NewDesc(
		"kite_audit_archive_queue_backpressure_total",
		"Number of archive tasks run synchronously because the pool queue was full (a growing value means the downstream cannot keep up).",
		[]string{"pool"}, nil,
	)
)

// auditMetricsCollector 把各处已有的原子计数翻译成 Prometheus 指标。
//
// 用「读时汇总」的 Collector，而不是在写入路径上打点：热路径上只有原本就存在的原子加，
// 采集开销全部落在 Prometheus 抓取时。
type auditMetricsCollector struct{}

func (auditMetricsCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- archiveWrittenDesc
	ch <- archiveDroppedDesc
	ch <- forwardDroppedDesc
	ch <- archiveFailuresDesc
	ch <- archivePendingDesc
	ch <- archiveRetainedUnuploadedDesc
	ch <- archiveQueueDesc
	ch <- archiveBackpressureDesc
}

func (auditMetricsCollector) Collect(ch chan<- prometheus.Metric) {
	for kind, stats := range parquetStatsByKind() {
		ch <- prometheus.MustNewConstMetric(archiveWrittenDesc, prometheus.CounterValue, float64(stats.written), kind)
		ch <- prometheus.MustNewConstMetric(archiveDroppedDesc, prometheus.CounterValue, float64(stats.dropped), kind)
	}

	stdoutDropped, _ := StdoutStats()
	ch <- prometheus.MustNewConstMetric(forwardDroppedDesc, prometheus.CounterValue, float64(SyslogDroppedCount()), "syslog")
	ch <- prometheus.MustNewConstMetric(forwardDroppedDesc, prometheus.CounterValue, float64(stdoutDropped), "stdout")
	ch <- prometheus.MustNewConstMetric(forwardDroppedDesc, prometheus.CounterValue, float64(archiveDocDropped.Load()), auditSinkLabel())

	ch <- prometheus.MustNewConstMetric(archiveFailuresDesc, prometheus.CounterValue, float64(archiveFlushFailures.Load()), "flush")
	ch <- prometheus.MustNewConstMetric(archiveFailuresDesc, prometheus.CounterValue, float64(archiveUploadFailures.Load()), "upload")
	ch <- prometheus.MustNewConstMetric(archiveFailuresDesc, prometheus.CounterValue, float64(archiveDocWriteFailures.Load()), "write")
	ch <- prometheus.MustNewConstMetric(archiveFailuresDesc, prometheus.CounterValue, float64(archiveESPruneFailures.Load()), "index_delete")

	ch <- prometheus.MustNewConstMetric(archivePendingDesc, prometheus.GaugeValue, float64(archivePendingFiles.Load()))
	ch <- prometheus.MustNewConstMetric(archiveRetainedUnuploadedDesc, prometheus.GaugeValue, float64(archiveRetainedUnuploaded.Load()))

	for pool, queue := range archiveQueueStats() {
		ch <- prometheus.MustNewConstMetric(archiveQueueDesc, prometheus.GaugeValue, float64(queue.pending), pool)
		ch <- prometheus.MustNewConstMetric(archiveBackpressureDesc, prometheus.CounterValue, float64(queue.syncFallback), pool)
	}
}

// auditSinkLabel 返回 /metrics 上用于区分外部日志存储的标签值（没配就是 database）。
func auditSinkLabel() string {
	if model.AuditSink == "" {
		return model.AuditSinkDatabase
	}
	return model.AuditSink
}

// parquetQueueStats 是单个任务池的即时状态。
type parquetQueueStats struct {
	pending      int
	syncFallback int64
}

// archiveQueueStats 读取当前归档运行时两个任务池的状态（归档未启用时返回空）。
func archiveQueueStats() map[string]parquetQueueStats {
	archiveMu.RLock()
	runtime := archiveCurrent
	archiveMu.RUnlock()
	if runtime == nil {
		return nil
	}

	stats := make(map[string]parquetQueueStats, 2)
	collect := func(name string, dispatcher *archiveDispatcher) {
		if dispatcher == nil {
			return
		}
		pending, syncFallback := dispatcher.Stats()
		stats[name] = parquetQueueStats{pending: pending, syncFallback: syncFallback}
	}
	collect("disk", runtime.diskPool)
	collect("upload", runtime.uploadPool)
	return stats
}

// parquetStats 是单个 writer 的累计计数。
type parquetStats struct {
	dropped int64
	written int64
}

// parquetStatsByKind 读取当前归档运行时各 writer 的计数（归档未启用时返回空）。
func parquetStatsByKind() map[string]parquetStats {
	archiveMu.RLock()
	runtime := archiveCurrent
	archiveMu.RUnlock()
	if runtime == nil {
		return nil
	}

	stats := make(map[string]parquetStats, 4)
	collect := func(kind string, writer interface{ Stats() (int64, int64) }) {
		dropped, written := writer.Stats()
		stats[kind] = parquetStats{dropped: dropped, written: written}
	}
	if runtime.operation != nil {
		collect(string(KindAuditHistory), runtime.operation)
	}
	if runtime.login != nil {
		collect(string(KindLoginRecord), runtime.login)
	}
	if runtime.password != nil {
		collect(string(KindPasswordChangeLog), runtime.password)
	}
	if runtime.access != nil {
		collect(string(KindAccessLog), runtime.access)
	}
	return stats
}

// RegisterAuditMetrics 注册审计链路的自监控指标。
//
// 重复注册（例如测试里多次调用）会被静默忽略；其它注册错误记一行日志，不影响启动。
func RegisterAuditMetrics() {
	if err := prometheus.Register(auditMetricsCollector{}); err != nil {
		var alreadyRegistered prometheus.AlreadyRegisteredError
		if !errors.As(err, &alreadyRegistered) {
			klog.Errorf("failed to register audit metrics: %v", err)
		}
	}
}
