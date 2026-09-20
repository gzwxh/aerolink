package utils

import "testing"

func TestEncryptDecryptWithExplicitKey(t *testing.T) {
	const secret = "smtp-password"
	encrypted, err := EncryptStringWithKey("first-key", secret)
	if err != nil {
		t.Fatalf("EncryptStringWithKey() error = %v", err)
	}

	plain, err := DecryptStringWithKey("first-key", encrypted)
	if err != nil {
		t.Fatalf("DecryptStringWithKey() error = %v", err)
	}
	if plain != secret {
		t.Fatalf("round trip = %q, want %q", plain, secret)
	}

	// 另一个密钥必须无法读出该值；这正是静默更换密钥的危险之处，
	// 也是需要迁移的原因。
	if _, err := DecryptStringWithKey("second-key", encrypted); err == nil {
		t.Fatal("decrypting with the wrong key must fail")
	}
}
