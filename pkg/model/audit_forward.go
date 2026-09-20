package model

import (
	"strings"

	"gorm.io/gorm"
)

// auditForwarder 是审计记录落库后的外发回调（syslog，P2-4），由 pkg/audit 注册。
//
// 用回调而不是直接依赖：pkg/audit 需要读取 model，反向依赖会形成循环。
// 回调在**落库之后**触发，且必须是非阻塞的（见 audit.forwardToSyslog）。
var auditForwarder func(message string)

// SetAuditForwarder 注册审计记录外发回调。
func SetAuditForwarder(forward func(message string)) {
	auditForwarder = forward
}

func forwardAuditMessage(message string) {
	if auditForwarder == nil {
		return
	}
	auditForwarder(message)
}

// AfterCreate 让每条操作日志都能外发到外部 syslog（P2-4）。
func (h *ResourceHistory) AfterCreate(*gorm.DB) error {
	forwardAuditMessage(formatResourceHistoryAudit(h))
	return nil
}

// AfterCreate 让每次登录尝试（含失败）都能外发到外部 syslog（P2-4）。
func (l *LoginRecord) AfterCreate(*gorm.DB) error {
	forwardAuditMessage(formatLoginRecordAudit(l))
	return nil
}

func formatResourceHistoryAudit(h *ResourceHistory) string {
	result := "success"
	if !h.Success {
		result = "failure"
	}
	operator := h.OperatorName
	if h.Operator != nil && h.Operator.Username != "" {
		operator = h.Operator.Username
	}
	target := h.ResourceType
	if h.ResourceName != "" {
		target += "/" + h.ResourceName
	}

	fields := []string{
		"event=audit",
		"op=" + h.OperationType,
		"result=" + result,
		"resource=" + target,
		"operator=" + orDash(operator),
		"cluster=" + orDash(h.ClusterName),
		"namespace=" + orDash(h.Namespace),
		"source=" + orDash(h.OperationSource),
		"client=" + orDash(h.ClientIP),
	}
	return strings.Join(fields, " ")
}

func formatLoginRecordAudit(l *LoginRecord) string {
	if l.Result == LoginResultSuccess {
		return strings.Join([]string{
			"event=login",
			"result=success",
			"user=" + orDash(l.Username),
			"provider=" + orDash(l.Provider),
			"client=" + orDash(l.IP),
		}, " ")
	}
	// "FAIL " 前缀让 syslog 侧把严重级别提到 warning（见 audit.formatSyslogMessage）。
	return "FAIL " + strings.Join([]string{
		"event=login",
		"result=failure",
		"reason=" + l.Result,
		"user=" + orDash(l.Username),
		"provider=" + orDash(l.Provider),
		"client=" + orDash(l.IP),
	}, " ")
}

func orDash(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	// syslog 是行协议：换行会把一条记录拆成两条，必须替换掉。
	return strings.NewReplacer("\n", " ", "\r", " ").Replace(value)
}
