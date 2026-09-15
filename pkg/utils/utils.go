package utils

import (
	"fmt"
	"html"
	"regexp"
	"strings"

	"k8s.io/apimachinery/pkg/util/rand"
)

const kiteBasePlaceholder = "__KITE_BASE__"

func InjectAnalytics(htmlContent string) string {
	analyticsScript := `<script defer src="https://cloud.umami.is/script.js" data-website-id="c3d8a914-abbc-4eed-9699-a9192c4bef9e" data-exclude-search="true" data-exclude-hash="true" data-do-not-track="true"></script>`

	re := regexp.MustCompile(`</head>`)
	return re.ReplaceAllString(htmlContent, "  "+analyticsScript+"\n  </head>")
}

func InjectKiteBase(htmlContent string, base string) string {
	assetBase := base
	if assetBase == "/" {
		assetBase = ""
	}

	htmlContent = strings.ReplaceAll(htmlContent, kiteBasePlaceholder, html.EscapeString(assetBase))

	// The runtime base must reach the SPA before its bundle runs. It cannot be
	// an inline <script>: the served Content-Security-Policy is
	// script-src 'self', which blocks inline execution. It is loaded as a
	// same-origin external file served at {base}/config.js (see setupStatic).
	baseScript := fmt.Sprintf(`<script src="%s/config.js"></script>`, html.EscapeString(assetBase))
	re := regexp.MustCompile(`<head>`)
	return re.ReplaceAllString(htmlContent, "<head>\n    "+baseScript)
}

// ConfigScript renders the body of the external config.js that publishes the
// runtime base path to the SPA (window.__dynamic_base__). The value is the
// asset base ("." semantics already resolved by the caller): "" for root or
// the configured sub path.
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
