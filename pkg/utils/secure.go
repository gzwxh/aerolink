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

// WarnOnDefaultEncryptKey 提醒运维一次：用内置密钥写入的密钥材料
// 在数据库泄露时会立刻失效，以及在轮换 AEROLINK_ENCRYPT_KEY 之后
// 需要重新保存每一份凭据。
func WarnOnDefaultEncryptKey() {
	if common.EncryptKey != "kite-default-encryption-key-change-in-production" {
		return
	}
	defaultKeyWarn.Do(func() {
		klog.Warningf("Storing a secret with the default AEROLINK_ENCRYPT_KEY; anyone with database access can decrypt it. Set AEROLINK_ENCRYPT_KEY and re-save all credentials (SMTP/LDAP/OAuth/cluster configs) afterwards.")
	})
}

// bcryptCost 12 在登录延迟（约 250ms）与离线破解成本之间取平衡；
// 已有哈希仍然可校验，因为 bcrypt 会把 cost 记录在哈希里。
const bcryptCost = 12

func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	return string(bytes), err
}

func CheckPasswordHash(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func EncryptString(input string) (string, error) {
	return EncryptStringWithKey(common.EncryptKey, input)
}

func DecryptString(encrypted string) (string, error) {
	return DecryptStringWithKey(common.EncryptKey, encrypted)
}

// EncryptStringWithKey 用显式指定的密钥加密。供加密密钥
// 轮换使用，以便用新密钥重写密文。
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

// DecryptStringWithKey 解密一个用给定密钥加密的值。
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
