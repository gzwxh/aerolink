package audit

import (
	"bytes"
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"aerolink/pkg/model"
	"github.com/parquet-go/parquet-go"
	"k8s.io/klog/v2"
)

// ParquetKind 是归档文件的类型，决定目录名与文件名前缀（见方案 §5/§7）。
type ParquetKind string

const (
	// KindAuditHistory 操作日志。
	KindAuditHistory ParquetKind = "audit_history"
	// KindLoginRecord 登录日志。
	KindLoginRecord ParquetKind = "login_record"
	// KindPasswordChangeLog 改密日志。
	KindPasswordChangeLog ParquetKind = "password_change_log"
	// KindAccessLog 访问日志。
	KindAccessLog ParquetKind = "access_log"
)

// parquetBufferSize 是每个 writer 的内存缓冲上限。与 syslog 队列同理：写盘/上传全在
// 后台 goroutine，缓冲满时丢弃并计数，绝不在请求路径上阻塞或回压。
const parquetBufferSize = 4096

// ParquetKindFor 把审计消息分类映射到归档文件类型。第二个返回值表示是否为已知分类。
func ParquetKindFor(kind string) (ParquetKind, bool) {
	switch kind {
	case model.AuditKindOperation:
		return KindAuditHistory, true
	case model.AuditKindLogin:
		return KindLoginRecord, true
	case model.AuditKindPasswordChange:
		return KindPasswordChangeLog, true
	case model.AuditKindAccess:
		return KindAccessLog, true
	default:
		return "", false
	}
}

// parquetRow 是能写进 parquet 的一行。
//
// rowBytes 用于「字节数到即 flush」的阈值判断：近似值即可，它的目的是限制单文件
// 大小，不要求精确。
type parquetRow interface {
	rowBytes() int
}

// —— 行结构（字段集与方案 §5 的 schema 一致）——

type operationLogRow struct {
	ID              uint64 `parquet:"id"`
	CreatedAt       int64  `parquet:"created_at"`
	ClusterName     string `parquet:"cluster_name"`
	ResourceType    string `parquet:"resource_type"`
	ResourceName    string `parquet:"resource_name"`
	Namespace       string `parquet:"namespace"`
	OperationType   string `parquet:"operation_type"`
	OperationSource string `parquet:"operation_source"`
	Success         bool   `parquet:"success"`
	ErrorMessage    string `parquet:"error_message"`
	ClientIP        string `parquet:"client_ip"`
	UserAgent       string `parquet:"user_agent"`
	OperatorID      uint64 `parquet:"operator_id"`
	OperatorName    string `parquet:"operator_name"`
	// 变更前后的资源清单：默认留空（见 ArchiveSetting.IncludeResourceYAML），
	// 需要溯源时才写入。空列在 parquet 里几乎不占空间。
	ResourceYAML string `parquet:"resource_yaml"`
	PreviousYAML string `parquet:"previous_yaml"`
}

func (r operationLogRow) rowBytes() int {
	return 64 + len(r.ClusterName) + len(r.ResourceType) + len(r.ResourceName) +
		len(r.Namespace) + len(r.OperationType) + len(r.OperationSource) +
		len(r.ErrorMessage) + len(r.ClientIP) + len(r.UserAgent) + len(r.OperatorName) +
		len(r.ResourceYAML) + len(r.PreviousYAML)
}

type loginRecordRow struct {
	ID        uint64 `parquet:"id"`
	CreatedAt int64  `parquet:"created_at"`
	UserID    uint64 `parquet:"user_id"`
	Username  string `parquet:"username"`
	Provider  string `parquet:"provider"`
	IP        string `parquet:"ip"`
	UserAgent string `parquet:"user_agent"`
	Result    string `parquet:"result"`
}

func (r loginRecordRow) rowBytes() int {
	return 48 + len(r.Username) + len(r.Provider) + len(r.IP) + len(r.UserAgent) + len(r.Result)
}

type passwordChangeLogRow struct {
	ID         uint64 `parquet:"id"`
	CreatedAt  int64  `parquet:"created_at"`
	UserID     uint64 `parquet:"user_id"`
	Username   string `parquet:"username"`
	OperatorID uint64 `parquet:"operator_id"`
	Operator   string `parquet:"operator"`
	Source     string `parquet:"source"`
}

func (r passwordChangeLogRow) rowBytes() int {
	return 48 + len(r.Username) + len(r.Operator) + len(r.Source)
}

type accessLogRow struct {
	TS         int64  `parquet:"ts"`
	ClientIP   string `parquet:"client_ip"`
	Method     string `parquet:"method"`
	Path       string `parquet:"path"`
	StatusCode int32  `parquet:"status_code"`
	LatencyMs  int64  `parquet:"latency_ms"`
	Cluster    string `parquet:"cluster"`
	User       string `parquet:"user"`
}

func (r accessLogRow) rowBytes() int {
	return 40 + len(r.ClientIP) + len(r.Method) + len(r.Path) + len(r.Cluster) + len(r.User)
}

// —— AuditMessage → 行 ——

// operationLogRowFromMessage 把审计消息转成 parquet 行。
// includeYAML 为假时资源清单留空——默认不归档大字段。
func operationLogRowFromMessage(m model.AuditMessage, includeYAML bool) operationLogRow {
	row := operationLogRow{
		ID:              uint64(m.ID),
		CreatedAt:       m.At.UnixMilli(),
		ClusterName:     m.ClusterName,
		ResourceType:    m.ResourceType,
		ResourceName:    m.ResourceName,
		Namespace:       m.Namespace,
		OperationType:   m.OperationType,
		OperationSource: m.OperationSource,
		Success:         m.Success,
		ErrorMessage:    m.ErrorMessage,
		ClientIP:        m.ClientIP,
		UserAgent:       m.UserAgent,
		OperatorID:      uint64(m.OperatorID),
		OperatorName:    m.OperatorName,
	}
	if includeYAML {
		row.ResourceYAML = m.ResourceYAML
		row.PreviousYAML = m.PreviousYAML
	}
	return row
}

func loginRecordRowFromMessage(m model.AuditMessage) loginRecordRow {
	return loginRecordRow{
		ID:        uint64(m.ID),
		CreatedAt: m.At.UnixMilli(),
		UserID:    uint64(m.UserID),
		Username:  m.Username,
		Provider:  m.Provider,
		IP:        m.ClientIP,
		UserAgent: m.UserAgent,
		Result:    m.Result,
	}
}

func passwordChangeLogRowFromMessage(m model.AuditMessage) passwordChangeLogRow {
	return passwordChangeLogRow{
		ID:         uint64(m.ID),
		CreatedAt:  m.At.UnixMilli(),
		UserID:     uint64(m.UserID),
		Username:   m.Username,
		OperatorID: uint64(m.OperatorID),
		Operator:   m.Operator,
		Source:     m.Source,
	}
}

func accessLogRowFromMessage(m model.AuditMessage) accessLogRow {
	return accessLogRow{
		TS:         m.At.UnixMilli(),
		ClientIP:   m.ClientIP,
		Method:     m.Method,
		Path:       m.Path,
		StatusCode: int32(m.StatusCode),
		LatencyMs:  m.LatencyMs,
		Cluster:    m.ClusterName,
		User:       m.Username,
	}
}

// FlushHook 在文件落盘（原子 rename 完成）后被调用，供 S3 上传等后续环节挂载。
// 返回错误只记日志：归档失败绝不回压写入路径。
type FlushHook func(path string) error

// memoryUploadHook 在「内存直传」模式下被调用：参数是相对 object key 与编码好的 parquet 字节，
// 不再经过本地文件。返回错误只记日志（没有本地副本可补传，见 S3Archive.DirectUpload 的注释）。
type memoryUploadHook func(name string, data []byte) error

// ParquetWriter 是一个攒批写 parquet 的后台 writer。
//
// 生命周期：NewParquetWriter → go Run(ctx) → Close()。Append 只做内存投递；
// 时间 / 条数 / 字节任一阈值到达即落一个不可变文件（先写 .tmp 再原子 rename）。
type ParquetWriter[T parquetRow] struct {
	kind  ParquetKind
	dir   string
	flush model.FlushSetting

	buffer      chan T
	flushSignal chan struct{}

	hooksMu sync.RWMutex
	hooks   []FlushHook

	// memoryUpload 非 nil 时走「内存直传」：攒批编码进内存后直接交给它上传，不落本地文件。
	// 与文件模式（AddFlushHook + 本地文件）互斥——内存模式下没有本地文件，也就没有基于
	// 文件路径的 flush hook 可触发。
	memoryUpload memoryUploadHook

	// diskPool / uploadPool 见 archive_dispatcher.go：把「写盘」与「落盘后上传」从 Run 协程
	// 里摘出去。为空表示在 Run 协程里同步执行——单测直接构造 writer 时走这条路。
	diskPool   *archiveDispatcher
	uploadPool *archiveDispatcher

	seq     atomic.Uint64
	dropped atomic.Int64
	written atomic.Int64
	closed  atomic.Bool
}

// NewParquetWriter 创建写入 `<archiveDir>/<kind>` 的 writer。
func NewParquetWriter[T parquetRow](archiveDir string, kind ParquetKind, flush model.FlushSetting) *ParquetWriter[T] {
	if flush.IntervalSeconds <= 0 {
		flush.IntervalSeconds = model.DefaultArchiveFlushInterval
	}
	if flush.MaxBatchRows <= 0 {
		flush.MaxBatchRows = model.DefaultAuditArchiveFlushRows
	}
	return &ParquetWriter[T]{
		kind:        kind,
		dir:         filepath.Join(archiveDir, string(kind)),
		flush:       flush,
		buffer:      make(chan T, parquetBufferSize),
		flushSignal: make(chan struct{}, 1),
	}
}

// Kind 返回该 writer 的归档类型。
func (w *ParquetWriter[T]) Kind() ParquetKind { return w.kind }

// AddFlushHook 注册一个文件落盘后的回调（如 S3 上传）。
func (w *ParquetWriter[T]) AddFlushHook(hook FlushHook) {
	if w == nil || hook == nil {
		return
	}
	w.hooksMu.Lock()
	defer w.hooksMu.Unlock()
	w.hooks = append(w.hooks, hook)
}

// SetMemoryUpload 打开「内存直传」模式：落盘动作改为在内存编码 parquet 后回调 memoryUpload。
// 与文件模式（AddFlushHook + 本地文件）互斥，只在不需要本地中转的部署里使用。
func (w *ParquetWriter[T]) SetMemoryUpload(hook memoryUploadHook) {
	if w == nil || hook == nil {
		return
	}
	w.memoryUpload = hook
}

// SetDispatchers 注入写盘池与上传池（必须在 Run 之前调用）。
//
// 分成两个池而不是一个：写盘是本地 IO、并发太高反而互相抢磁盘；上传是网络 IO，多几个 worker
// 才能掩盖单次请求的延迟。更重要的是两者**不共享 worker**，网络慢不会反压到磁盘写入。
func (w *ParquetWriter[T]) SetDispatchers(disk, upload *archiveDispatcher) {
	if w == nil {
		return
	}
	w.diskPool = disk
	w.uploadPool = upload
}

// Append 投递一行。非阻塞：缓冲满时丢弃并计数，返回是否被接收。
func (w *ParquetWriter[T]) Append(row T) bool {
	if w == nil || w.closed.Load() {
		return false
	}
	select {
	case w.buffer <- row:
		return true
	default:
		dropped := w.dropped.Add(1)
		// 与 syslog 一致：按 100 条打点，避免刷屏。
		if dropped%100 == 1 {
			klog.Warningf("parquet archive buffer for %s is full, dropped %d record(s)", w.kind, dropped)
		}
		return false
	}
}

// Flush 请求立即落盘一次（非阻塞；真正的落盘在 Run 的 goroutine 里完成）。
func (w *ParquetWriter[T]) Flush() {
	if w == nil || w.closed.Load() {
		return
	}
	select {
	case w.flushSignal <- struct{}{}:
	default:
	}
}

// Close 关闭缓冲。Run 会在写完剩余记录后返回。可重复调用。
func (w *ParquetWriter[T]) Close() {
	if w == nil || w.closed.Swap(true) {
		return
	}
	close(w.buffer)
}

// Stats 返回被丢弃与已落盘的行数（供排障与指标使用）。
func (w *ParquetWriter[T]) Stats() (dropped, written int64) {
	if w == nil {
		return 0, 0
	}
	return w.dropped.Load(), w.written.Load()
}

// Run 是 writer 的循环本体：攒批并在阈值到达时落盘，随 ctx 退出。
func (w *ParquetWriter[T]) Run(ctx context.Context) {
	interval := time.Duration(w.flush.IntervalSeconds) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	batch := make([]T, 0, w.flush.MaxBatchRows)
	batchBytes := 0

	// drain 把缓冲区里「已投递但还没进入 batch」的行先收进来。
	//
	// 没有它会有个真实的竞态：Append 之后立刻 Flush() 时，信号可能先于行被取走到达，
	// 那样这次 flush 落的是空文件，剩下的数据要一直等到下一个 ticker（可能是几小时）。
	drain := func() {
		for {
			select {
			case row, ok := <-w.buffer:
				if !ok {
					return
				}
				batch = append(batch, row)
				batchBytes += row.rowBytes()
			default:
				return
			}
		}
	}
	flush := func() {
		if len(batch) == 0 {
			return
		}
		// 这一批交给写盘池之后就归 worker 所有，**必须重新分配**而不是复用底层数组
		// （原来是 batch[:0]）：否则 Run 继续 append 时会与正在写文件的 worker 争同一块内存。
		rows := batch
		batch = make([]T, 0, w.flush.MaxBatchRows)
		batchBytes = 0
		w.submitWrite(rows)
	}

	for {
		select {
		case <-ctx.Done():
			drain()
			flush()
			return
		case <-w.flushSignal:
			drain()
			flush()
		case row, ok := <-w.buffer:
			if !ok {
				flush()
				return
			}
			batch = append(batch, row)
			batchBytes += row.rowBytes()
			if len(batch) >= w.flush.MaxBatchRows ||
				(w.flush.MaxBatchBytes > 0 && int64(batchBytes) >= w.flush.MaxBatchBytes) {
				flush()
			}
		case <-ticker.C:
			drain()
			flush()
		}
	}
}

// archiveInstanceToken 是本进程在归档文件名里的短标识（8 位十六进制）。
//
// 为什么必须带上它：多副本共享同一个归档目录时，两个副本完全可能在**同一秒**各落一个文件。
// 文件名若只由「时间戳 + 进程内序号」构成，两边算出的名字完全相同，后一次原子 rename 会直接
// 覆盖先写好的那个文件——丢掉的是整整一批记录，而且丢得毫无痕迹（没有报错、没有指标）。
// 加上本进程独有的标识，两个副本的文件名就不可能撞上。
//
// 取值来自「主机名 + 进程号」的散列（32 位）：同一台机器上多进程靠进程号区分，跨机器靠主机名，
// IP/主机名重复的极端情况下还有 1/2^32 的碰撞概率。不用随机数是为了让文件名可复现、便于排查
// 「哪个副本写的这个文件」。
var archiveInstanceToken = archiveInstanceTokenFor(hostnameForArchiveToken(), os.Getpid())

// archiveInstanceTokenFor 由实例身份算出文件名标识（抽成纯函数便于直接验证）。
func archiveInstanceTokenFor(host string, pid int) string {
	sum := fnv.New32a()
	_, _ = fmt.Fprintf(sum, "%s:%d", host, pid)
	return fmt.Sprintf("%08x", sum.Sum32())
}

// hostnameForArchiveToken 取主机名；取不到时回落一个固定值（同机多进程仍靠进程号区分）。
func hostnameForArchiveToken() string {
	if host, err := os.Hostname(); err == nil && host != "" {
		return host
	}
	return "unknown"
}

// archiveFileName 组装归档文件名：`<类型>-<日期-时间>-<序号>-<实例标识>.parquet`。
//
// 顺序上把实例标识放在**最后**，这样 `ls` 出来的同一秒文件仍按副本聚在一起；检索侧按
// `*.parquet` 通配，不解析文件名（见 archive_query_duckdb.go）。
func archiveFileName(kind ParquetKind, at time.Time, seq uint64, token string) string {
	return fmt.Sprintf("%s-%s-%d-%s.parquet", kind, at.Format("20060102-150405"), seq, token)
}

// writeFile 把一批行写成 `<dir>/<年>/<月>/<日>/<类型>-<时间>-<序号>-<实例标识>.parquet`。
// 先写 .tmp 再原子 rename：收集工具只识别终态文件，绝不会读到半写内容。
func (w *ParquetWriter[T]) writeFile(rows []T) error {
	now := time.Now()
	name := archiveFileName(w.kind, now, w.seq.Add(1), archiveInstanceToken)

	// 内存直传：不落本地文件，object key 用相对名 `<kind>/<年>/<月>/<日>/<file>.parquet`。
	if w.memoryUpload != nil {
		relName := filepath.ToSlash(filepath.Join(string(w.kind), now.Format("2006"), now.Format("01"), now.Format("02"), name))
		return w.writeMemory(relName, rows)
	}

	dir := filepath.Join(w.dir, now.Format("2006"), now.Format("01"), now.Format("02"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create archive directory %s: %w", dir, err)
	}

	finalPath := filepath.Join(dir, name)
	tmpPath := finalPath + ".tmp"

	file, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("failed to create %s: %w", tmpPath, err)
	}

	writer := parquet.NewGenericWriter[T](file)
	if _, err := writer.Write(rows); err != nil {
		_ = file.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to write parquet data: %w", err)
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to close parquet writer: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to close %s: %w", tmpPath, err)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to publish %s: %w", finalPath, err)
	}

	w.runHooks(finalPath)
	return nil
}

// writeMemory 把一批行编码成 parquet 字节，交给内存直传回调上传（不落本地文件）。
func (w *ParquetWriter[T]) writeMemory(relName string, rows []T) error {
	var buf bytes.Buffer
	writer := parquet.NewGenericWriter[T](&buf)
	if _, err := writer.Write(rows); err != nil {
		return fmt.Errorf("failed to encode parquet data: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("failed to finalize parquet data: %w", err)
	}
	return w.memoryUpload(relName, buf.Bytes())
}

// submitWrite 把一批行交给写盘池（未注入池时同步写）。写盘结果只计数与告警，绝不回压写入路径。
func (w *ParquetWriter[T]) submitWrite(rows []T) {
	write := func() {
		if err := w.writeFile(rows); err != nil {
			archiveFlushFailures.Add(1)
			klog.Errorf("failed to flush %s archive file: %v", w.kind, err)
			return
		}
		w.written.Add(int64(len(rows)))
	}

	// 内存直传：编码 + 上传都以网络 IO 为主，走上传池而不是写盘池（本地 IO）。
	if w.memoryUpload != nil {
		if w.uploadPool == nil {
			write()
			return
		}
		w.uploadPool.Submit(write)
		return
	}

	if w.diskPool == nil {
		write()
		return
	}
	w.diskPool.Submit(write)
}

// runHooks 依次调用落盘回调（如 S3 上传）。单个回调失败不影响其他回调，也不回滚文件。
//
// 回调（当前只有 S3 上传）会走上传池而不是在写盘协程里同步跑：写盘 worker 上传完就能立刻
// 接下一批，而上传的耗时只占用网络 worker。
func (w *ParquetWriter[T]) runHooks(path string) {
	hooks := w.snapshotHooks()
	if len(hooks) == 0 {
		return
	}

	run := func() {
		for _, hook := range hooks {
			if err := hook(path); err != nil {
				// 当前唯一的 flush hook 是 S3 上传；失败的文件会留在本地，由补传任务兜底。
				archiveUploadFailures.Add(1)
				klog.Warningf("archive file %s post-flush hook failed: %v", path, err)
			}
		}
	}

	if w.uploadPool == nil {
		run()
		return
	}
	w.uploadPool.Submit(run)
}

// snapshotHooks 取一份钩子的快照，避免在池的 worker 里长时间持锁。
func (w *ParquetWriter[T]) snapshotHooks() []FlushHook {
	w.hooksMu.RLock()
	defer w.hooksMu.RUnlock()
	if len(w.hooks) == 0 {
		return nil
	}
	hooks := make([]FlushHook, len(w.hooks))
	copy(hooks, w.hooks)
	return hooks
}
