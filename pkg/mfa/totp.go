package mfa

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"aerolink/pkg/model"
	"github.com/skip2/go-qrcode"
)

const (
	defaultIssuer = "鸢联 AeroLink"
	secretSize    = 20
	step          = 30
	digits        = 6

	// defaultWindow 在无法读取安全策略时使用。
	defaultWindow = 1
)

var base32NoPadding = base32.StdEncoding.WithPadding(base32.NoPadding)

func GenerateSecret() (string, error) {
	buf := make([]byte, secretSize)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base32NoPadding.EncodeToString(buf), nil
}

// Issuer 是认证器 App 中显示的签发者标签，可在安全
// 设置中配置（"OTP issuer name"）。
func Issuer() string {
	if model.DB == nil {
		return defaultIssuer
	}
	setting, err := model.GetSecuritySetting()
	if err != nil || setting == nil {
		return defaultIssuer
	}
	if name := strings.TrimSpace(setting.OTPIssuerName); name != "" {
		return name
	}
	return defaultIssuer
}

// VerifyWindow 是当前步长前后各接受多少个 30 秒步长，
// 在安全设置中配置（"OTP verification window"）。
func VerifyWindow() int {
	if model.DB == nil {
		return defaultWindow
	}
	setting, err := model.GetSecuritySetting()
	if err != nil || setting == nil {
		return defaultWindow
	}
	return setting.OTPVerifyWindow
}

func URL(username string, secret string) string {
	issuer := Issuer()
	label := issuer
	if username != "" {
		label += ":" + username
	}
	params := url.Values{}
	params.Set("secret", secret)
	params.Set("issuer", issuer)
	return "otpauth://totp/" + url.PathEscape(label) + "?" + params.Encode()
}

func QRCodeDataURL(value string) (string, error) {
	png, err := qrcode.Encode(value, qrcode.Medium, 192)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

func Verify(secret string, code string) bool {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != digits {
		return false
	}
	if _, err := strconv.Atoi(code); err != nil {
		return false
	}

	counter := time.Now().Unix() / step
	window := int64(VerifyWindow())
	for offset := -window; offset <= window; offset++ {
		if generateCode(secret, uint64(counter+offset)) == code {
			return true
		}
	}
	return false
}

func generateCode(secret string, counter uint64) string {
	key, err := base32NoPadding.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return ""
	}

	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)

	hash := hmac.New(sha1.New, key)
	_, _ = hash.Write(msg[:])
	sum := hash.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1000000)
}
