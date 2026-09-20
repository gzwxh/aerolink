package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// DevCORS 返回一个只允许显式配置来源的 CORS 中间件。
// 生产环境中 SPA 与 API 同源提供
// （go:embed），因此完全不需要 CORS 响应头。
//
// 在其它端口上运行 Vite dev server 的开发者可以设置
// CORS_ALLOWED_ORIGINS=http://localhost:5173，以便在本地开发时
// 启用跨域请求。
//
// allowedOrigins 为空时该中间件是空操作——不会发出 CORS
// 响应头，浏览器按同源策略执行。
func DevCORS(allowedOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		o = strings.TrimSpace(o)
		if o != "" {
			allowed[strings.TrimRight(o, "/")] = true
		}
	}

	return func(c *gin.Context) {
		// 快速路径：未配置任何来源 → 不添加 CORS 响应头（生产环境）
		if len(allowed) == 0 {
			c.Next()
			return
		}

		origin := c.Request.Header.Get("Origin")
		if origin == "" || !allowed[origin] {
			c.Next()
			return
		}

		// 只为显式允许的来源设置 CORS 响应头
		c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers",
			"Content-Type, Authorization, X-Cluster-Name")
		c.Writer.Header().Set("Access-Control-Allow-Methods",
			"GET, POST, PUT, DELETE, PATCH, OPTIONS")
		c.Writer.Header().Set("Access-Control-Max-Age", "86400")
		// 添加 Vary，避免缓存/CDN 返回带有错误来源的响应
		c.Writer.Header().Add("Vary", "Origin")

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
