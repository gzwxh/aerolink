package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
)

// cspDirective 取出 CSP 里某条指令的值（不含指令名），未出现时返回空串。
func cspDirective(csp, name string) string {
	for _, part := range strings.Split(csp, ";") {
		fields := strings.SplitN(strings.TrimSpace(part), " ", 2)
		if len(fields) == 2 && fields[0] == name {
			return strings.TrimSpace(fields[1])
		}
	}
	return ""
}

func runSecurityHeaders(t *testing.T) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.Use(SecurityHeaders())
	router.GET("/account", func(c *gin.Context) { c.Status(http.StatusOK) })

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/account", nil))
	return recorder
}

// 头像 / OIDC picture 都是外链，img-src 必须放行外部图片，否则浏览器会拦掉请求，
// 头像静默回落到首字母占位。其余指令仍保持最小权限。
func TestSecurityHeadersAllowExternalImages(t *testing.T) {
	csp := runSecurityHeaders(t).Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("Content-Security-Policy header is missing")
	}

	imgSrc := cspDirective(csp, "img-src")
	if imgSrc == "" {
		t.Fatalf("CSP has no img-src directive: %q", csp)
	}
	for _, want := range []string{"'self'", "data:", "blob:", "https:", "http:"} {
		if !strings.Contains(imgSrc, want) {
			t.Fatalf("img-src = %q, want it to contain %q", imgSrc, want)
		}
	}

	if got := cspDirective(csp, "script-src"); got != "'self'" {
		t.Fatalf("script-src = %q, want %q", got, "'self'")
	}
	if got := cspDirective(csp, "object-src"); got != "'none'" {
		t.Fatalf("object-src = %q, want %q", got, "'none'")
	}
}

// 统计来源一律不放行：本分支不需要上报数据，即使统计开关被打开（例如数据库里
// 留下的历史值），CSP 里也不该出现第三方来源，浏览器会拦掉注入的脚本与上报请求。
func TestSecurityHeadersNeverAllowAnalyticsOrigins(t *testing.T) {
	original := common.EnableAnalytics.Load()
	t.Cleanup(func() { common.EnableAnalytics.Store(original) })

	common.EnableAnalytics.Store(true)
	csp := runSecurityHeaders(t).Header().Get("Content-Security-Policy")
	for _, name := range []string{"script-src", "connect-src"} {
		if got := cspDirective(csp, name); strings.Contains(got, "umami") {
			t.Fatalf("%s = %q, want no analytics origin", name, got)
		}
	}
}

func TestSecurityHeadersDisabledByEnv(t *testing.T) {
	t.Setenv("KITE_DISABLE_CSP", "true")

	if got := runSecurityHeaders(t).Header().Get("Content-Security-Policy"); got != "" {
		t.Fatalf("Content-Security-Policy = %q, want empty", got)
	}
}
