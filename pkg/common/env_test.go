package common

import (
	"os"
	"testing"
)

// 这些探针名只在本文件里用：测试必须能确定目标变量确实不存在，
// 所以不与任何真实配置项共用名字。
const probeSuffix = "TEST_PROBE"

func TestGetenvReadsPrefixedVariable(t *testing.T) {
	t.Setenv(EnvPrefix+probeSuffix, "value")

	if got := Getenv(probeSuffix); got != "value" {
		t.Fatalf("Getenv() = %q, want the prefixed value %q", got, "value")
	}
}

// 旧前缀是硬切掉的：清单/Secret 里还写着 KITE_* 的实例必须改成 AEROLINK_*，
// 否则读到的就是空值（对密钥类变量是 fail-fast，不会静默用错值）。
func TestGetenvIgnoresLegacyPrefix(t *testing.T) {
	_ = os.Unsetenv(EnvPrefix + probeSuffix)
	t.Setenv("KITE_"+probeSuffix, "legacy")

	if got := Getenv(probeSuffix); got != "" {
		t.Fatalf("Getenv() = %q, want empty because the KITE_ prefix is no longer read", got)
	}
}

func TestGetenvUnsetReturnsEmpty(t *testing.T) {
	_ = os.Unsetenv(EnvPrefix + probeSuffix)

	if got := Getenv(probeSuffix); got != "" {
		t.Fatalf("Getenv() = %q, want empty for an unset variable", got)
	}
}
