package mfa

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
)

// TrustCookieName 把该浏览器标记为最近已完成 MFA 验证。时间窗来自安全
// 设置中的 "MFA verification validity"（秒）。
const TrustCookieName = "aerolink_mfa_trust"

const defaultTrustTTL = 60 * time.Second

// TrustTTL 是某个浏览器的一次成功 MFA 验证会被记住多久。
func TrustTTL() time.Duration {
	if model.DB == nil {
		return defaultTrustTTL
	}
	setting, err := model.GetSecuritySetting()
	if err != nil || setting == nil || setting.MFAVerifyTTLSeconds <= 0 {
		return defaultTrustTTL
	}
	return time.Duration(setting.MFAVerifyTTLSeconds) * time.Second
}

func signTrust(userID uint, expiresAt int64) string {
	mac := hmac.New(sha256.New, []byte(common.JwtSecret))
	mac.Write([]byte(strconv.FormatUint(uint64(userID), 10) + ":" + strconv.FormatInt(expiresAt, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// MarkTrusted 为该浏览器记住一次成功的 MFA 验证。
func MarkTrusted(c *gin.Context, userID uint) {
	ttl := TrustTTL()
	expiresAt := time.Now().Add(ttl).Unix()
	value := strconv.FormatInt(expiresAt, 10) + ":" + signTrust(userID, expiresAt)
	secure := c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(TrustCookieName, value, int(ttl.Seconds()), "/", "", secure, true)
}

// ClearTrusted 清除受信任浏览器的标记。
func ClearTrusted(c *gin.Context) {
	secure := c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(TrustCookieName, "", -1, "/", "", secure, true)
}

// IsTrusted 报告该浏览器是否在有效期内为该用户
// 验证过一次 MFA 码。
func IsTrusted(c *gin.Context, userID uint) bool {
	raw, err := c.Cookie(TrustCookieName)
	if err != nil || raw == "" {
		return false
	}
	expiresPart, signature, ok := strings.Cut(raw, ":")
	if !ok {
		return false
	}
	expiresAt, err := strconv.ParseInt(expiresPart, 10, 64)
	if err != nil || time.Now().Unix() > expiresAt {
		return false
	}
	return hmac.Equal([]byte(signTrust(userID, expiresAt)), []byte(signature))
}
