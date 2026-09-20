package middleware

import (
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
)

// SecurityHeaders 补齐 SPA 此前缺少的基线加固响应头。
// 它们开销很小，且对每个响应都生效，包括 API。
//
// 如果某个部署把 Kite 嵌在其它需要更宽松策略的资源之后，
// 可以用 KITE_DISABLE_CSP=true 关闭严格的 CSP。
func SecurityHeaders() gin.HandlerFunc {
	cspDisabled := strings.EqualFold(strings.TrimSpace(os.Getenv("KITE_DISABLE_CSP")), "true")
	// SPA 自带打包产物，使用内联样式与 blob worker
	// （Monaco/xterm）；其它一律锁定。运行时 base path 以
	// 同源的 config.js 提供，因此不需要内联脚本。
	const csp = "default-src 'self'; " +
		"script-src 'self'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; " +
		"font-src 'self' data:; " +
		"connect-src 'self' ws: wss:; " +
		"worker-src 'self' blob:; " +
		"object-src 'none'; " +
		"base-uri 'self'; " +
		"frame-ancestors 'none'"
	// 可选的统计脚本从 Umami 云端加载；只在启用统计时
	// 允许它。
	cspWithAnalytics := strings.Replace(csp, "script-src 'self';", "script-src 'self' https://cloud.umami.is;", 1)

	return func(c *gin.Context) {
		header := c.Writer.Header()
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("X-Frame-Options", "DENY")
		header.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if !cspDisabled {
			if common.EnableAnalytics.Load() {
				header.Set("Content-Security-Policy", cspWithAnalytics)
			} else {
				header.Set("Content-Security-Policy", csp)
			}
		}
		// 只在 TLS 下有意义；其它情况下无副作用。
		if c.Request.TLS != nil || strings.EqualFold(c.Request.Header.Get("X-Forwarded-Proto"), "https") {
			header.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		c.Next()
	}
}
