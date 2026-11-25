package audit

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
	"k8s.io/klog/v2"
)

// esBatchRows 是 ES 单次 bulk 的最大条数。
const esBatchRows = 2000

// archiveWriteTimeout 是单次远端写入（S3 上传 / ES bulk / 清理）的超时。
const archiveWriteTimeout = 60 * time.Second

// docBufferSize 是外部日志存储（ES / VictoriaLogs / OpenObserve）攒批队列的长度。
const docBufferSize = 8192

// 归档后处理的任务池规模（见 archive_dispatcher.go）。
//
// 写盘与上传分开配置：写盘是本地 IO，并发高了会互相抢磁盘，2 个够用；上传是网络 IO，多给
// 一个 worker 才能掩盖单次请求的延迟。队列按「一次 flush 一个任务」的量级给——正常远不会满，
// 真满了会走同步兜底（不丢任务，只是那一瞬间上游要等）。
const (
	archiveDiskWorkers   = 2
	archiveUploadWorkers = 3
	archiveQueueSize     = 256
)

var (
	archiveOnce       sync.Once
	archiveStarted    bool
	archiveParentCtx  context.Context
	archiveDefaultDir string

	archiveMu      sync.RWMutex
	archiveCurrent *archiveRuntime

	// —— 归档链路的自监控计数（见 docs/dev/plans/2026-09-20-日志闭环设计.md 第 ⑦ 环）——
	//
	// 日志系统自己坏了（丢记录、传不上去、写不进磁盘）必须能从 /metrics 看出来，而不是等到
	// 真的需要查日志时才发现缺了一段。这些计数在热路径上只做一次原子加，导出由
	// metrics.go 的读时汇总负责。
	archiveDocDropped       atomic.Int64 // 外部日志存储攒批队列满而丢弃的记录数
	archiveDocWriteFailures atomic.Int64 // 外部日志存储写入（bulk / 摄取）失败次数
	// archiveESPruneFailures 是删除过期 ES 按天索引的失败次数。它不会丢数据，但会让磁盘只涨
	// 不降——保留策略到底有没有生效，只看日志是不够的。
	archiveESPruneFailures atomic.Int64
	archiveFlushFailures   atomic.Int64 // parquet 落盘失败次数
	archiveUploadFailures  atomic.Int64 // 上传（含补传）失败次数
	archivePendingFiles    atomic.Int64 // 最近一次巡检发现的待补传文件数
	// archiveRetainedUnuploaded 是「到期但因尚未上传成功而被保留」的文件数：数据没丢，
	// 但磁盘在涨，需要运维介入（上传通道可能一直不通）。
	archiveRetainedUnuploaded atomic.Int64
)

// StartParquetArchiver 启动归档链（本地 parquet + 可选 S3，或一个外部日志存储）。
//
// 接线方式照抄 syslog：注册一个 model.AuditForwarder，落库后非阻塞投递。
// 归档是**尽力而为**的异介质副本，失败绝不影响本地落库，也不回压请求。
//
// 注意：归档运行时**每个副本都要建**。审计消息只在产生它的那个副本上投递（没有跨副本广播），
// 所以每个副本只能写自己的那一部分；只让一个副本写会把其它副本的记录静默丢掉（见 leader.go
// 开头那段说明）。多副本的正确性靠两件事保证：各副本写各自产生的记录（不重不漏），以及
// 共享归档目录时文件名带本进程标识（见 parquet.go 的 writeFile）。
//
// defaultDir 是配置未指定目录时的兜底（来自 AEROLINK_AUDIT_ARCHIVE_DIR）。
func StartParquetArchiver(ctx context.Context, defaultDir string) {
	archiveOnce.Do(func() {
		archiveParentCtx = ctx
		archiveDefaultDir = defaultDir
		archiveStarted = true
		model.AddAuditForwarder(forwardToParquet)
		reloadArchiveConfig()
		go runArchiveCleanupLoop(ctx, defaultArchiveCleanupInterval)
		// 上传失败的文件留在本地，由补传任务幂等地补齐（不依赖内存队列，重启后照常）。
		go runArchiveRetryLoop(ctx, archiveRetryInterval)
	})
}

// forwardToParquet 把一条审计记录投递给当前归档运行时。非阻塞。
func forwardToParquet(message model.AuditMessage) {
	archiveMu.RLock()
	runtime := archiveCurrent
	archiveMu.RUnlock()
	if runtime == nil {
		return
	}
	runtime.append(message)
}

// reloadArchiveConfig 按当前 sink 与最新配置（重）建归档运行时：sink=database 时**不建任何通道**，
// parquet / elasticsearch / victorialogs / openobserve 各自只建自己那一条（五者互斥，见方案 §12.13）。
// 由 applyAuditSettingChanges（保存设置 / 启动 / 多副本收敛轮询）统一调用。
func reloadArchiveConfig() {
	setting, err := model.GetAuditSetting()
	if err != nil {
		klog.Errorf("archive disabled: failed to load audit setting: %v", err)
		return
	}
	// 输出格式与归档开关无关：即使归档整体关闭，访问日志的 text/json 也要生效。
	SetAccessLogFormat(setting.Archive.AccessLog.Format)

	archiveMu.Lock()
	defer archiveMu.Unlock()

	if archiveCurrent != nil {
		archiveCurrent.stop()
		archiveCurrent = nil
	}
	// sink=database：审计仍落库（权威），归档是**可选冷归档副本**——仅当管理员显式开启
	// Archive.Enabled 时才建 parquet(+S3/COS) 运行时；否则维持现状（不建）。非 database 的
	// 四种 sink 仍互斥，由 newArchiveRuntime 按 sink 建各自的主存储通道。
	if model.AuditSinkUsesDatabase() && !setting.Archive.Enabled {
		return
	}
	if !archiveStarted {
		// 归档器还没启动（配置读取早于 StartParquetArchiver）：不在这里启动，
		// 启动时选主成功的那次 reload 会按这份配置建好运行时。
		return
	}

	runtime, err := newArchiveRuntime(archiveParentCtx, setting.Archive, archiveDefaultDir)
	if err != nil {
		klog.Errorf("failed to start audit archiver: %v", err)
		return
	}
	archiveCurrent = runtime
	klog.Infof("audit archiver started: sink=%s dir=%s s3=%v external_store=%v",
		model.AuditSink, runtime.dir, runtime.s3 != nil, runtime.docSink != nil)
}

// archiveRuntime 是当前生效的归档实例集合（最多 4 个 parquet writer + 可选 S3/外部日志存储）。
type archiveRuntime struct {
	dir string

	operation *ParquetWriter[operationLogRow]
	login     *ParquetWriter[loginRecordRow]
	password  *ParquetWriter[passwordChangeLogRow]
	access    *ParquetWriter[accessLogRow]

	s3 *S3Sink
	// docSink 是外部日志存储（ES / VictoriaLogs / OpenObserve）：由 sink 决定用哪一个，
	// nil 表示当前 sink 不用外部日志存储（database 只落库、parquet 只写文件）。
	docSink documentSink

	// diskPool 负责把攒好的批写成 parquet 文件，uploadPool 负责落盘后的 S3 上传与外部日志存储写入。
	// 拆成两个池是为了让网络 IO 不阻塞写盘（见 archive_dispatcher.go）。
	diskPool   *archiveDispatcher
	uploadPool *archiveDispatcher

	// docBuf 是投递给 docSink 的攒批队列：攒批与网络写入解耦，队列满则丢弃并计数（绝不阻塞请求）。
	docBuf chan model.AuditMessage

	retention     int
	maxBytes      int64
	accessRetain  int
	accessMaxByte int64
	// flushInterval 是 ES 攒批的刷写间隔，跟随归档 flush 配置（与 parquet 同源），
	// 否则调短间隔验证时要等固定的默认值。
	flushInterval time.Duration
	// includeYAML 决定操作日志归档是否带上变更前后的资源清单（默认关）。
	includeYAML bool

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func newArchiveRuntime(parent context.Context, archive model.ArchiveSetting, defaultDir string) (*archiveRuntime, error) {
	dir := archive.LocalDir
	if dir == "" {
		dir = defaultDir
	}
	// 内存直传（本地不落盘）不需要本地目录；其余路径必须要有落点，否则 fail-closed 拒绝启动。
	directUpload := archive.S3.Enabled && archive.S3.DirectUpload
	if dir == "" && !directUpload {
		return nil, errors.New("archive directory is not configured (set localDir or AEROLINK_AUDIT_ARCHIVE_DIR)")
	}
	if dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("failed to create archive directory %s: %w", dir, err)
		}
	}

	ctx, cancel := context.WithCancel(parent)
	flushInterval := time.Duration(archive.Flush.IntervalSeconds) * time.Second
	if flushInterval <= 0 {
		flushInterval = time.Duration(model.DefaultArchiveFlushInterval) * time.Second
	}
	runtime := &archiveRuntime{
		dir:           dir,
		retention:     archive.RetentionDays,
		maxBytes:      archive.MaxBytes,
		accessRetain:  archive.AccessLog.RetentionDays,
		accessMaxByte: archive.AccessLog.MaxBytes,
		flushInterval: flushInterval,
		// database 冷归档强制带上资源 YAML：等保溯源要留变更前后清单（主存储里已有，冷归档
		// 副本同样保留）；非 database 仍由 archive.IncludeResourceYAML 决定。
		includeYAML: archive.IncludeResourceYAML || model.AuditSinkUsesDatabase(),
		cancel:      cancel,
	}

	// 通道由 sink **唯一**决定（五选一互斥，见方案 §12.13 与 plans/2026-09-21-新增审计落地方式.md）：
	//   parquet                → 本地 parquet 文件（+ 可选 S3 远端副本）；
	//   elasticsearch          → 只写 ES（自己管按天索引与过期删除）；
	//   victorialogs           → 只写 VictoriaLogs（单流，服务端分区 + 服务端保留）；
	//   openobserve            → 只写 OpenObserve（同上）。
	// database 走不到这里（reloadArchiveConfig 已提前返回）。
	var useParquet bool
	var newDocSink func() (documentSink, error)
	switch model.AuditSink {
	case model.AuditSinkParquet:
		useParquet = true
	case model.AuditSinkDatabase:
		// 冷归档：database 是主存储（已落库），这里只做 parquet 冷副本 + 可选 S3/COS，不建 docSink。
		useParquet = true
	case model.AuditSinkElasticsearch:
		// ES 通道由 sink 决定：不依赖那个由 sink 推导的开关，升级前存下的 enabled=false 也照样生效。
		config := archive.Elasticsearch
		config.Enabled = true
		newDocSink = func() (documentSink, error) { return NewESSink(config) }
	case model.AuditSinkVictoriaLogs:
		config := archive.VictoriaLogs
		config.Enabled = true
		newDocSink = func() (documentSink, error) { return NewVictoriaLogsSink(config) }
	case model.AuditSinkOpenObserve:
		config := archive.OpenObserve
		config.Enabled = true
		newDocSink = func() (documentSink, error) { return NewOpenObserveSink(config) }
	default:
		cancel()
		return nil, fmt.Errorf("audit sink %q keeps records in the database only: no archive runtime is needed", model.AuditSink)
	}

	if useParquet {
		runtime.operation = NewParquetWriter[operationLogRow](dir, KindAuditHistory, archive.Flush)
		runtime.login = NewParquetWriter[loginRecordRow](dir, KindLoginRecord, archive.Flush)
		runtime.password = NewParquetWriter[passwordChangeLogRow](dir, KindPasswordChangeLog, archive.Flush)
		if archive.AccessLog.Enabled {
			runtime.access = NewParquetWriter[accessLogRow](dir, KindAccessLog, archive.AccessLog.Flush)
		}
	}

	// 写盘与上传各一个任务池：写入循环只负责攒批与投递，不再被网络 IO 拖住。
	runtime.diskPool = newArchiveDispatcher("disk", archiveDiskWorkers, archiveQueueSize)
	runtime.uploadPool = newArchiveDispatcher("upload", archiveUploadWorkers, archiveQueueSize)
	for _, writer := range runtime.writers() {
		writer.SetDispatchers(runtime.diskPool, runtime.uploadPool)
	}

	// S3 是 parquet 的远端副本：没有 parquet 通道就没有可同步的文件。
	if useParquet && archive.S3.Enabled {
		sink, err := NewS3Sink(archive.S3)
		if err != nil {
			runtime.stopDispatchers()
			cancel()
			return nil, err
		}
		runtime.s3 = sink
		if archive.S3.DirectUpload {
			// 内存直传：本地不落盘，攒批在内存里编码后直接上传对象存储。
			hook := s3MemoryUploadHook(sink)
			for _, writer := range runtime.writers() {
				writer.SetMemoryUpload(hook)
			}
		} else {
			hook := s3FlushHook(dir, sink)
			for _, writer := range runtime.writers() {
				writer.AddFlushHook(hook)
			}
		}
	}

	if newDocSink != nil {
		sink, err := newDocSink()
		if err != nil {
			runtime.stopDispatchers()
			cancel()
			return nil, err
		}
		runtime.docSink = sink
		runtime.docBuf = make(chan model.AuditMessage, docBufferSize)
		runtime.wg.Add(1)
		go func() {
			defer runtime.wg.Done()
			runtime.runDocWriter(ctx)
		}()
	}

	for _, run := range runtime.runs() {
		runtime.wg.Add(1)
		go func(run func(context.Context)) {
			defer runtime.wg.Done()
			run(ctx)
		}(run)
	}
	return runtime, nil
}

// writers 返回非空 writer 的「加钩子」视图。
//
// 注意这里**逐个判空后再装箱**，而不是先把它们塞进 []flushHookTarget 再筛选：
// 后者是 Go 的经典陷阱——把 *ParquetWriter[T] 的 nil 指针装进接口，接口本身并不为 nil，
// `target != nil` 判定为真，于是对 nil 调方法直接 panic（sink=parquet/es 时某类 writer
// 本来就可能不创建，这条路径会被立刻踩到）。
func (r *archiveRuntime) writers() []flushHookTarget {
	targets := make([]flushHookTarget, 0, 4)
	if r.operation != nil {
		targets = append(targets, r.operation)
	}
	if r.login != nil {
		targets = append(targets, r.login)
	}
	if r.password != nil {
		targets = append(targets, r.password)
	}
	if r.access != nil {
		targets = append(targets, r.access)
	}
	return targets
}

// runs 返回非空 writer 的 Run 方法视图。
func (r *archiveRuntime) runs() []func(context.Context) {
	runs := make([]func(context.Context), 0, 4)
	if r.operation != nil {
		runs = append(runs, r.operation.Run)
	}
	if r.login != nil {
		runs = append(runs, r.login.Run)
	}
	if r.password != nil {
		runs = append(runs, r.password.Run)
	}
	if r.access != nil {
		runs = append(runs, r.access.Run)
	}
	return runs
}

// flushHookTarget 抽象出「可以挂 flush 钩子、可以注入任务池」的行为，
// 避免在泛型 writer 上写类型分支。
type flushHookTarget interface {
	AddFlushHook(FlushHook)
	SetMemoryUpload(memoryUploadHook)
	SetDispatchers(disk, upload *archiveDispatcher)
}

// append 按分类把记录投递给对应 writer（以及 ES 攒批队列）。全部非阻塞。
func (r *archiveRuntime) append(message model.AuditMessage) {
	switch message.Kind {
	case model.AuditKindOperation:
		r.operation.Append(operationLogRowFromMessage(message, r.includeYAML))
	case model.AuditKindLogin:
		r.login.Append(loginRecordRowFromMessage(message))
	case model.AuditKindPasswordChange:
		r.password.Append(passwordChangeLogRowFromMessage(message))
	case model.AuditKindAccess:
		if r.access != nil {
			r.access.Append(accessLogRowFromMessage(message))
		}
	}

	if r.docBuf != nil && message.Kind != "" {
		select {
		case r.docBuf <- message:
		default:
			// 队列满：丢弃，不阻塞请求（与 parquet/syslog 同一策略）。但**必须计数**：丢记录是
			// 「日志链路自己坏了」的头号信号，只打一行 Warning 会淹没在海量日志里，而 /metrics 上的
			// aerolink_audit_forward_dropped_total{sink=...} 一眼可见。
			dropped := archiveDocDropped.Add(1)
			if dropped%100 == 1 {
				klog.Warningf("%s archive queue is full, dropped %d record(s)", model.AuditSink, dropped)
			}
		}
	}
}

// stop 优雅停止：先关缓冲让 Run 落盘剩余记录，再按序停掉两个任务池，最后取消 context。
// 必须在持有 archiveMu 写锁时调用；Run 协程与池的 worker 都不获取该锁，所以不会死锁。
func (r *archiveRuntime) stop() {
	if r.operation != nil {
		r.operation.Close()
	}
	if r.login != nil {
		r.login.Close()
	}
	if r.password != nil {
		r.password.Close()
	}
	if r.access != nil {
		r.access.Close()
	}
	if r.docBuf != nil {
		close(r.docBuf)
	}
	// 先等 writer 与 ES 攒批协程退出：它们的退出路径会把剩余记录落盘、把最后的 bulk 入队。
	r.wg.Wait()
	r.stopDispatchers()
	r.cancel()
}

// stopDispatchers 按「先写盘、后上传」的顺序停池。
//
// 顺序不能反：上传任务是写盘 worker 在落盘成功后投递的，先停上传池会让随后投递的任务被
// Submit 判定为「池已停止」而退化成同步执行——等于又回到「网络 IO 卡住写盘」的老问题。
func (r *archiveRuntime) stopDispatchers() {
	r.diskPool.Stop()
	r.uploadPool.Stop()
}

// runDocWriter 是外部日志存储（ES / VictoriaLogs / OpenObserve）的攒批写入循环。
func (r *archiveRuntime) runDocWriter(ctx context.Context) {
	if r.docBuf == nil {
		return
	}
	interval := r.flushInterval
	if interval <= 0 {
		interval = time.Duration(model.DefaultArchiveFlushInterval) * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	batch := make([]ESDocument, 0, esBatchRows)
	flush := func() {
		if len(batch) == 0 || r.docSink == nil {
			return
		}
		// 与 parquet 写盘同理：交给上传池之后这一批就归 worker 所有，必须重新分配。
		docs := batch
		batch = make([]ESDocument, 0, esBatchRows)

		index := func() {
			// 用独立 context：退出路径上的最后一次写入不应因父 context 取消而失败。
			writeCtx, cancel := context.WithTimeout(context.Background(), archiveWriteTimeout)
			defer cancel()
			if err := r.docSink.Write(writeCtx, docs); err != nil {
				archiveDocWriteFailures.Add(1)
				klog.Warningf("failed to write %d audit document(s) into %s: %v", len(docs), model.AuditSink, err)
			}
		}

		// 写入是网络 IO：交给上传池，攒批协程立刻回去消费队列，否则一次慢写入就会让
		// docBuf（8192）积压到丢弃记录。
		if r.uploadPool != nil {
			r.uploadPool.Submit(index)
			return
		}
		index()
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case <-ticker.C:
			flush()
		case message, ok := <-r.docBuf:
			if !ok {
				flush()
				return
			}
			batch = append(batch, esDocumentFromMessage(message))
			if len(batch) >= esBatchRows {
				flush()
			}
		}
	}
}

// s3MemoryUploadHook 返回「内存直传」的上传回调：把内存里的 parquet 字节直接上传对象存储，
// 不经过本地文件。object key 用相对名（`<kind>/<年>/<月>/<日>/<file>.parquet`）。
func s3MemoryUploadHook(sink *S3Sink) memoryUploadHook {
	return func(name string, data []byte) error {
		uploadCtx, cancel := context.WithTimeout(context.Background(), archiveWriteTimeout)
		defer cancel()
		return sink.UploadBytes(uploadCtx, name, data)
	}
}

// s3FlushHook 返回「文件落盘后上传到 S3，并按配置删除本地」的钩子。
func s3FlushHook(archiveDir string, sink *S3Sink) FlushHook {
	return func(path string) error {
		rel, err := filepath.Rel(archiveDir, path)
		if err != nil {
			return fmt.Errorf("failed to compute object key for %s: %w", path, err)
		}
		// object key 始终用 `/` 分隔，不跟随宿主 OS。
		name := filepath.ToSlash(rel)

		uploadCtx, cancel := context.WithTimeout(context.Background(), archiveWriteTimeout)
		defer cancel()
		if err := sink.Upload(uploadCtx, name, path); err != nil {
			return err
		}
		if !sink.DeleteLocalAfterUpload() {
			// 本地要保留一份：落「已上传」标记，本地清理才知道这份在 S3 有副本、可以删。
			// 标记写不上不算上传失败（对象已经在 S3 上），只是清理会更保守。
			if err := markUploaded(path); err != nil {
				klog.Warningf("uploaded %s but failed to write the upload marker: %v", name, err)
			}
			return nil
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			// 上传已经成功，删本地失败只影响磁盘占用，下次清理会兜底。
			return fmt.Errorf("uploaded %s but failed to remove the local file: %w", name, err)
		}
		removeUploadMarker(path)
		return nil
	}
}

// esDocumentFromMessage 把审计消息映射成 ES 文档（字段名与 §5 schema 一致）。
func esDocumentFromMessage(message model.AuditMessage) ESDocument {
	doc := ESDocument{At: message.At}
	fields := map[string]any{"id": message.ID}

	switch message.Kind {
	case model.AuditKindOperation:
		doc.Kind = ESKindAuditHistory
		fields[esFieldCreatedAt] = message.At.Format(time.RFC3339)
		fields[esFieldClusterName] = message.ClusterName
		fields[esFieldResourceType] = message.ResourceType
		fields[esFieldResourceName] = message.ResourceName
		fields[esFieldNamespace] = message.Namespace
		fields[esFieldOperationType] = message.OperationType
		fields["operation_source"] = message.OperationSource
		fields["success"] = message.Success
		fields["error_message"] = message.ErrorMessage
		fields[esFieldClientIP] = message.ClientIP
		fields["user_agent"] = message.UserAgent
		fields["operator_id"] = message.OperatorID
		fields[esFieldOperatorName] = message.OperatorName
	case model.AuditKindLogin:
		doc.Kind = ESKindLoginRecord
		fields[esFieldCreatedAt] = message.At.Format(time.RFC3339)
		fields["user_id"] = message.UserID
		fields[esFieldUsername] = message.Username
		fields[esFieldProvider] = message.Provider
		fields["ip"] = message.ClientIP
		fields["user_agent"] = message.UserAgent
		fields[esFieldResult] = message.Result
	case model.AuditKindPasswordChange:
		doc.Kind = ESKindPasswordChangeLog
		fields[esFieldCreatedAt] = message.At.Format(time.RFC3339)
		fields["user_id"] = message.UserID
		fields[esFieldUsername] = message.Username
		fields["operator_id"] = message.OperatorID
		fields["operator"] = message.Operator
		fields["source"] = message.Source
	case model.AuditKindAccess:
		doc.Kind = ESKindAccessLog
		fields[esFieldTimestamp] = message.At.Format(time.RFC3339)
		fields[esFieldClientIP] = message.ClientIP
		fields[esFieldMethod] = message.Method
		fields[esFieldPath] = message.Path
		fields[esFieldStatusCode] = message.StatusCode
		fields["latency_ms"] = message.LatencyMs
		fields["cluster"] = message.ClusterName
		fields["user"] = message.Username
	}

	if message.ID > 0 {
		doc.ID = strconv.FormatUint(uint64(message.ID), 10)
	}
	// 请求关联 ID 对四类记录都适用（访问日志也有），统一在这里注入，避免各分支重复。
	if message.RequestID != "" {
		fields["request_id"] = message.RequestID
	}
	doc.Fields = fields
	return doc
}
