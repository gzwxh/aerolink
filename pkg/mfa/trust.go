package mfa

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

// TrustCookieName marks the browser as recently MFA verified. The window is the
// "MFA verification validity" (seconds) from the security settings.
const TrustCookieName = "kite_mfa_trust"

const defaultTrustTTL = 60 * time.Second

// TrustTTL is how long a successful MFA verification is remembered for a browser.
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

// MarkTrusted remembers a successful MFA verification for this browser.
func MarkTrusted(c *gin.Context, userID uint) {
	ttl := TrustTTL()
	expiresAt := time.Now().Add(ttl).Unix()
	value := strconv.FormatInt(expiresAt, 10) + ":" + signTrust(userID, expiresAt)
	secure := c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(TrustCookieName, value, int(ttl.Seconds()), "/", "", secure, true)
}

// ClearTrusted drops the trusted browser marker.
func ClearTrusted(c *gin.Context) {
	secure := c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(TrustCookieName, "", -1, "/", "", secure, true)
}

// IsTrusted reports whether this browser verified an MFA code for the user
// within the validity window.
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
