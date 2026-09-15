package common

import (
	"testing"
)

// The escape hatch exists so local development can keep using the built-in
// keys; everything else must be rejected (that path is a klog.Fatalf and is
// therefore verified through the running binary rather than a unit test).
func TestLoadEnvsAllowsShortJWTSecretOnlyWithEscapeHatch(t *testing.T) {
	previousSecret := JwtSecret
	previousAllow := AllowInsecureSecrets
	t.Cleanup(func() {
		JwtSecret = previousSecret
		AllowInsecureSecrets = previousAllow
	})

	t.Setenv("KITE_ALLOW_INSECURE_SECRETS", "true")
	t.Setenv("KITE_ENCRYPT_KEY", "short-key")
	t.Setenv("KITE_REQUIRE_ENCRYPT_KEY", "")
	t.Setenv("JWT_SECRET", "short")
	LoadEnvs()

	if JwtSecret != "short" {
		t.Fatalf("JwtSecret = %q, want %q", JwtSecret, "short")
	}
	if !AllowInsecureSecrets {
		t.Fatal("AllowInsecureSecrets should follow KITE_ALLOW_INSECURE_SECRETS")
	}
	if KiteEncryptKey != "short-key" {
		t.Fatalf("KiteEncryptKey = %q, want %q", KiteEncryptKey, "short-key")
	}
}
