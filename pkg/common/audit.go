package common

import "strings"

// MaxAuditUserAgentLength 限制存储的 User-Agent 长度。该请求头由客户端
// 控制且长度无界，而审计列是 varchar(255)，因此
// 绝不能原样写入。
const MaxAuditUserAgentLength = 255

// AuditUserAgent 为审计记录裁剪并限制 User-Agent 请求头的长度。
func AuditUserAgent(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) > MaxAuditUserAgentLength {
		return trimmed[:MaxAuditUserAgentLength]
	}
	return trimmed
}
