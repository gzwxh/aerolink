package middleware

import (
	"strings"

	"aerolink/pkg/common"
	"github.com/gin-gonic/gin"
)

// SecurityHeaders 补齐 SPA 此前缺少的基线加固响应头。
// 它们开销很小，且对每个响应都生效，包括 API。
//
// 如果某个部署把鸢联 AeroLink 嵌在其它需要更宽松策略的资源之后，
// 可以用 AEROLINK_DISABLE_CSP=true 关闭严格的 CSP。
func SecurityHeaders() gin.HandlerFunc {
	cspDisabled := strings.EqualFold(strings.TrimSpace(common.Getenv("DISABLE_CSP")), "true")
	// SPA 自带打包产物，使用内联样式与 blob worker
	// （Monaco/xterm）；其它一律锁定。运行时 base path 以
	// 同源的 config.js 提供，因此不需要内联脚本。
	//
	// img-src 额外按协议放行外部图片：头像是用户自填的外链，OIDC 身份源下发的
	// picture 同样是外链，来源无法预先枚举。收紧成 'self' 会让头像静默回落到
	// 首字母占位（图片请求被浏览器拦截），所以这里保留 http/https。
	// 本分支不含任何统计/上报功能，因此第三方来源一律不放行（script-src 与
	// connect-src 都只放行 'self'）。将来若确有必要引入外部脚本或上报端点，必须在
	// 这里同步放行对应来源，而不是绕过这条约束。
	const csp = "default-src 'self'; " +
		"script-src 'self'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob: https: http:; " +
		"font-src 'self' data:; " +
		"connect-src 'self' ws: wss:; " +
		"worker-src 'self' blob:; " +
		"object-src 'none'; " +
		"base-uri 'self'; " +
		"frame-ancestors 'none'"

	return func(c *gin.Context) {
		header := c.Writer.Header()
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("X-Frame-Options", "DENY")
		header.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if !cspDisabled {
			header.Set("Content-Security-Policy", csp)
		}
		// 只在 TLS 下有意义；其它情况下无副作用。
		if c.Request.TLS != nil || strings.EqualFold(c.Request.Header.Get("X-Forwarded-Proto"), "https") {
			header.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		c.Next()
	}
}
