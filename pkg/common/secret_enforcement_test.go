package common

import (
	"testing"
)

// 该逃生开关的存在是为了让本地开发能继续使用内置
// 密钥；其它情况必须被拒绝（那条路径会 klog.Fatalf，
// 因此通过运行二进制来验证，而不是用单元测试）。
func TestLoadEnvsAllowsShortJWTSecretOnlyWithEscapeHatch(t *testing.T) {
	previousSecret := JwtSecret
	previousAllow := AllowInsecureSecrets
	t.Cleanup(func() {
		JwtSecret = previousSecret
		AllowInsecureSecrets = previousAllow
	})

	t.Setenv("AEROLINK_ALLOW_INSECURE_SECRETS", "true")
	t.Setenv("AEROLINK_ENCRYPT_KEY", "short-key")
	t.Setenv("AEROLINK_REQUIRE_ENCRYPT_KEY", "")
	t.Setenv("JWT_SECRET", "short")
	LoadEnvs()

	if JwtSecret != "short" {
		t.Fatalf("JwtSecret = %q, want %q", JwtSecret, "short")
	}
	if !AllowInsecureSecrets {
		t.Fatal("AllowInsecureSecrets should follow AEROLINK_ALLOW_INSECURE_SECRETS")
	}
	if KiteEncryptKey != "short-key" {
		t.Fatalf("KiteEncryptKey = %q, want %q", KiteEncryptKey, "short-key")
	}
}
