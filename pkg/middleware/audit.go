package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// adminAuditPathPrefix 是审计中间件覆盖的路由前缀：只有管理接口的写操作会被记录。
const adminAuditPathPrefix = "/api/v1/admin/"

// adminAuditTypePrefix 区分系统配置类审计与资源处理器写入的 Kubernetes 资源，
// 避免与集群内的同名资源（如 rbac 的 roles）在按资源查询历史时互相干扰。
const adminAuditTypePrefix = "system/"

// adminAuditOperations 把 HTTP 写方法映射为审计日志里的操作类型。
var adminAuditOperations = map[string]string{
	http.MethodPost:   "create",
	http.MethodPut:    "update",
	http.MethodPatch:  "patch",
	http.MethodDelete: "delete",
}

// adminAuditReadOperation 是读取审计日志本身在操作日志里的操作类型：
// 等保三级要求审计员查看审计记录的行为也可追溯（A4）。
const adminAuditReadOperation = "read"

// adminAuditReadPaths 是需要记录读取行为的接口（相对 /api/v1/admin 的前缀）。
// 只覆盖审计日志：如果把整个管理面的 GET 都写进操作日志，日志会被浏览行为淹没。
var adminAuditReadPaths = []string{
	"/audit-logs",
	"/login-logs",
	"/password-change-logs",
}

// adminAuditResourceTypes 把 /api/v1/admin 下的第一段路径映射为审计日志中展示的资源类型。
var adminAuditResourceTypes = map[string]string{
	"groups":                     "user-group",
	"group-members":              "user-group",
	"oauth-providers":            "oauth-provider",
	"ldap-setting":               "ldap-setting",
	"clusters":                   "cluster",
	"roles":                      "role",
	"binding-groups":             "binding-group",
	"users":                      "user",
	"sidebar_preference":         "ui-preference",
	"apikeys":                    "api-key",
	"general-setting":            "general-setting",
	"security-setting":           "security-setting",
	"notification-setting":       "notification-setting",
	"notification-templates":     "notification-template",
	"notification-subscriptions": "notification-subscription",
	"announcements":              "announcement",
	"templates":                  "template",
	"charts":                     "helm-repository",
	"audit-logs":                 "audit-log",
	"login-logs":                 "login-log",
	"password-change-logs":       "password-change-log",
}

// adminAuditSkippedSuffixes 是不改变任何配置的辅助接口：记录它们只会给审计日志添噪。
var adminAuditSkippedSuffixes = []string{"/test-mail", "/run-daily-checks"}

// adminAuditIdentifierKeys 是请求体里可以用于标识被操作对象的字段，按优先级排列。
// 只挑这几个字段，避免把密码、密钥等敏感内容写进审计日志。
// title 放在最后：只有前面都未命中时才用它（目前只有通知栏公告的请求体带这个字段），
// 不会改变其它接口已有的标识口径。
var adminAuditIdentifierKeys = []string{
	"username", "name", "ip", "event", "subject", "cluster", "namespace", "title",
}

// AdminAudit 把管理接口的写操作（POST/PUT/PATCH/DELETE）记录到 resource_histories，
// 使「日志审计 → 操作日志」除了集群资源变更之外，也覆盖系统设置与权限管理下的管理操作。
// 审计日志本身的**读取**也会留痕（A4）：审计员的查询行为必须可追溯。
// 请求体只用于提取对象名称，不落库，因此不会记录密码、密钥等敏感值。
func AdminAudit() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 管理路由挂在 common.Base 之下（见 main.buildEngine），而下面的前缀常量是
		// 相对 /api/v1 的：设了 AEROLINK_BASE 时不剥掉它，所有管理端写操作都会漏审计。
		path := strings.TrimPrefix(c.Request.URL.Path, common.Base)
		if !strings.HasPrefix(path, adminAuditPathPrefix) {
			c.Next()
			return
		}

		operation, isWrite := adminAuditOperations[c.Request.Method]
		if !isWrite {
			if !isAdminAuditRead(c.Request.Method, path) {
				c.Next()
				return
			}
			operation = adminAuditReadOperation
		}

		for _, suffix := range adminAuditSkippedSuffixes {
			if strings.HasSuffix(path, suffix) {
				c.Next()
				return
			}
		}

		body := readAdminAuditBody(c)
		c.Next()
		recordAdminAudit(c, path, operation, body)
	}
}

// isAdminAuditRead 报告某个读请求是否指向审计日志
// 端点（包括它们的导出子路由）。这些路由只在
// GET/HEAD 上匹配（见 routes.go），因此对同一路径的写请求仍会按
// 上面的写请求处理。
func isAdminAuditRead(method, path string) bool {
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	rest := strings.Trim(strings.TrimPrefix(path, adminAuditPathPrefix), "/")
	for _, candidate := range adminAuditReadPaths {
		prefix := strings.Trim(candidate, "/")
		if rest == prefix || strings.HasPrefix(rest, prefix+"/") {
			return true
		}
	}
	return false
}

// readAdminAuditBody 读取请求体后原样放回，供后续处理器正常绑定。
func readAdminAuditBody(c *gin.Context) []byte {
	if c.Request.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(c.Request.Body)
	_ = c.Request.Body.Close()
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil {
		return nil
	}
	return raw
}

func recordAdminAudit(c *gin.Context, path, operation string, body []byte) {
	user, ok := c.Get("user")
	if !ok {
		return
	}
	operator, ok := user.(model.User)
	if !ok || operator.ID == 0 {
		return
	}

	segments := adminAuditSegments(path)
	resourceType := adminAuditResourceTypes[segments[0]]
	if resourceType == "" {
		resourceType = segments[0]
	}
	success := c.Writer.Status() < http.StatusBadRequest
	errMsg := ""
	if !success {
		errMsg = "HTTP " + strconv.Itoa(c.Writer.Status())
	}

	// handler 若补充了详情（见 common.AdminAuditDetail），优先采用：删除这类没有请求体
	// 的接口只靠路径只能记下 `#6`，而删除最需要知道「删的是哪个对象、删掉的是什么」。
	resourceName := adminAuditResourceName(segments, body)
	previousYAML := ""
	if value, ok := c.Get(common.AdminAuditDetailKey); ok {
		if detail, ok := value.(common.AdminAuditDetail); ok {
			if name := strings.TrimSpace(detail.ResourceName); name != "" {
				resourceName = name
			}
			previousYAML = detail.PreviousYAML
		}
	}

	history := model.ResourceHistory{
		ClusterName:     strings.TrimSpace(c.GetHeader(ClusterNameHeader)),
		ResourceType:    adminAuditTypePrefix + resourceType,
		ResourceName:    resourceName,
		PreviousYAML:    model.LongText(previousYAML),
		OperationType:   operation,
		OperationSource: "manual",
		Success:         success,
		ErrorMessage:    errMsg,
		ClientIP:        c.ClientIP(),
		UserAgent:       common.AuditUserAgent(c.Request.UserAgent()),
		OperatorID:      model.OperatorRef(operator.ID),
		OperatorName:    operator.Username,
	}
	// 带上请求上下文：审计事件据此带上 request_id，让日志平台能把这条操作与同一次请求的
	// 访问日志、报错日志串起来。
	// 走统一入口而不是 DB.Create：由 sink 决定落库还是直接归档（见 model.RecordAudit）。
	if err := model.RecordAudit(c.Request.Context(), &history); err != nil {
		klog.Errorf("Failed to record admin audit log: %v", err)
	}
}

// adminAuditSegments 返回管理接口路径在 /api/v1/admin/ 之后的各段（已去掉尾斜杠）。
func adminAuditSegments(path string) []string {
	trimmed := strings.Trim(strings.TrimPrefix(path, adminAuditPathPrefix), "/")
	if trimmed == "" {
		return []string{""}
	}
	return strings.Split(trimmed, "/")
}

func adminAuditResourceName(segments []string, body []byte) string {
	if len(body) > 0 {
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err == nil {
			for _, key := range adminAuditIdentifierKeys {
				if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
					return strings.TrimSpace(value)
				}
			}
		}
	}
	if len(segments) < 2 {
		return ""
	}
	// 删除等没有请求体名称的接口退回路径标识：纯 ID 加 "#" 前缀，
	// 其余段（子资源、动作）作为后缀保留，例如 "#5/namespaces"。
	identifier := segments[1]
	if _, err := strconv.Atoi(identifier); err == nil {
		identifier = "#" + identifier
	}
	if len(segments) > 2 {
		identifier += "/" + strings.Join(segments[2:], "/")
	}
	return identifier
}
