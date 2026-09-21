package audit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

// archiveTestContext 造一个只带 query 的 gin 上下文，用来直接驱动过滤器构造函数。
func archiveTestContext(t *testing.T, rawQuery string) *gin.Context {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodGet, "/archive?"+rawQuery, nil)
	return ctx
}

// 索引 mapping 由 ES 动态生成（字符串 = text + .keyword 子字段）。对 text 字段做
// term 查询会先分词，`PUT` 这类大写值匹配不上——所以精确匹配必须落到 .keyword。
// 这是真实联调中踩到的坑，用回归测试钉住。
func TestArchiveTermFiltersUseKeywordSubfields(t *testing.T) {
	conditions := make([]archiveCondition, 0, 2)
	addEqCondition(&conditions, esFieldMethod, "PUT")
	addEqCondition(&conditions, esFieldClusterName, "prod")

	body := buildESSearchBody(archiveQuery{
		kind:      ESKindAccessLog,
		timeField: esFieldTimestamp,
		filters:   conditions,
	}, time.Time{}, time.Time{}, 1, 20)

	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("failed to marshal search body: %v", err)
	}
	encoded := string(raw)

	if !strings.Contains(encoded, `"method.keyword":"PUT"`) {
		t.Errorf("method filter should target .keyword: %s", encoded)
	}
	if !strings.Contains(encoded, `"cluster_name.keyword":"prod"`) {
		t.Errorf("cluster filter should target .keyword: %s", encoded)
	}
}

// 登录失败的判定同样走 .keyword（归档里成功统一写成 "success"）。
func TestLoginFailureFilterExcludesKeywordSuccess(t *testing.T) {
	conditions, ok := loginRecordArchiveFilters(archiveTestContext(t, "outcome=failure"))
	if !ok {
		t.Fatal("loginRecordArchiveFilters() returned ok = false")
	}
	// 中立条件要先经 ES 翻译器渲染，才是能交给 ES 的 DSL。
	raw, err := json.Marshal(toESFilters(conditions))
	if err != nil {
		t.Fatalf("failed to marshal filters: %v", err)
	}
	if !strings.Contains(string(raw), `"result.keyword":"`+model.AuditResultSuccess+`"`) {
		t.Errorf("failure filter should exclude %q via .keyword: %s", model.AuditResultSuccess, raw)
	}
}

func TestAccessLogFiltersRejectInvalidStatusCode(t *testing.T) {
	if _, ok := accessLogArchiveFilters(archiveTestContext(t, "statusCode=abc")); ok {
		t.Error("accessLogArchiveFilters() should reject a non-numeric statusCode")
	}
	// 合法状态码走数字字段（dynamic mapping 为 long），不能加 .keyword。
	filters, ok := accessLogArchiveFilters(archiveTestContext(t, "statusCode=200"))
	if !ok {
		t.Fatal("accessLogArchiveFilters() rejected a valid statusCode")
	}
	raw, err := json.Marshal(toESFilters(filters))
	if err != nil {
		t.Fatalf("failed to marshal filters: %v", err)
	}
	if !strings.Contains(string(raw), `"status_code":200`) {
		t.Errorf("statusCode filter should stay numeric: %s", raw)
	}
}
