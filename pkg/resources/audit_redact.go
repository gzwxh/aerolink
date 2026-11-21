package resources

import (
	"github.com/zxh326/kite/pkg/common"
	syaml "sigs.k8s.io/yaml"
)

// secretRedactedValue 是审计里替代密钥内容的占位值。
const secretRedactedValue = "***REDACTED***"

// redactSecretYAML 把 Secret 的 data / stringData 的**值**换成占位，只保留键名。
//
// 审计需要回答的是「谁在什么时候动了哪个 Secret 的哪些键」，不需要把密钥本身
// 再存一份：资源变更历史整份落在 resourceYaml / previousYaml 里，任何持
// settings.audit 读权限的人都能从列表接口一次拿走（缺陷 D-33）。导出 CSV 本来
// 就剥掉这两列，所以口径统一成「两侧都不留原值」，而不是只堵导出那条路。
//
// 只对 Secret 生效；解析失败时整段替换（fail-closed）——宁可少一份差异细节，
// 也不要把没洗干净的内容写进库。
func redactSecretYAML(resourceType string, text string) string {
	if resourceType != string(common.Secrets) || text == "" {
		return text
	}

	var object map[string]any
	if err := syaml.Unmarshal([]byte(text), &object); err != nil || object == nil {
		return "# 内容已脱敏（Secret，且无法解析以定位敏感字段）\n"
	}

	for _, field := range []string{"data", "stringData"} {
		if values, ok := object[field].(map[string]any); ok {
			for key := range values {
				values[key] = secretRedactedValue
			}
		}
	}

	out, err := syaml.Marshal(object)
	if err != nil {
		return "# 内容已脱敏（Secret）\n"
	}
	return string(out)
}
