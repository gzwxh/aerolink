package model

import (
	"sync"
	"time"

	"gorm.io/gorm"
)

// 审计消息的分类：决定外发（syslog）与归档（parquet / ES）按哪套 schema 取字段。
const (
	AuditKindOperation      = "operation"
	AuditKindLogin          = "login"
	AuditKindPasswordChange = "password_change"
	AuditKindAccess         = "access_log"
)

// AuditResultSuccess 是外发与归档时统一的「成功」取值。
//
// 本地库里 LoginRecord.Result 成功时是空字符串（见 LoginResultSuccess），
// 而外发与归档是给人看、给检索用的，所以统一成 "success"；失败保留具体原因码。
const AuditResultSuccess = "success"

// AuditMessage 是一条结构化审计记录。
//
// 字段是四类日志的并集，各 sink 按 Kind 取用自己相关的字段（见方案 §5 的 schema）：
// 序列化不再发生在 model 层——model 只负责把记录（落库后）原样交出来，
// syslog 渲染成 key=value、parquet 落列、ES 写文档都各自在 pkg/audit 完成。
type AuditMessage struct {
	// Kind 取值见 AuditKind* 常量。
	Kind string
	// At 是事件的业务时间（落库后的 created_at）。
	At time.Time
	// ID 是本地自增主键，供 parquet / ES 作为稳定文档标识。
	ID uint
	// RequestID 是触发这条记录的请求关联 ID，把访问日志、审计事件与报错日志串成一条链。
	// 可能为空：非请求路径产生的事件（例如保留策略自己写的清理记录）没有请求上下文。
	// 它只存在于日志链路，不落库。
	RequestID string

	// —— 操作日志（AuditKindOperation）——
	ClusterName     string
	ResourceType    string
	ResourceName    string
	Namespace       string
	OperationType   string
	OperationSource string
	Success         bool
	ErrorMessage    string
	UserAgent       string
	OperatorID      uint
	OperatorName    string
	// ResourceYAML / PreviousYAML 是变更前后的资源清单。默认**不归档**（内容可能很大），
	// 由归档配置的 includeResourceYAML 开关决定是否写入 parquet；syslog 与 ES 始终不含。
	ResourceYAML string
	PreviousYAML string

	// —— 登录（AuditKindLogin）/ 改密（AuditKindPasswordChange）——
	UserID   uint
	Username string
	Provider string
	// Result 为 AuditResultSuccess 或失败原因码（登录）；改密不使用。
	Result string
	// SourceIP 是原始客户端 IP（仅登录记录）。
	SourceIP string
	// Operator / Source 为改密日志的字段。
	Operator string
	Source   string

	// —— 访问日志（AuditKindAccess）——
	ClientIP   string
	Method     string
	Path       string
	StatusCode int
	LatencyMs  int64
}

// auditForwarders 是审计记录落库后的外发回调列表（日志外发、stdout、归档各注册一个）。
//
// 用回调而不是直接依赖：pkg/audit 需要读取 model，反向依赖会形成循环。
// 回调在**落库之后**触发，且必须是非阻塞的（见 audit.forwardToLogForward 与
// audit.forwardToParquet），绝不能在写库路径上阻塞请求。
var (
	auditForwardersMu sync.RWMutex
	auditForwarders   []func(AuditMessage)
)

// AddAuditForwarder 注册一个审计外发回调。重复调用会追加，不再覆盖：
// stdout、日志外发与 parquet 归档各自是一个独立的 sink。
func AddAuditForwarder(forward func(AuditMessage)) {
	if forward == nil {
		return
	}
	auditForwardersMu.Lock()
	defer auditForwardersMu.Unlock()
	auditForwarders = append(auditForwarders, forward)
}

func forwardAuditMessage(message AuditMessage) {
	auditForwardersMu.RLock()
	defer auditForwardersMu.RUnlock()
	for _, forward := range auditForwarders {
		forward(message)
	}
}

// AfterCreate 让每条操作日志都能外发/归档（syslog、parquet、标准输出）。
func (h *ResourceHistory) AfterCreate(db *gorm.DB) error {
	message := operationAuditMessage(h)
	message.RequestID = requestIDFromDB(db)
	forwardAuditMessage(message)
	return nil
}

// AfterCreate 让每次登录尝试（含失败）都能外发/归档。
func (l *LoginRecord) AfterCreate(db *gorm.DB) error {
	message := loginAuditMessage(l)
	message.RequestID = requestIDFromDB(db)
	forwardAuditMessage(message)
	return nil
}

// requestIDFromDB 从 gorm 的 Statement.Context 取出请求关联 ID。
//
// 调用方用 `DB.WithContext(c.Request.Context())` 写入时，请求上下文里的 ID 就能到达这里，
// 从而进入所有外发/归档通道；没带上下文的写入（例如保留策略的清理记录）返回空串，属正常情况。
func requestIDFromDB(db *gorm.DB) string {
	if db == nil || db.Statement == nil {
		return ""
	}
	return RequestIDFromContext(db.Statement.Context)
}

// operationAuditMessage 把一条操作日志转成结构化消息。
//
// operator 在 model 层就预填（优先取关联用户的用户名，回落到写入时的快照），
// 这样各 sink 不必再理解 User 关联。
func operationAuditMessage(h *ResourceHistory) AuditMessage {
	operator := h.OperatorName
	if h.Operator != nil && h.Operator.Username != "" {
		operator = h.Operator.Username
	}
	operatorID := uint(0)
	if h.OperatorID != nil {
		operatorID = *h.OperatorID
	}
	return AuditMessage{
		Kind:            AuditKindOperation,
		At:              h.CreatedAt,
		ID:              h.ID,
		ClusterName:     h.ClusterName,
		ResourceType:    h.ResourceType,
		ResourceName:    h.ResourceName,
		Namespace:       h.Namespace,
		OperationType:   h.OperationType,
		OperationSource: h.OperationSource,
		Success:         h.Success,
		ErrorMessage:    h.ErrorMessage,
		ClientIP:        h.ClientIP,
		UserAgent:       h.UserAgent,
		OperatorID:      operatorID,
		OperatorName:    operator,
		// string 赋值只复制头部（指针 + 长度），不会拷贝 YAML 内容，所以这里可以放心带上；
		// 是否真的写进归档由 sink 按配置决定。
		ResourceYAML: string(h.ResourceYAML),
		PreviousYAML: string(h.PreviousYAML),
	}
}

// loginAuditMessage 把一条登录记录转成结构化消息（成功归一到 AuditResultSuccess）。
func loginAuditMessage(l *LoginRecord) AuditMessage {
	result := l.Result
	if result == LoginResultSuccess {
		result = AuditResultSuccess
	}
	return AuditMessage{
		Kind:      AuditKindLogin,
		At:        l.CreatedAt,
		ID:        l.ID,
		UserID:    l.UserID,
		Username:  l.Username,
		Provider:  l.Provider,
		Result:    result,
		ClientIP:  l.IP,
		SourceIP:  l.SourceIP,
		UserAgent: l.UserAgent,
	}
}

// passwordChangeAuditMessage 把一条改密记录转成结构化消息。
func passwordChangeAuditMessage(e *PasswordChangeLog) AuditMessage {
	return AuditMessage{
		Kind:       AuditKindPasswordChange,
		At:         e.CreatedAt,
		ID:         e.ID,
		UserID:     e.UserID,
		Username:   e.Username,
		OperatorID: e.OperatorID,
		Operator:   e.Operator,
		Source:     e.Source,
	}
}
