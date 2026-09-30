package model

import "context"

// requestIDContextKey 是请求关联 ID 在 context 里的私有键类型。
//
// 键放在 model 层而不是 middleware：middleware 依赖 model，反过来会形成循环依赖。而审计记录
// 的外发发生在 model 层的 AfterCreate 钩子里（见 audit_forward.go），需要能按 context 取值。
type requestIDContextKey struct{}

// WithRequestID 把请求关联 ID 放进 context。
//
// 请求关联 ID 把「访问日志 / 审计事件 / 报错日志」串成同一条链，是日志闭环的前提：
// 只靠时间戳无法可靠地把一次用户操作与它触发的日志对应起来。
// 见 docs/dev/plans/2026-09-20-日志闭环设计.md。
func WithRequestID(ctx context.Context, requestID string) context.Context {
	if ctx == nil || requestID == "" {
		return ctx
	}
	return context.WithValue(ctx, requestIDContextKey{}, requestID)
}

// RequestIDFromContext 取出请求关联 ID（没有时返回空串）。
func RequestIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	requestID, _ := ctx.Value(requestIDContextKey{}).(string)
	return requestID
}
