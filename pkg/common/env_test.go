package common

import (
	"os"
	"testing"
)

// 这些探针名只在本文件里用：Getenv 的兜底是全局行为，测试必须能确定目标变量
// 确实不存在，所以不与任何真实配置项共用名字。
const probeSuffix = "TEST_PROBE"

func TestGetenvPrefersNewPrefix(t *testing.T) {
	legacy := legacyEnvPrefix + probeSuffix
	t.Setenv(EnvPrefix+probeSuffix, "new")
	t.Setenv(legacy, "legacy")

	if got := Getenv(probeSuffix); got != "new" {
		t.Fatalf("Getenv() = %q, want the new-prefix value %q", got, "new")
	}
}

// 改名不能硬切：旧清单/Secret 里写的是 KITE_*，升级后必须继续能读到。
func TestGetenvFallsBackToLegacyPrefix(t *testing.T) {
	legacy := legacyEnvPrefix + probeSuffix
	// 新名必须"不存在"而不是"为空"：显式设空是新名生效的一种情形，见下一个用例。
	_ = os.Unsetenv(EnvPrefix + probeSuffix)
	t.Setenv(legacy, "legacy")

	if got := Getenv(probeSuffix); got != "legacy" {
		t.Fatalf("Getenv() = %q, want the legacy-prefix value %q", got, "legacy")
	}
}

// 显式设成空的新名以新名为准，不再回落旧名：否则运维把新变量清空后，
// 会静默沿用旧名的值（对密钥类变量来说是最难发现的那种"看起来正常"）。
func TestGetenvExplicitEmptyNewPrefixWins(t *testing.T) {
	legacy := legacyEnvPrefix + probeSuffix
	t.Setenv(EnvPrefix+probeSuffix, "")
	t.Setenv(legacy, "legacy")

	if got := Getenv(probeSuffix); got != "" {
		t.Fatalf("Getenv() = %q, want empty because the new-prefix variable is explicitly set", got)
	}
}

func TestGetenvUnsetReturnsEmpty(t *testing.T) {
	_ = os.Unsetenv(EnvPrefix + probeSuffix)
	_ = os.Unsetenv(legacyEnvPrefix + probeSuffix)

	if got := Getenv(probeSuffix); got != "" {
		t.Fatalf("Getenv() = %q, want empty for an unset variable", got)
	}
}
