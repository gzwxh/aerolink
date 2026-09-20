package utils

import (
	"fmt"
	"html"
	"regexp"
	"strings"

	"k8s.io/apimachinery/pkg/util/rand"
)

const kiteBasePlaceholder = "__KITE_BASE__"

func InjectKiteBase(htmlContent string, base string) string {
	assetBase := base
	if assetBase == "/" {
		assetBase = ""
	}

	htmlContent = strings.ReplaceAll(htmlContent, kiteBasePlaceholder, html.EscapeString(assetBase))

	// 运行时 base 必须在 SPA 的打包产物执行之前送达。它不能是
	// 内联 <script>：服务端下发的 Content-Security-Policy 是
	// script-src 'self'，会阻止内联执行。因此它以同源的
	// 外部文件形式在 {base}/config.js 提供（见 setupStatic）。
	baseScript := fmt.Sprintf(`<script src="%s/config.js"></script>`, html.EscapeString(assetBase))
	re := regexp.MustCompile(`<head>`)
	return re.ReplaceAllString(htmlContent, "<head>\n    "+baseScript)
}

// ConfigScript 渲染外部 config.js 的内容，把运行时 base path 发布给
// SPA（window.__dynamic_base__）。取值就是资源 base
// （"." 语义已由调用方解析）：根路径下为 ""，
// 否则为配置的子路径。
func ConfigScript(assetBase string) string {
	return fmt.Sprintf(`window.__dynamic_base__=%q;`, assetBase)
}

func RandomString(length int) string {
	return rand.String(length)
}

func ToEnvName(input string) string {
	s := input
	s = strings.ReplaceAll(s, "-", "_")
	s = strings.ReplaceAll(s, ".", "_")
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ToUpper(s)
	return s
}

func GetImageRegistryAndRepo(image string) (string, string) {
	if digestIndex := strings.Index(image, "@"); digestIndex >= 0 {
		image = image[:digestIndex]
	}
	if tagIndex := strings.LastIndex(image, ":"); tagIndex > strings.LastIndex(image, "/") {
		image = image[:tagIndex]
	}
	parts := strings.Split(image, "/")
	if len(parts) == 1 {
		return "", "library/" + parts[0]
	}
	if len(parts) > 1 {
		if strings.Contains(parts[0], ".") || strings.Contains(parts[0], ":") {
			return parts[0], strings.Join(parts[1:], "/")
		}
		return "", strings.Join(parts, "/")
	}
	return "", image
}
