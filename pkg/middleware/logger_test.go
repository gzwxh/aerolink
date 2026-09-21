package middleware

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/audit"
	"github.com/zxh326/kite/pkg/model"
)

// 归档 / 结构化输出里的 path 必须不含查询串。
//
// gin 的 LogFormatterParams.Path 里带着 RawQuery（见 gin.LoggerWithConfig 的实现），
// 而查询串可能携带 token 等敏感值——它会顺路进 parquet、S3、ES 和日志平台（方案 §5）。
// 这里借助 json 格式的访问日志断言同一条 entry 的内容。
func TestLoggerPathExcludesQueryString(t *testing.T) {
	gin.SetMode(gin.TestMode)

	originalWriter := gin.DefaultWriter
	audit.SetAccessLogFormat("json")
	t.Cleanup(func() {
		gin.DefaultWriter = originalWriter
		audit.SetAccessLogFormat("text")
	})

	var output bytes.Buffer
	gin.DefaultWriter = &output

	router := gin.New()
	router.Use(RequestID())
	router.Use(Logger())
	router.GET("/thing", func(c *gin.Context) { c.Status(http.StatusOK) })

	request := httptest.NewRequest(http.MethodGet, "/thing?token=secret-value", nil)
	request.Header.Set("User-Agent", "kite-test-agent/1.0")
	router.ServeHTTP(httptest.NewRecorder(), request)

	line := output.String()
	if strings.Contains(line, "secret-value") {
		t.Fatalf("access log leaked the query string into the audit entry: %s", line)
	}
	if !strings.Contains(line, `"path":"/thing"`) {
		t.Errorf("path = %s, want the bare /thing", line)
	}
}

// 访问日志的 json 行要带上 user_id 与 request_id，便于日志平台按账号与请求串联。
func TestLoggerJSONCarriesUserAndRequestID(t *testing.T) {
	gin.SetMode(gin.TestMode)

	originalWriter := gin.DefaultWriter
	audit.SetAccessLogFormat("json")
	t.Cleanup(func() {
		gin.DefaultWriter = originalWriter
		audit.SetAccessLogFormat("text")
	})

	var output bytes.Buffer
	gin.DefaultWriter = &output

	router := gin.New()
	router.Use(RequestID())
	router.Use(func(c *gin.Context) {
		c.Set("user", model.User{Model: model.Model{ID: 7}, Username: "alice"})
		c.Next()
	})
	router.Use(Logger())
	router.GET("/thing", func(c *gin.Context) { c.Status(http.StatusOK) })

	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/thing", nil))

	line := output.String()
	if !strings.Contains(line, `"user_id":7`) {
		t.Errorf("json access log missing user_id: %s", line)
	}
	if !strings.Contains(line, `"request_id":"`) {
		t.Errorf("json access log missing request_id: %s", line)
	}
}
