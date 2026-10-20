package middleware

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

const (
	gateLoginPath    = "/api/auth/login/password"
	gatePasswordPath = "/api/users/me/password"
	gateAdminPath    = "/api/v1/admin/users"
	gateProbePath    = "/healthz"
)

func newGateRouter(t *testing.T, enabled bool, base string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.Use(requireHTTPS(enabled, base))
	ok := func(c *gin.Context) { c.String(http.StatusOK, "passed") }
	router.POST(base+gateLoginPath, ok)
	router.POST(base+gatePasswordPath, ok)
	router.GET(base+gateAdminPath, ok)
	router.GET(base+gateProbePath, ok)
	return router
}

func serveGate(t *testing.T, router *gin.Engine, method, path string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if mutate != nil {
		mutate(req)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

// HOST 不是 https:// 时闸门整体关闭：纯 HTTP 部署的行为必须和加这条中间件之前一致。
func TestRequireHTTPSDisabledKeepsPlaintextWorking(t *testing.T) {
	router := newGateRouter(t, false, "")

	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, gateLoginPath},
		{http.MethodPost, gatePasswordPath},
		{http.MethodGet, gateAdminPath},
	} {
		if recorder := serveGate(t, router, tc.method, tc.path, nil); recorder.Code != http.StatusOK {
			t.Fatalf("%s %s = %d, want %d", tc.method, tc.path, recorder.Code, http.StatusOK)
		}
	}
}

// 证书配好了却用 http 直连（或绕过入口）时，凭据类接口必须当场拒绝，
// 否则口令与会话令牌会明文过网。
func TestRequireHTTPSRejectsPlaintextOnCredentialPaths(t *testing.T) {
	router := newGateRouter(t, true, "")

	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, gateLoginPath},
		{http.MethodPost, gatePasswordPath},
		{http.MethodGet, gateAdminPath},
	} {
		recorder := serveGate(t, router, tc.method, tc.path, nil)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s %s = %d, want %d", tc.method, tc.path, recorder.Code, http.StatusBadRequest)
		}
		if !strings.Contains(recorder.Body.String(), "https_required") {
			t.Fatalf("%s %s body = %q, want code https_required", tc.method, tc.path, recorder.Body.String())
		}
	}
}

// 入口透传 X-Forwarded-Proto 是 HTTPS 终结在 Ingress 之后的正常形态；
// 多级代理会给出 "https, http" 这样的列表，取第一段判定。
func TestRequireHTTPSAcceptsForwardedProto(t *testing.T) {
	router := newGateRouter(t, true, "")

	for _, proto := range []string{"https", "HTTPS", " https ", "https, http"} {
		recorder := serveGate(t, router, http.MethodPost, gateLoginPath, func(req *http.Request) {
			req.Header.Set("X-Forwarded-Proto", proto)
		})
		if recorder.Code != http.StatusOK {
			t.Fatalf("X-Forwarded-Proto=%q = %d, want %d", proto, recorder.Code, http.StatusOK)
		}
	}

	// 只有 http 的转发头不能算数，否则明文入口等于没闸门。
	if recorder := serveGate(t, router, http.MethodPost, gateLoginPath, func(req *http.Request) {
		req.Header.Set("X-Forwarded-Proto", "http")
	}); recorder.Code != http.StatusBadRequest {
		t.Fatalf("X-Forwarded-Proto=http = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestRequireHTTPSAcceptsTLS(t *testing.T) {
	router := newGateRouter(t, true, "")

	recorder := serveGate(t, router, http.MethodGet, gateAdminPath, func(req *http.Request) {
		req.TLS = &tls.ConnectionState{}
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("TLS request = %d, want %d", recorder.Code, http.StatusOK)
	}
}

// 探针与静态资源不受闸门影响：kubelet 用 http 探活，收紧它只会让 Pod 一直重启。
func TestRequireHTTPSLeavesProbesAlone(t *testing.T) {
	router := newGateRouter(t, true, "")

	if recorder := serveGate(t, router, http.MethodGet, gateProbePath, nil); recorder.Code != http.StatusOK {
		t.Fatalf("probe = %d, want %d", recorder.Code, http.StatusOK)
	}
}

// 配了 BASE 之后，路径前缀必须带上 base，否则闸门会漏掉真实路由。
func TestRequireHTTPSHonorsBasePath(t *testing.T) {
	router := newGateRouter(t, true, "/kite")

	if recorder := serveGate(t, router, http.MethodGet, "/kite"+gateAdminPath, nil); recorder.Code != http.StatusBadRequest {
		t.Fatalf("base-prefixed admin path = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if recorder := serveGate(t, router, http.MethodGet, "/kite"+gateAdminPath, func(req *http.Request) {
		req.Header.Set("X-Forwarded-Proto", "https")
	}); recorder.Code != http.StatusOK {
		t.Fatalf("base-prefixed admin path over https = %d, want %d", recorder.Code, http.StatusOK)
	}
}

func TestHasAnyPrefixUsesSegmentBoundary(t *testing.T) {
	prefixes := []string{"/api/v1/admin", "/api/auth/login"}

	for _, path := range []string{"/api/v1/admin", "/api/v1/admin/", "/api/v1/admin/users", "/api/auth/login/password"} {
		if !hasAnyPrefix(path, prefixes) {
			t.Fatalf("%q should be guarded", path)
		}
	}
	for _, path := range []string{"/api/v1/adminx", "/api/v1/admins", "/api/auth/loginx", "/api/v1/clusters", "/"} {
		if hasAnyPrefix(path, prefixes) {
			t.Fatalf("%q should not be guarded", path)
		}
	}
}
