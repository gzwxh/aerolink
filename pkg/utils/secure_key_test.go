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

	// A different key must not be able to read the value; this is what makes a
	// silent key change dangerous and why the migration exists.
	if _, err := DecryptStringWithKey("second-key", encrypted); err == nil {
		t.Fatal("decrypting with the wrong key must fail")
	}
}
