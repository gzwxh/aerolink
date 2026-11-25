package middleware

import (
	"net/http"
	"strings"

	"aerolink/pkg/common"
	"github.com/gin-gonic/gin"
)

// guardedHTTPSPrefixes 是承载凭据、泄露后能直接冒用身份的接口。
//
// 探针与 SPA 静态资源刻意不在其列：`/healthz` 常被 kubelet 以 http 直连探活，
// SPA 的入口页也不带任何秘密。把它们一起收紧只会让 Pod 起不来、页面打不开，
// 换不到安全收益。
var guardedHTTPSPrefixes = []string{
	"/api/auth/login",
	"/api/users/me/password",
	"/api/v1/admin",
}

// RequireHTTPS 是入口一致性闸：`HOST` 配成 `https://` 之后，上面的接口只接受
// 「本次请求自带 TLS」或「入口透传 `X-Forwarded-Proto: https`」的访问。
//
// 它堵的是配置错：证书配好了、却还有人用 http 绕过入口（或直连后端）时，应用层
// 看不出来，口令与会话令牌会明文过网；这条闸门让这类请求当场返回 400。能直连
// 后端的攻击者本就能自己伪造这个头，那种场景只能靠网络策略解决。
//
// `HOST` 不是 `https://` 时整条闸门关闭，纯 HTTP 部署不受影响。
func RequireHTTPS() gin.HandlerFunc {
	enabled := strings.HasPrefix(strings.ToLower(strings.TrimSpace(common.Host)), "https://")
	return requireHTTPS(enabled, common.Base)
}

// requireHTTPS 把开关与 base path 显式传进来，便于单测覆盖 `BASE` 前缀。
func requireHTTPS(enabled bool, base string) gin.HandlerFunc {
	prefixes := make([]string, 0, len(guardedHTTPSPrefixes))
	for _, p := range guardedHTTPSPrefixes {
		prefixes = append(prefixes, base+p)
	}

	return func(c *gin.Context) {
		if !enabled || isSecureEntry(c) || !hasAnyPrefix(c.Request.URL.Path, prefixes) {
			c.Next()
			return
		}
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
			"code":  "https_required",
			"error": "This endpoint must be accessed over HTTPS",
		})
	}
}

// isSecureEntry 与 setCookieSecure、agent 回连判定的口径保持一致：本方 TLS，
// 或入口透传的 X-Forwarded-Proto。多级代理可能给出 "https, http"，取第一段。
func isSecureEntry(c *gin.Context) bool {
	if c.Request.TLS != nil {
		return true
	}
	proto := c.GetHeader("X-Forwarded-Proto")
	if idx := strings.Index(proto, ","); idx >= 0 {
		proto = proto[:idx]
	}
	return strings.EqualFold(strings.TrimSpace(proto), "https")
}

// hasAnyPrefix 按路径段边界匹配，避免 `/api/v1/admin` 命中 `/api/v1/adminx`。
func hasAnyPrefix(path string, prefixes []string) bool {
	for _, p := range prefixes {
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}
