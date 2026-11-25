package audit

import (
	"encoding/json"
	"sync/atomic"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
)

// AccessLogEntry 是一次 HTTP 访问的原始信息（由 middleware.Logger 填充）。
//
// path 不含 RawQuery：查询串里可能带 token 等敏感值，不应进入归档（方案 §5）。
type AccessLogEntry struct {
	At         time.Time
	ClientIP   string
	Method     string
	Path       string
	StatusCode int
	LatencyMs  int64
	Cluster    string
	User       string
	// UserID 是操作者的稳定标识：用户名可能被改名，ID 不会。
	UserID uint
	// RequestID 把这条访问日志与同一次请求的审计事件、报错日志串起来。
	RequestID string
}

// RecordAccessLog 把一次访问投递给归档链（parquet / ES）。
//
// 非阻塞，且不经过 syslog：访问日志量大，外发会淹没日志服务器，也会改变既有
// syslog 行为。归档未启用或缓冲满时直接丢弃，绝不影响请求。
func RecordAccessLog(entry AccessLogEntry) {
	if entry.At.IsZero() {
		entry.At = time.Now()
	}
	forwardToParquet(model.AuditMessage{
		Kind:        model.AuditKindAccess,
		At:          entry.At,
		ClientIP:    entry.ClientIP,
		Method:      entry.Method,
		Path:        entry.Path,
		StatusCode:  entry.StatusCode,
		LatencyMs:   entry.LatencyMs,
		ClusterName: entry.Cluster,
		Username:    entry.User,
		UserID:      entry.UserID,
		RequestID:   entry.RequestID,
	})
}

// accessLogFormat 缓存当前的访问日志输出格式（text|json）。
//
// 格式化在**每个请求**上执行，不能每次都去读数据库；配置变更时由
// reloadArchiveConfig 刷新。未初始化时回落 text（保持改造前的行为）。
var accessLogFormat atomic.Value

// SetAccessLogFormat 刷新访问日志输出格式（由 reloadArchiveConfig 调用）。
func SetAccessLogFormat(format string) {
	accessLogFormat.Store(model.NormalizeLogFormat(format))
}

// CurrentAccessLogFormat 返回访问日志输出格式（text|json）。
func CurrentAccessLogFormat() string {
	if value, ok := accessLogFormat.Load().(string); ok && value != "" {
		return value
	}
	return model.LogFormatText
}

// accessLogJSON 是 json 格式下的行结构：字段集与 §5 的访问日志 schema 一致，
// 字段顺序固定，便于日志系统按行解析。
type accessLogJSON struct {
	Timestamp  string `json:"ts"`
	ClientIP   string `json:"client_ip"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	StatusCode int    `json:"status_code"`
	LatencyMs  int64  `json:"latency_ms"`
	Cluster    string `json:"cluster,omitempty"`
	User       string `json:"user,omitempty"`
	UserID     uint   `json:"user_id,omitempty"`
	RequestID  string `json:"request_id,omitempty"`
}

// FormatAccessLogJSON 把一次访问渲染成单行 JSON（含结尾换行，与 text 格式一致）。
func FormatAccessLogJSON(entry AccessLogEntry) string {
	data, err := json.Marshal(accessLogJSON{
		Timestamp:  entry.At.Format(time.RFC3339),
		ClientIP:   entry.ClientIP,
		Method:     entry.Method,
		Path:       entry.Path,
		StatusCode: entry.StatusCode,
		LatencyMs:  entry.LatencyMs,
		Cluster:    entry.Cluster,
		User:       entry.User,
		UserID:     entry.UserID,
		RequestID:  entry.RequestID,
	})
	if err != nil {
		return ""
	}
	return string(data) + "\n"
}
