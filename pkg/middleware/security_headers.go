package middleware

import (
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
)

// SecurityHeaders adds the baseline hardening headers the SPA was missing.
// They are cheap and apply to every response, including the API.
//
// A strict CSP can be disabled with KITE_DISABLE_CSP=true if a deployment
// embeds Kite behind other assets that need a looser policy.
func SecurityHeaders() gin.HandlerFunc {
	cspDisabled := strings.EqualFold(strings.TrimSpace(os.Getenv("KITE_DISABLE_CSP")), "true")
	// The SPA ships its own bundles, uses inline styles and blob workers
	// (Monaco/xterm); everything else is locked down. The runtime base path is
	// served as a same-origin config.js, so no inline script is needed.
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
	// The optional analytics snippet loads from Umami's cloud; allow it only
	// while analytics is enabled.
	cspWithAnalytics := strings.Replace(csp, "script-src 'self';", "script-src 'self' https://cloud.umami.is;", 1)

	return func(c *gin.Context) {
		header := c.Writer.Header()
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("X-Frame-Options", "DENY")
		header.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if !cspDisabled {
			if common.EnableAnalytics {
				header.Set("Content-Security-Policy", cspWithAnalytics)
			} else {
				header.Set("Content-Security-Policy", csp)
			}
		}
		// Only meaningful over TLS; harmless otherwise.
		if c.Request.TLS != nil || strings.EqualFold(c.Request.Header.Get("X-Forwarded-Proto"), "https") {
			header.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		c.Next()
	}
}
