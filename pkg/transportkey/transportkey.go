// Package transportkey 提供请求体敏感字段的加密通道：前端用服务端公钥加密，服务端用
// 私钥解密。
//
// 它**不是** TLS 的替代品：没有 TLS 时中间人仍可转发或重放整段请求。它的作用只是
// 降低 TLS 之外那些链路的明文暴露面——反向代理/WAF 的访问日志、APM 抓包留存、浏览器
// 扩展、以及把入口误配成 http 的部署。
package transportkey

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"aerolink/pkg/common"
	"k8s.io/klog/v2"
)

const (
	// Alg 是浏览器 WebCrypto 与 crypto/rsa 都支持的算法标识。
	Alg = "RSA-OAEP-256"
	// MaxAge 是可接受的载荷时间偏差（秒）。超出窗口的密文一律拒绝，避免一次抓包
	// 之后无限期复用同一份密文。
	MaxAge = 300
	// keyBits 取 3072：OAEP-SHA256 下可加密 318 字节，够覆盖策略允许的最长口令。
	keyBits = 3072

	// CodeDecryptFailed 是解密失败时返回给前端的机器可读错误码。
	CodeDecryptFailed = "credential_decrypt_failed"
	// CodeCredentialRequired 是强制模式下收到明文凭据时返回的错误码。
	CodeCredentialRequired = "encrypted_credential_required"
)

// ErrDecryptFailed 是「密文不可用」的统一错误：不区分密钥不对、过期、被篡改，
// 避免把内部状态暴露给调用方。
var ErrDecryptFailed = errors.New("invalid encrypted credential")

// payload 是密文解开后的内容。ts 用于限制重放窗口；fields 是字段名到明文的映射。
type payload struct {
	V      int               `json:"v"`
	TS     int64             `json:"ts"`
	Fields map[string]string `json:"fields"`
}

// PublicKey 是 GET /api/v1/transport-key 的响应体。
type PublicKey struct {
	KeyID     string `json:"key_id"`
	Alg       string `json:"alg"`
	PublicKey string `json:"public_key"`
	MaxAge    int    `json:"max_age"`
}

// Cipher 持有服务端的密钥对。多副本部署必须让所有副本读到同一份私钥，
// 否则请求落到另一个副本时解不开（见 Load 的路径说明）。
type Cipher struct {
	private   *rsa.PrivateKey
	publicDER []byte
	keyID     string
	ephemeral bool
}

var (
	loadOnce sync.Once
	current  *Cipher
)

// Default 返回进程级单例。私钥读取失败时退回临时密钥并告警：登录不应该因为一个
// 落盘问题直接不可用，但重启后旧公钥加密的载荷会解不开（前端每次提交都重新取公钥）。
func Default() *Cipher {
	loadOnce.Do(func() {
		cipher, err := Load()
		if err != nil {
			klog.Warningf("transport key unavailable, falling back to an ephemeral key pair: %v", err)
			cipher = newEphemeral()
		}
		current = cipher
	})
	return current
}

// Load 读取（不存在则生成）RSA 密钥对。
//
// 私钥来源优先级：
//  1. AEROLINK_TRANSPORT_PRIVATE_KEY（PEM 文本，便于从 Secret 注入）；
//  2. AEROLINK_TRANSPORT_KEY_PATH 指向的文件；
//  3. 默认路径 data/transport-key.pem（与 README 的 /app/data 卷一致）。
func Load() (*Cipher, error) {
	if inline := strings.TrimSpace(common.Getenv("TRANSPORT_PRIVATE_KEY")); inline != "" {
		key, err := parsePrivateKey([]byte(inline))
		if err != nil {
			return nil, fmt.Errorf("parsing AEROLINK_TRANSPORT_PRIVATE_KEY: %w", err)
		}
		return newCipher(key), nil
	}

	path := strings.TrimSpace(common.Getenv("TRANSPORT_KEY_PATH"))
	if path == "" {
		path = filepath.Join("data", "transport-key.pem")
	}

	if raw, err := os.ReadFile(path); err == nil {
		key, err := parsePrivateKey(raw)
		if err != nil {
			return nil, fmt.Errorf("parsing transport key %s: %w", path, err)
		}
		return newCipher(key), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("reading transport key %s: %w", path, err)
	}

	key, err := rsa.GenerateKey(rand.Reader, keyBits)
	if err != nil {
		return nil, err
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("creating %s: %w", dir, err)
		}
	}
	encoded := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: mustPKCS8(key),
	})
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		return nil, fmt.Errorf("writing transport key %s: %w", path, err)
	}
	klog.Infof("generated a transport key pair at %s", path)
	return newCipher(key), nil
}

func newEphemeral() *Cipher {
	key, err := rsa.GenerateKey(rand.Reader, keyBits)
	if err != nil {
		// 密钥生成失败属于系统级故障（熵源不可用），此时无法提供登录通道。
		panic(fmt.Sprintf("generating transport key: %v", err))
	}
	cipher := newCipher(key)
	cipher.ephemeral = true
	return cipher
}

func newCipher(key *rsa.PrivateKey) *Cipher {
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		panic(fmt.Sprintf("marshaling transport public key: %v", err))
	}
	sum := sha256.Sum256(der)
	return &Cipher{
		private:   key,
		publicDER: der,
		keyID:     hex.EncodeToString(sum[:8]),
	}
}

func mustPKCS8(key *rsa.PrivateKey) []byte {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		panic(fmt.Sprintf("marshaling transport private key: %v", err))
	}
	return der
}

func parsePrivateKey(raw []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("not an RSA private key")
		}
		return rsaKey, nil
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	return nil, errors.New("unsupported private key format")
}

// Public 返回下发给浏览器的公钥信息（不含私钥）。
func (c *Cipher) Public() PublicKey {
	return PublicKey{
		KeyID:     c.keyID,
		Alg:       Alg,
		PublicKey: base64.StdEncoding.EncodeToString(c.publicDER),
		MaxAge:    MaxAge,
	}
}

// EncryptFields 用公钥加密一组字段，返回标准 base64 密文。
// 服务端不消费它：给测试与冒烟工具用（见 tools/apismoke）。
func (c *Cipher) EncryptFields(fields map[string]string) (string, error) {
	return EncryptFieldsWithPublicKey(&c.private.PublicKey, fields)
}

// EncryptFieldsWithPublicKey 用公钥把字段打成短字段密文，载荷格式与 EncryptFields
// 完全一致；供不在服务端的调用方（冒烟工具、e2e）照着 GET /api/v1/transport-key
// 下发的公钥加密。
func EncryptFieldsWithPublicKey(pub *rsa.PublicKey, fields map[string]string) (string, error) {
	body, err := json.Marshal(payload{V: 1, TS: time.Now().Unix(), Fields: fields})
	if err != nil {
		return "", err
	}
	encrypted, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, body, nil)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(encrypted), nil
}

// ParsePublicKey 把 PublicKey.PublicKey 那一串 base64（DER/SPKI）解成可加密的公钥。
func ParsePublicKey(encoded string) (*rsa.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, ErrDecryptFailed
	}
	return pub, nil
}

// DecryptField 解开单个字段的密文。
func (c *Cipher) DecryptField(token string) (string, error) {
	fields, err := c.DecryptFields(token)
	if err != nil {
		return "", err
	}
	if len(fields) != 1 {
		return "", ErrDecryptFailed
	}
	for _, value := range fields {
		return value, nil
	}
	return "", ErrDecryptFailed
}

// DecryptFields 解开一份密文载荷并校验重放窗口。
func (c *Cipher) DecryptFields(token string) (map[string]string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(token))
	if err != nil {
		return nil, ErrDecryptFailed
	}
	body, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, c.private, raw, nil)
	if err != nil {
		return nil, ErrDecryptFailed
	}
	var decoded payload
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, ErrDecryptFailed
	}
	if decoded.V != 1 || len(decoded.Fields) == 0 {
		return nil, ErrDecryptFailed
	}
	if skew := time.Since(time.Unix(decoded.TS, 0)); skew > MaxAge*time.Second || skew < -MaxAge*time.Second {
		return nil, ErrDecryptFailed
	}
	return decoded.Fields, nil
}

// DecryptField 是包级快捷方式，供 handler 使用。
func DecryptField(token string) (string, error) {
	return Default().DecryptField(token)
}
