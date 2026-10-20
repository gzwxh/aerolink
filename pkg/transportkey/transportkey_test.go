package transportkey

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func testCipher(t *testing.T) *Cipher {
	t.Helper()
	// 测试用 2048 位：密钥生成快，且覆盖的载荷远小于 OAEP 上限。
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generating test key: %v", err)
	}
	return newCipher(key)
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	cipher := testCipher(t)

	token, err := cipher.EncryptFields(map[string]string{"password": "p@ssw0rd-中文"})
	if err != nil {
		t.Fatalf("encrypting: %v", err)
	}
	got, err := cipher.DecryptField(token)
	if err != nil {
		t.Fatalf("decrypting: %v", err)
	}
	if got != "p@ssw0rd-中文" {
		t.Fatalf("decrypted = %q, want the original password", got)
	}
}

func TestDecryptRejectsExpiredPayload(t *testing.T) {
	cipher := testCipher(t)

	token := encryptPayload(t, cipher, payload{
		V:      1,
		TS:     time.Now().Add(-MaxAge*time.Second - time.Minute).Unix(),
		Fields: map[string]string{"password": "old"},
	})
	if _, err := cipher.DecryptField(token); err == nil {
		t.Fatal("payload outside the replay window must be rejected")
	}
}

func TestDecryptRejectsTamperedPayload(t *testing.T) {
	cipher := testCipher(t)

	token, err := cipher.EncryptFields(map[string]string{"password": "secret"})
	if err != nil {
		t.Fatalf("encrypting: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		t.Fatalf("decoding: %v", err)
	}
	raw[len(raw)-1] ^= 0xff

	if _, err := cipher.DecryptField(base64.StdEncoding.EncodeToString(raw)); err == nil {
		t.Fatal("tampered ciphertext must be rejected")
	}
}

func TestDecryptRejectsGarbage(t *testing.T) {
	cipher := testCipher(t)

	for _, token := range []string{"", "not-base64!!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if _, err := cipher.DecryptField(token); err == nil {
			t.Fatalf("token %q must be rejected", token)
		}
	}
}

func TestPublicKeyShape(t *testing.T) {
	cipher := testCipher(t)

	public := cipher.Public()
	if public.Alg != Alg || public.MaxAge != MaxAge {
		t.Fatalf("public key metadata = %#v", public)
	}
	if public.KeyID == "" || public.PublicKey == "" {
		t.Fatalf("public key must carry an id and the DER payload: %#v", public)
	}
}

func encryptPayload(t *testing.T, cipher *Cipher, body payload) string {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshaling payload: %v", err)
	}
	encrypted, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, &cipher.private.PublicKey, encoded, nil)
	if err != nil {
		t.Fatalf("encrypting payload: %v", err)
	}
	return base64.StdEncoding.EncodeToString(encrypted)
}

// 工具链只有公钥（GET /api/v1/transport-key 下发的就是它）：apismoke / e2e 用这条路
// 加密凭据，服务端必须能用私钥解开。
func TestEncryptFieldsWithPublicKeyRoundTrip(t *testing.T) {
	cipher := testCipher(t)
	pub, err := ParsePublicKey(cipher.Public().PublicKey)
	if err != nil {
		t.Fatalf("parsing public key: %v", err)
	}
	token, err := EncryptFieldsWithPublicKey(pub, map[string]string{"password": "p@ss-中文"})
	if err != nil {
		t.Fatalf("encrypting with public key: %v", err)
	}
	plain, err := cipher.DecryptField(token)
	if err != nil {
		t.Fatalf("decrypting tool payload: %v", err)
	}
	if plain != "p@ss-中文" {
		t.Fatalf("decrypted credential = %q, want the original", plain)
	}
}
