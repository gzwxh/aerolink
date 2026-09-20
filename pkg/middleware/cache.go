package middleware

import (
	"github.com/gin-gonic/gin"
)

// StaticCache 为静态资源添加 cache-control 响应头
func StaticCache() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
		c.Next()
	}
}
