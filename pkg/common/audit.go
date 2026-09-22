package common

import (
	"strings"

	"k8s.io/klog/v2"
	"sigs.k8s.io/yaml"
)

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

// AdminAuditDetailKey 是 handler 向审计中间件补充「本次操作对象」的上下文键（见
// AdminAuditDetail）。放在 common 而不是 middleware 里是为了避开 import cycle：
// middleware 依赖 rbac，rbac 的 handler 不能反向依赖 middleware。
const AdminAuditDetailKey = "adminAuditDetail"

// AdminAuditDetail 是管理接口 handler 补充给审计记录的详情；零值字段表示沿用中间件
// 自己的推断（路径段 + 请求体）。
//
// 中间件只认路径与请求体：DELETE 没有请求体，于是只剩自增 ID（`#6`）——而删除恰恰
// 是最需要知道「删了什么」的动作，对象此时已经不存在，事后无从查证。因此允许 handler
// 在删除前塞入可读标识与配置快照。
type AdminAuditDetail struct {
	// ResourceName 覆盖从路径推断的对象标识，例如角色名而不是 `#6`。
	ResourceName string
	// PreviousYAML 是对象在本次操作前的配置快照，写入 previous_yaml，
	// 在「操作日志」里可通过「YAML 比对」查看。
	PreviousYAML string
}

// AdminAuditSnapshot 把对象渲染成审计快照（YAML），失败时返回空串。
//
// 走 sigs.k8s.io/yaml（按 json 标签序列化），带 `json:"-"` 的字段（users.password /
// users.mfa_secret、helm 仓库口令、集群 agent 密钥）会自动落到快照外。**带 json 标签的
// 密钥字段仍要调用方自己抹掉**（cluster.Config 是 kubeconfig、oauth 的 clientSecret、
// api 密钥账号的 apiKey）：审计日志里绝不能出现密钥。
func AdminAuditSnapshot(value any) string {
	encoded, err := yaml.Marshal(value)
	if err != nil {
		klog.Errorf("failed to encode the audit snapshot: %v", err)
		return ""
	}
	return string(encoded)
}
