package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
)

// 上游没带 ID 时本地生成，并同时写进 gin context、请求 context 与响应头。
//
// 请求 context 那一份是关键：审计记录在 model 层的 AfterCreate 钩子里取它，
// 这是「访问日志与审计事件能对上」的前提。
func TestRequestIDGeneratesAndPropagates(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var fromGin, fromRequestContext string
	router := gin.New()
	router.Use(RequestID())
	router.GET("/x", func(c *gin.Context) {
		fromGin = RequestIDFromGin(c)
		fromRequestContext = model.RequestIDFromContext(c.Request.Context())
		c.Status(http.StatusOK)
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/x", nil))

	if len(fromGin) != 32 {
		t.Errorf("generated request id = %q, want a 32-char hex string", fromGin)
	}
	if fromRequestContext != fromGin {
		t.Errorf("request context id = %q, want %q", fromRequestContext, fromGin)
	}
	if got := recorder.Header().Get(RequestIDHeader); got != fromGin {
		t.Errorf("response header %s = %q, want %q", RequestIDHeader, got, fromGin)
	}
}

// 上游（网关 / 反向代理）已经打过日志的链路复用同一个 ID。
func TestRequestIDReusesUpstreamHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var seen string
	router := gin.New()
	router.Use(RequestID())
	router.GET("/x", func(c *gin.Context) {
		seen = RequestIDFromGin(c)
		c.Status(http.StatusOK)
	})

	request := httptest.NewRequest(http.MethodGet, "/x", nil)
	request.Header.Set(RequestIDHeader, "upstream-id-123")
	router.ServeHTTP(httptest.NewRecorder(), request)

	if seen != "upstream-id-123" {
		t.Errorf("request id = %q, want the upstream value", seen)
	}
}

// 超长的上游请求头不采信：它会被写进每一行日志，必须挡住。
func TestRequestIDReplacesOverlongHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var seen string
	router := gin.New()
	router.Use(RequestID())
	router.GET("/x", func(c *gin.Context) {
		seen = RequestIDFromGin(c)
		c.Status(http.StatusOK)
	})

	tooLong := strings.Repeat("a", requestIDMaxLength+1)
	request := httptest.NewRequest(http.MethodGet, "/x", nil)
	request.Header.Set(RequestIDHeader, tooLong)
	router.ServeHTTP(httptest.NewRecorder(), request)

	if seen == tooLong || len(seen) != 32 {
		t.Errorf("request id = %q, want a freshly generated one instead of the overlong header", seen)
	}
}

// 连续两次请求使用不同的 ID，不会互相串。
func TestRequestIDIsUniquePerRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)

	seen := make([]string, 0, 2)
	router := gin.New()
	router.Use(RequestID())
	router.GET("/x", func(c *gin.Context) {
		seen = append(seen, RequestIDFromGin(c))
		c.Status(http.StatusOK)
	})

	for i := 0; i < 2; i++ {
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	}
	if len(seen) != 2 || seen[0] == seen[1] {
		t.Errorf("request ids = %v, want two distinct values", seen)
	}
}
