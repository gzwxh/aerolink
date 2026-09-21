package model

import (
	"context"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestOperationAuditMessageMapsFields(t *testing.T) {
	operatorID := uint(7)
	history := &ResourceHistory{
		ID:              42,
		CreatedAt:       time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC),
		ClusterName:     "prod",
		ResourceType:    "deployment",
		ResourceName:    "nginx",
		Namespace:       "default",
		OperationType:   "update",
		OperationSource: "manual",
		Success:         true,
		ErrorMessage:    "",
		ClientIP:        "10.0.0.1",
		UserAgent:       "curl",
		OperatorID:      &operatorID,
		OperatorName:    "snapshot-name",
		Operator:        &User{Username: "alice"},
	}

	message := operationAuditMessage(history)
	if message.Kind != AuditKindOperation {
		t.Errorf("Kind = %q, want %q", message.Kind, AuditKindOperation)
	}
	if message.ID != 42 || !message.At.Equal(history.CreatedAt) {
		t.Errorf("ID/At not carried over: %+v", message)
	}
	// 关联用户的用户名优先于写入时的快照。
	if message.OperatorName != "alice" {
		t.Errorf("OperatorName = %q, want alice (prefer the joined user)", message.OperatorName)
	}
	if message.OperatorID != 7 {
		t.Errorf("OperatorID = %d, want 7", message.OperatorID)
	}
	if message.ClusterName != "prod" || message.ResourceName != "nginx" || message.ClientIP != "10.0.0.1" {
		t.Errorf("fields not carried over: %+v", message)
	}
}

func TestOperationAuditMessageFallsBackToNameSnapshot(t *testing.T) {
	message := operationAuditMessage(&ResourceHistory{OperatorName: "snapshot", OperatorID: nil})
	if message.OperatorName != "snapshot" {
		t.Errorf("OperatorName = %q, want snapshot", message.OperatorName)
	}
	if message.OperatorID != 0 {
		t.Errorf("OperatorID = %d, want 0 when nil", message.OperatorID)
	}
}

func TestLoginAuditMessageNormalizesSuccess(t *testing.T) {
	// 本地库里成功登录的 result 是空串，外发/归档要统一成 "success"。
	success := loginAuditMessage(&LoginRecord{ID: 3, Username: "alice", Provider: "password", Result: LoginResultSuccess})
	if success.Kind != AuditKindLogin || success.Result != AuditResultSuccess {
		t.Errorf("successful login message = %+v", success)
	}

	failure := loginAuditMessage(&LoginRecord{Result: "invalid_credentials"})
	if failure.Result != "invalid_credentials" {
		t.Errorf("failure reason changed: %q", failure.Result)
	}
}

func TestPasswordChangeAuditMessageMapsFields(t *testing.T) {
	message := passwordChangeAuditMessage(&PasswordChangeLog{
		ID:         9,
		UserID:     3,
		Username:   "alice",
		OperatorID: 1,
		Operator:   "admin",
		Source:     PasswordChangeSourceAdmin,
	})
	if message.Kind != AuditKindPasswordChange {
		t.Errorf("Kind = %q", message.Kind)
	}
	if message.UserID != 3 || message.OperatorID != 1 || message.Operator != "admin" || message.Source != "admin" {
		t.Errorf("fields not carried over: %+v", message)
	}
}

func TestAddAuditForwarderAppendsAndDispatches(t *testing.T) {
	auditForwardersMu.Lock()
	saved := auditForwarders
	auditForwarders = nil
	auditForwardersMu.Unlock()
	t.Cleanup(func() {
		auditForwardersMu.Lock()
		auditForwarders = saved
		auditForwardersMu.Unlock()
	})

	var got []string
	AddAuditForwarder(func(m AuditMessage) { got = append(got, "first:"+m.Kind) })
	AddAuditForwarder(func(m AuditMessage) { got = append(got, "second:"+m.Kind) })
	// nil 回调应被忽略，而不是留下一个会在分发时空指针的槽位。
	AddAuditForwarder(nil)

	if len(auditForwarders) != 2 {
		t.Fatalf("registered %d forwarders, want 2", len(auditForwarders))
	}

	forwardAuditMessage(AuditMessage{Kind: AuditKindLogin})
	if len(got) != 2 || got[0] != "first:login" || got[1] != "second:login" {
		t.Errorf("dispatched to %v, want both forwarders in order", got)
	}
}

// request_id 经由 gorm 的 Statement.Context 从 HTTP 请求传到审计事件，
// 这是「访问日志 / 审计事件 / 报错日志 能对上」的关键一跳。
func TestRequestIDFromDBReadsStatementContext(t *testing.T) {
	ctx := WithRequestID(context.Background(), "req-123")
	db := &gorm.DB{Statement: &gorm.Statement{Context: ctx}}
	if got := requestIDFromDB(db); got != "req-123" {
		t.Errorf("requestIDFromDB() = %q, want req-123", got)
	}

	// 没有请求上下文的写入（例如保留策略自己写的清理记录）返回空串，属正常情况。
	if got := requestIDFromDB(&gorm.DB{Statement: &gorm.Statement{Context: context.Background()}}); got != "" {
		t.Errorf("requestIDFromDB() without a request context = %q, want empty", got)
	}
	if got := requestIDFromDB(nil); got != "" {
		t.Errorf("requestIDFromDB(nil) = %q, want empty", got)
	}
}

func TestWithRequestIDIgnoresEmptyValue(t *testing.T) {
	if got := RequestIDFromContext(WithRequestID(context.Background(), "")); got != "" {
		t.Errorf("empty request id should not be stored, got %q", got)
	}
	// 本函数对 nil 上下文是显式容忍的（非请求路径的调用点可能拿不到上下文），这里就是要覆盖那条分支。
	//nolint:staticcheck // SA1012：传 nil 是用例的本意。
	if got := RequestIDFromContext(nil); got != "" {
		t.Errorf("RequestIDFromContext(nil) = %q, want empty", got)
	}
}
