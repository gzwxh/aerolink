package transportkey

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"time"
)

const (
	// EnvelopeAlg 是长文本请求体信封的算法标识：RSA-OAEP 包封会话密钥，正文
	// AES-256-CTR 加密 + HMAC-SHA256 认证（encrypt-then-MAC）。
	//
	// 不用 AES-GCM 是因为前端在非安全上下文（http://内网IP）没有 WebCrypto，
	// 纯 JS 回退里 GHASH 比 HMAC 难写得多，而 SHA-256 已经实现并有测试覆盖。
	EnvelopeAlg = "RSA-OAEP-256+AES-256-CTR-HMAC-SHA256"
	// CodePayloadInvalid 是信封解不开时返回给前端的机器可读错误码。
	CodePayloadInvalid = "encrypted_payload_invalid"

	sessionKeyBytes = 64 // 32 字节 AES 密钥 + 32 字节 HMAC 密钥
	envelopeIVBytes = 16
	envelopeMACSize = 32
)

// Envelope 是请求体 `{"enc": …}` 的结构。只有 key_id 与算法标识在外面，正文与
// 时间戳都在 MAC 保护范围内。
type Envelope struct {
	V          int    `json:"v"`
	KeyID      string `json:"key_id"`
	Alg        string `json:"alg"`
	WrappedKey string `json:"wrapped_key"`
	IV         string `json:"iv"`
	Data       string `json:"data"`
	MAC        string `json:"mac"`
}

// envelopePayload 是信封里的明文。ts 用来限制重放窗口，body 是原始的 JSON 请求体。
type envelopePayload struct {
	TS   int64           `json:"ts"`
	Body json.RawMessage `json:"body"`
}

func envelopeMAC(key, iv, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(iv)
	mac.Write(data)
	return mac.Sum(nil)
}

// EncryptEnvelopeBody 把一段 JSON 请求体封成信封。服务端平时不用它（前端负责加密），
// 给测试与 tools/apismoke 用。
func (c *Cipher) EncryptEnvelopeBody(body []byte) (Envelope, error) {
	return c.encryptEnvelopeBody(body, time.Now().Unix())
}

func (c *Cipher) encryptEnvelopeBody(body []byte, ts int64) (Envelope, error) {
	sessionKey := make([]byte, sessionKeyBytes)
	if _, err := rand.Read(sessionKey); err != nil {
		return Envelope{}, err
	}
	iv := make([]byte, envelopeIVBytes)
	if _, err := rand.Read(iv); err != nil {
		return Envelope{}, err
	}

	plaintext, err := json.Marshal(envelopePayload{TS: ts, Body: body})
	if err != nil {
		return Envelope{}, err
	}
	block, err := aes.NewCipher(sessionKey[:32])
	if err != nil {
		return Envelope{}, err
	}
	data := make([]byte, len(plaintext))
	cipher.NewCTR(block, iv).XORKeyStream(data, plaintext)

	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, &c.private.PublicKey, sessionKey, nil)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{
		V:          1,
		KeyID:      c.keyID,
		Alg:        EnvelopeAlg,
		WrappedKey: base64.StdEncoding.EncodeToString(wrapped),
		IV:         base64.StdEncoding.EncodeToString(iv),
		Data:       base64.StdEncoding.EncodeToString(data),
		MAC:        base64.StdEncoding.EncodeToString(envelopeMAC(sessionKey[32:], iv, data)),
	}, nil
}

// OpenEnvelope 验证并解开信封，返回原始的 JSON 请求体。
func (c *Cipher) OpenEnvelope(envelope Envelope) ([]byte, error) {
	if envelope.V != 1 {
		return nil, ErrDecryptFailed
	}
	wrapped, err := base64.StdEncoding.DecodeString(envelope.WrappedKey)
	if err != nil {
		return nil, ErrDecryptFailed
	}
	iv, err := base64.StdEncoding.DecodeString(envelope.IV)
	if err != nil || len(iv) != envelopeIVBytes {
		return nil, ErrDecryptFailed
	}
	data, err := base64.StdEncoding.DecodeString(envelope.Data)
	if err != nil {
		return nil, ErrDecryptFailed
	}
	presentedMAC, err := base64.StdEncoding.DecodeString(envelope.MAC)
	if err != nil || len(presentedMAC) != envelopeMACSize {
		return nil, ErrDecryptFailed
	}

	sessionKey, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, c.private, wrapped, nil)
	if err != nil || len(sessionKey) != sessionKeyBytes {
		return nil, ErrDecryptFailed
	}
	// 先验 MAC 再解密：被篡改的密文不会进入 AES，也不会产生可观测的差异。
	if !hmac.Equal(envelopeMAC(sessionKey[32:], iv, data), presentedMAC) {
		return nil, ErrDecryptFailed
	}

	block, err := aes.NewCipher(sessionKey[:32])
	if err != nil {
		return nil, ErrDecryptFailed
	}
	plaintext := make([]byte, len(data))
	cipher.NewCTR(block, iv).XORKeyStream(plaintext, data)

	var decoded envelopePayload
	if err := json.Unmarshal(plaintext, &decoded); err != nil || len(decoded.Body) == 0 {
		return nil, ErrDecryptFailed
	}
	if skew := time.Since(time.Unix(decoded.TS, 0)); skew > MaxAge*time.Second || skew < -MaxAge*time.Second {
		return nil, ErrDecryptFailed
	}
	return decoded.Body, nil
}

// OpenEnvelopeBody 是包级快捷方式。
func OpenEnvelopeBody(envelope Envelope) ([]byte, error) {
	return Default().OpenEnvelope(envelope)
}
