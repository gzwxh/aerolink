package audit

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"aerolink/pkg/model"
	"k8s.io/klog/v2"
)

// —— 外部日志存储（Elasticsearch / VictoriaLogs / OpenObserve）的公共骨架 ——
//
// 这三家的差异只在「端点路径 + 认证 + 流/索引命名」，而文档内容与失败处理完全一致：
//   - 文档都来自 esDocumentFromMessage（字段集见方案 §5 schema，中立、不绑定任何后端）；
//   - 写入都在 uploadPool 里跑，失败计入 aerolink_audit_archive_failures_total{stage="write"}；
//   - 都只做 HTTP，不引入任何第三方客户端库（许可证与依赖面都更干净）。

// documentSink 是「把一批中立文档写进外部日志存储」的统一接口。
//
// ES 复用按天索引（自己管过期索引删除）；VictoriaLogs / OpenObserve 用单流名，由服务端按时间
// 分区并自带保留（见 plans/2026-09-21-新增审计落地方式.md §3.2/§3.4）。
type documentSink interface {
	Write(ctx context.Context, docs []ESDocument) error
}

// logSinkClient 构造外部日志存储的 HTTP 客户端。
//
// 只在管理员显式开启时才跳过证书校验（内网自签场景），默认走系统根证书；超时与归档写入的超时
// 保持同一个量级，避免一次慢请求把 uploadPool 的 worker 长期占住。
func logSinkClient(insecureSkipVerify bool) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		// #nosec G402 -- 自签场景由管理员显式开启，与 syslog / ES 的 skipVerify 同等级别。
		InsecureSkipVerify: insecureSkipVerify,
		MinVersion:         tls.VersionTLS12,
	}
	return &http.Client{Transport: transport, Timeout: archiveWriteTimeout}
}

// logSinkEndpoints 是「多地址轮询 + 故障切换」的小封装。
//
// 配置里给了多个地址时（VictoriaLogs 集群前的 vmauth / 多个 OpenObserve 节点），每次写入从
// 上次成功的下一个地址开始尝试，一个失败就换下一个；全部失败才把最后一个错误返回。
type logSinkEndpoints struct {
	urls []string
	next atomic.Uint64
}

// newLogSinkEndpoints 归一化地址（去空格、去尾部斜杠），空列表由调用方在任何写入前拦下。
func newLogSinkEndpoints(urls []string) *logSinkEndpoints {
	cleaned := make([]string, 0, len(urls))
	for _, url := range urls {
		trimmed := strings.TrimRight(strings.TrimSpace(url), "/")
		if trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	return &logSinkEndpoints{urls: cleaned}
}

// candidates 返回本次要尝试的地址顺序：从轮询位开始绕一圈。
func (e *logSinkEndpoints) candidates() []string {
	if len(e.urls) == 0 {
		return nil
	}
	start := int(e.next.Add(1)-1) % len(e.urls)
	ordered := make([]string, 0, len(e.urls))
	for i := 0; i < len(e.urls); i++ {
		ordered = append(ordered, e.urls[(start+i)%len(e.urls)])
	}
	return ordered
}

// documentSummary 把一条文档渲染成一行可读文本。
//
// 用途：VictoriaLogs 的 `_msg` 是「日志正文」，不填就只有 `-`，在它的 Web UI / Grafana 里看
// 不出这条记录是什么。这里按 key 排序渲染成 `kind=... k=v ...`，既是可读的正文，也让 LogsQL 的
// 自由文本检索（如 `web`）能命中。
func documentSummary(doc ESDocument) string {
	keys := make([]string, 0, len(doc.Fields))
	for key := range doc.Fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var builder strings.Builder
	if doc.Kind != "" {
		builder.WriteString(doc.Kind)
	}
	for _, key := range keys {
		// resource_yaml / previous_yaml 可能动辄几 MB：总结行不该把它们带上。
		if key == "resource_yaml" || key == "previous_yaml" {
			continue
		}
		value := strings.TrimSpace(fmt.Sprint(doc.Fields[key]))
		if value == "" || value == "<nil>" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		builder.WriteString(key)
		builder.WriteByte('=')
		builder.WriteString(value)
	}
	return truncateSummary(builder.String())
}

// documentSummaryMaxLen 是总结行的长度上限（VictoriaLogs 侧只是给人看，不必带全字段）。
const documentSummaryMaxLen = 512

func truncateSummary(value string) string {
	if len(value) <= documentSummaryMaxLen {
		return value
	}
	// 按字节截断可能切断多字节字符：回退到最后一个完整 rune 边界。
	cut := documentSummaryMaxLen
	for cut > 0 && !utf8StartByte(value[cut]) {
		cut--
	}
	return value[:cut] + "…"
}

// utf8StartByte 报告 b 是否是多字节序列的首字节（ASCII 与首字节都返回 true）。
func utf8StartByte(b byte) bool {
	return b&0xC0 != 0x80
}

// streamNameOrDefault 返回配置的流名，为空时回落默认值（两家日志存储的流名语义一致）。
func streamNameOrDefault(stream string) string {
	if trimmed := strings.TrimSpace(stream); trimmed != "" {
		return trimmed
	}
	return model.DefaultLogStream
}

// —— 写入重试（与 ES bulk 同一套策略） ——

// errLogSinkNotRetryable 标记「重试没有意义」的失败：请求或数据本身不合法（认证不对、字段类型
// 不匹配、body 超限）。这类错误重试三遍只是白跑。
var errLogSinkNotRetryable = errors.New("log store request is not retryable")

// 重试策略：3 次尝试，退避 300ms → 600ms（与 ES bulk 的 bulkWithRetry 保持一致）。
const (
	logSinkWriteAttempts = 3
	logSinkWriteBackoff  = 300 * time.Millisecond
)

// writeLogSinkWithRetry 对一次外部日志存储写入做有限次退避重试。
//
// 短暂抖动（滚动重启、429 限流、连接被重置）不该让整批审计文档直接丢掉——归档是尽力而为，
// 但「能救回来的就别丢」；数据/权限本身有问题的失败不重试。
func writeLogSinkWithRetry(ctx context.Context, sink string, write func(context.Context) error) error {
	backoff := logSinkWriteBackoff
	var lastErr error

	for attempt := 1; attempt <= logSinkWriteAttempts; attempt++ {
		lastErr = write(ctx)
		if lastErr == nil {
			return nil
		}
		if errors.Is(lastErr, errLogSinkNotRetryable) || ctx.Err() != nil {
			return lastErr
		}
		if attempt == logSinkWriteAttempts {
			break
		}

		klog.Warningf("%s write failed (attempt %d/%d), retrying in %s: %v",
			sink, attempt, logSinkWriteAttempts, backoff, lastErr)

		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return lastErr
		case <-timer.C:
		}
		backoff *= 2
	}
	return lastErr
}
