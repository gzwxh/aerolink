package main

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/middleware"
	"github.com/gzwxh/aerolink/pkg/utils"
)

//go:embed static
var staticFiles embed.FS

func setupStatic(r *gin.Engine) {
	base := common.Base
	if base != "" && base != "/" {
		r.GET("/", func(c *gin.Context) {
			c.Redirect(http.StatusFound, base+"/")
		})
	}

	assetsFS, err := fs.Sub(staticFiles, "static/assets")
	if err != nil {
		panic(err)
	}

	assetsGroup := r.Group(base + "/assets")
	assetsGroup.Use(middleware.StaticCache())
	assetsGroup.StaticFS("/", http.FS(assetsFS))

	// 运行时 base path 以同源外部脚本的形式发布，
	// 使严格的 CSP（script-src 'self'）依然可用；在
	// index.html 里用内联脚本会被浏览器拦截。
	r.GET(base+"/config.js", func(c *gin.Context) {
		assetBase := common.Base
		if assetBase == "/" {
			assetBase = ""
		}
		c.Header("Content-Type", "application/javascript; charset=utf-8")
		c.Header("Cache-Control", "no-store")
		c.String(http.StatusOK, utils.ConfigScript(assetBase))
	})

	r.NoRoute(func(c *gin.Context) {
		path := c.Request.URL.Path
		if len(path) >= len(base)+5 && path[len(base):len(base)+5] == "/api/" {
			c.JSON(http.StatusNotFound, gin.H{"error": "API endpoint not found"})
			return
		}

		// /assets/ 下找不到的文件必须给 404，**不能**回落成 index.html：
		// 那些是带 hash 的产物，旧版本的文件在新构建里会被清掉，而用户浏览器
		// 仍可能按缓存里的旧 index.html 去引用它们。此时若返回 HTML，
		// 浏览器会把 HTML 当 JS/CSS 解析并直接报语法错误（白屏）；
		// 返回 404 才是明确的失败，加载方据此能提示用户刷新。
		if strings.HasPrefix(path, base+"/assets/") {
			c.Status(http.StatusNotFound)
			return
		}

		content, err := staticFiles.ReadFile("static/index.html")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read index.html"})
			return
		}

		htmlContent := utils.InjectAssetBase(string(content), base)

		// 入口 HTML 绝不能长期缓存：它引用的是带 hash 的产物文件名，
		// 一旦被浏览器缓存住，发布新版本后用户仍会加载旧的 JS/CSS——
		// 表现就是「界面里没有新功能 / 设置不生效」，而服务端一切正常。
		// 带 hash 的 /assets/* 仍然由 StaticCache 下发 immutable，不受影响。
		c.Header("Cache-Control", "no-cache")
		c.Header("Content-Type", "text/html; charset=utf-8")
		c.String(http.StatusOK, htmlContent)
	})
}
