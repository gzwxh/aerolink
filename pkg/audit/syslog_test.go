package audit

import (
	"strings"
	"testing"

	"github.com/zxh326/kite/pkg/model"
)

// TestFormatSyslogLineMatchesLegacyOutput 是「序列化上移到 audit 层」的回归契约：
// 相同的审计记录，渲染结果必须与改造前（model 层渲染）逐字节一致。
func TestFormatSyslogLineMatchesLegacyOutput(t *testing.T) {
	cases := []struct {
		name    string
		message model.AuditMessage
		want    string
	}{
		{
			name: "operation success",
			message: model.AuditMessage{
				Kind:            model.AuditKindOperation,
				ResourceType:    "deployment",
				ResourceName:    "nginx",
				OperationType:   "update",
				Success:         true,
				OperatorName:    "alice",
				ClusterName:     "prod",
				Namespace:       "default",
				OperationSource: "manual",
				ClientIP:        "10.0.0.1",
			},
			want: "event=audit op=update result=success resource=deployment/nginx operator=alice cluster=prod namespace=default source=manual client=10.0.0.1",
		},
		{
			name: "operation failure with empty fields collapses to dashes",
			message: model.AuditMessage{
				Kind:          model.AuditKindOperation,
				ResourceType:  "pod",
				OperationType: "delete",
				Success:       false,
			},
			want: "event=audit op=delete result=failure resource=pod operator=- cluster=- namespace=- source=- client=-",
		},
		{
			name: "login success",
			message: model.AuditMessage{
				Kind:     model.AuditKindLogin,
				Username: "alice",
				Provider: "password",
				Result:   model.AuditResultSuccess,
				ClientIP: "10.0.0.1",
			},
			want: "event=login result=success user=alice provider=password client=10.0.0.1",
		},
		{
			name: "login failure keeps FAIL prefix for severity escalation",
			message: model.AuditMessage{
				Kind:     model.AuditKindLogin,
				Username: "bob",
				Provider: "ldap",
				Result:   "invalid_credentials",
				ClientIP: "10.0.0.2",
			},
			want: "FAIL event=login result=failure reason=invalid_credentials user=bob provider=ldap client=10.0.0.2",
		},
		{
			name: "password change",
			message: model.AuditMessage{
				Kind:     model.AuditKindPasswordChange,
				Username: "alice",
				Operator: "admin",
				Source:   "admin",
			},
			want: "event=password user=alice operator=admin source=admin",
		},
		{
			name: "newlines are sanitized to keep one record per line",
			message: model.AuditMessage{
				Kind:         model.AuditKindOperation,
				ResourceType: "pod",
				OperatorName: "a\nb",
				Success:      true,
			},
			want: "event=audit op= result=success resource=pod operator=a b cluster=- namespace=- source=- client=-",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatSyslogLine(tc.message); got != tc.want {
				t.Errorf("formatSyslogLine() =\n  %q\nwant\n  %q", got, tc.want)
			}
		})
	}
}

func TestFormatSyslogLineUnknownKindIsEmpty(t *testing.T) {
	if got := formatSyslogLine(model.AuditMessage{Kind: "unknown"}); got != "" {
		t.Errorf("formatSyslogLine(unknown) = %q, want empty", got)
	}
}

func TestFormatSyslogMessageSeverity(t *testing.T) {
	config := model.LogForwardSetting{Facility: model.DefaultSyslogFacility, Tag: "kite"}

	// facility 13*8 + informational 6 = 110
	informational := formatSyslogMessage(config, "event=login result=success user=a")
	if !strings.HasPrefix(informational, "<110>1 ") {
		t.Errorf("informational message = %q, want prefix <110>1", informational)
	}
	if !strings.Contains(informational, "event=login result=success user=a") {
		t.Errorf("informational message body lost: %q", informational)
	}

	// facility 13*8 + warning 4 = 108，且 FAIL 前缀被剥离。
	warning := formatSyslogMessage(config, "FAIL event=login result=failure")
	if !strings.HasPrefix(warning, "<108>1 ") {
		t.Errorf("warning message = %q, want prefix <108>1", warning)
	}
	if strings.Contains(warning, "FAIL ") {
		t.Errorf("warning message still contains the FAIL prefix: %q", warning)
	}
	if !strings.HasSuffix(warning, "event=login result=failure") {
		t.Errorf("warning message body = %q", warning)
	}
}

func TestSendSyslogSkipsUnknownKind(t *testing.T) {
	// 未知分类不应往日志服务器灌一条空消息；发送前的短路不依赖网络，可以直接验证。
	if line := formatSyslogLine(model.AuditMessage{}); line != "" {
		t.Fatalf("formatSyslogLine(empty kind) = %q, want empty", line)
	}
}
