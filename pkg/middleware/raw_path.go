package middleware

import (
	"net/url"

	"github.com/gin-gonic/gin"
)

// ConfigureRawPathRouting 让转义后的斜杠保留在同一个路由参数内，并用路径语义对参数只解码一次。
func ConfigureRawPathRouting(r *gin.Engine) {
	r.UseRawPath = true
	r.UnescapePathValues = false
	r.Use(func(c *gin.Context) {
		if c.Request.URL.RawPath != "" {
			for i := range c.Params {
				if decoded, err := url.PathUnescape(c.Params[i].Value); err == nil {
					c.Params[i].Value = decoded
				}
			}
		}
	})
}
