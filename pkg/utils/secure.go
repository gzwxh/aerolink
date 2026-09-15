package utils

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"sync"

	"github.com/zxh326/kite/pkg/common"
	"golang.org/x/crypto/bcrypt"
	"k8s.io/klog/v2"
)

var defaultKeyWarn sync.Once

// WarnOnDefaultEncryptKey reminds operators once that secrets written with the
// built-in key are compromised as soon as the database leaks, and that
// re-saving every credential is required after rotating KITE_ENCRYPT_KEY.
func WarnOnDefaultEncryptKey() {
	if common.KiteEncryptKey != "kite-default-encryption-key-change-in-production" {
		return
	}
	defaultKeyWarn.Do(func() {
		klog.Warningf("Storing a secret with the default KITE_ENCRYPT_KEY; anyone with database access can decrypt it. Set KITE_ENCRYPT_KEY and re-save all credentials (SMTP/LDAP/OAuth/cluster configs) afterwards.")
	})
}

// bcryptCost 12 balances login latency (~250ms) against offline cracking cost;
// existing hashes stay verifiable because bcrypt records the cost in its hash.
const bcryptCost = 12

func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	return string(bytes), err
}

func CheckPasswordHash(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func EncryptString(input string) (string, error) {
	return EncryptStringWithKey(common.KiteEncryptKey, input)
}

func DecryptString(encrypted string) (string, error) {
	return DecryptStringWithKey(common.KiteEncryptKey, encrypted)
}

// EncryptStringWithKey encrypts with an explicit key. Used by the encryption
// key rotation so ciphertext can be rewritten with the new key.
func EncryptStringWithKey(key string, input string) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(input), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// DecryptStringWithKey decrypts a value that was encrypted with the given key.
func DecryptStringWithKey(key string, encrypted string) (string, error) {
	ciphertext, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		return "", fmt.Errorf("failed to decode base64: %w", err)
	}

	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("failed to decrypt: %w", err)
	}
	return string(plaintext), nil
}

func newGCM(key string) (cipher.AEAD, error) {
	keyHash := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(keyHash[:])
	if err != nil {
		return nil, fmt.Errorf("failed to create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM: %w", err)
	}
	return gcm, nil
}
