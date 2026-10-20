package kube

import (
	"errors"
	"net/http"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// StaleReason* 说明「数据可能陈旧」的判据，随 ClusterHealth.Reason 下发。
const (
	// StaleReasonUnreachable 表示距最后一次成功访问 API server 已超过陈旧阈值，
	// 或从未成功访问过：服务端缓存里的对象很可能已经落后于集群真实状态。
	StaleReasonUnreachable = "unreachable"
	// StaleReasonWatchError 表示 informer 的 ListAndWatch 刚报过错，
	// 在下次主动探活确认可达之前，按「可能陈旧」处理。
	StaleReasonWatchError = "watch-error"
)

// watchErrLogInterval 是同一集群重复输出 watch 错误日志的最小间隔：informer 断连时
// client-go 会持续重试，逐条打日志会刷屏，因此首次错误立即输出，之后每 5 分钟最多一条。
const watchErrLogInterval = 5 * time.Minute

// Health 跟踪单个集群 API server 的最近可用性，供「数据可能陈旧」提示使用。
//
// 两个信号来源不同、缺一不可：
//   - ListAndWatch 的错误回调只会在出错时触发（client-go 没有「已恢复」回调），
//     所以它只能标记异常，不能标记恢复；
//   - 恢复只能由主动探活（RecordProbeOK）确认。
//
// 所有方法都可在并发场景下调用。
type Health struct {
	mu sync.Mutex

	lastAPIOK    time.Time // 最后一次确认 API server 可达的时间；零值表示从未成功
	lastProbeErr string    // 最后一次探活失败的原因（仅用于诊断）
	watchErrAt   time.Time // 最近一次 watch 错误时间；探活成功后清零
	lastWatchErr string

	watchErrLogAt time.Time // 最近一次输出 watch 错误日志的时间（限频用）
}

// NewHealth 构造一个「从未成功访问过」的健康记录：在首次探活成功前它一律按陈旧处理。
func NewHealth() *Health {
	return &Health{}
}

// ClusterHealth 是 Health 在某一时刻的快照。
type ClusterHealth struct {
	// Stale 为 true 表示该集群的缓存数据可能已过期。
	Stale bool
	// LastOK 是最后一次确认 API server 可达的时间，零值表示从未成功访问过。
	LastOK time.Time
	// Age 是 now - LastOK；LastOK 为零值时 Age 无意义。
	Age time.Duration
	// Reason 是陈旧判据，取 StaleReason* 之一；不陈旧时为空。
	Reason string
}

// watchErrorIsUnsupported 判断一次 ListAndWatch 错误是否只是「该资源类型不支持 watch」。
// metrics.k8s.io 下的 PodMetrics/NodeMetrics 对 watch 一律返回 405：informer 会一直重试，
// 但这是资源类型的固有属性，不是集群可达性问题，不能据此把缓存标成陈旧。
func watchErrorIsUnsupported(err error) bool {
	if apierrors.IsMethodNotSupported(err) {
		return true
	}
	// metrics-server 的 405 用的是 StatusReason "MethodNotAllowed"（不是 builtin 的
	// "MethodNotSupported"），apimachinery 没有对应助手，按状态码判定。
	var status apierrors.APIStatus
	if errors.As(err, &status) {
		return status.Status().Code == http.StatusMethodNotAllowed
	}
	return false
}

// RecordWatchError 记录一次 informer 的 ListAndWatch 错误。
//
// 返回是否应当输出日志：首次错误与距上次输出超过 watchErrLogInterval 时为 true，
// 由调用方决定日志内容（这里不打印，免得把探测逻辑和日志绑死）。
func (h *Health) RecordWatchError(err error) bool {
	if err == nil || watchErrorIsUnsupported(err) {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	h.watchErrAt = now
	h.lastWatchErr = err.Error()
	if h.watchErrLogAt.IsZero() || now.Sub(h.watchErrLogAt) >= watchErrLogInterval {
		h.watchErrLogAt = now
		return true
	}
	return false
}

// LastWatchError 返回最近一次 watch 错误信息（没有则空串）。仅用于诊断输出。
func (h *Health) LastWatchError() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lastWatchErr
}

// RecordProbeOK 记录一次成功的主动探活。它是唯一的「已恢复」判据：成功即清除
// watch 错误标记并刷新最后一次可达时间。
func (h *Health) RecordProbeOK(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.lastAPIOK = now
	h.lastProbeErr = ""
	h.watchErrAt = time.Time{}
}

// RecordProbeError 记录一次失败的主动探活。
//
// 它不动 lastAPIOK（只有成功才刷新），所以单次失败不会立刻报警：陈旧由 Snapshot 按
// Age 增长判定，抖动自然被阈值吸收。这里只留下失败原因供诊断。
func (h *Health) RecordProbeError(err error) {
	if err == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	h.lastProbeErr = err.Error()
}

// Snapshot 在 now 时刻按 staleAfter 阈值计算健康状态。
//
// staleAfter <= 0 表示关闭基于时间的判定（此时只有「从未成功」与 watch 错误会判陈旧）。
func (h *Health) Snapshot(now time.Time, staleAfter time.Duration) ClusterHealth {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch := ClusterHealth{LastOK: h.lastAPIOK}
	if h.lastAPIOK.IsZero() {
		// 从未确认可达：不能证明缓存是新的，按陈旧处理。
		ch.Stale = true
		ch.Reason = StaleReasonUnreachable
		return ch
	}

	if age := now.Sub(h.lastAPIOK); age > 0 {
		ch.Age = age
	}
	if staleAfter > 0 && ch.Age > staleAfter {
		ch.Stale = true
		ch.Reason = StaleReasonUnreachable
	}
	// watch 错误比「探活变慢」更具体，但可达性优先：探活已经确认能连上时，
	// 说明 informer 只是这一轮出错，仍按 unreachable 之外的原因提示。
	if !h.watchErrAt.IsZero() && !ch.Stale {
		ch.Stale = true
		ch.Reason = StaleReasonWatchError
	}
	return ch
}
