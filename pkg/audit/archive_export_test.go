package audit

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// newPagedFakeES 起一个支持分页的假 ES：按请求里的 from / size 返回对应切片。
// 用来验证导出的翻页与截断逻辑，不依赖真实 ES。
func newPagedFakeES(t *testing.T, total int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var payload struct {
			From int `json:"from"`
			Size int `json:"size"`
		}
		_ = json.Unmarshal(raw, &payload)

		count := payload.Size
		if remaining := total - payload.From; remaining < count {
			count = remaining
		}
		if count < 0 {
			count = 0
		}

		hits := make([]map[string]any, 0, count)
		for i := 0; i < count; i++ {
			hits = append(hits, map[string]any{
				"_source": map[string]any{
					"cluster_name":  "prod",
					"operator_name": "alice",
					"created_at":    "2026-09-20T10:30:00Z",
					"user_agent":    "kubectl",
				},
			})
		}

		response, err := json.Marshal(map[string]any{
			"hits": map[string]any{
				"total": map[string]any{"value": total, "relation": "eq"},
				"hits":  hits,
			},
		})
		if err != nil {
			t.Errorf("failed to encode fake search response: %v", err)
		}

		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(response)
	}))
	t.Cleanup(server.Close)
	return server
}

func newExportTestSink(t *testing.T, urls []string) *ESSink {
	t.Helper()
	sink, err := NewESSink(model.ESArchive{Enabled: true, URLs: urls, IndexPrefix: "aerolink-audit"})
	if err != nil {
		t.Fatalf("NewESSink() error = %v", err)
	}
	return sink
}

// 导出必须翻到最后一页：命中 1500 条时不能只给第 1 页的 1000 条。
func TestCollectArchiveRecordsPaginates(t *testing.T) {
	server := newPagedFakeES(t, 1500)
	sink := newExportTestSink(t, []string{server.URL})

	request := archiveExportRequest{
		kind:      ESKindAuditHistory,
		timeField: esFieldCreatedAt,
		columns:   auditHistoryArchiveColumns,
	}
	records, total, truncated, err := collectArchiveRecords(
		context.Background(), sink, request, time.Time{}, time.Time{},
	)
	if err != nil {
		t.Fatalf("collectArchiveRecords() error = %v", err)
	}
	if total != 1500 {
		t.Errorf("total = %d, want 1500", total)
	}
	if len(records) != 1500 {
		t.Errorf("rows = %d, want 1500 (paging should reach the last page)", len(records))
	}
	if truncated {
		t.Error("truncated = true, want false when every hit fits in the paging window")
	}

	// 列顺序与本地导出对齐：operator 在第 2 列、cluster 在第 5 列。
	if got := records[0][1]; got != "alice" {
		t.Errorf("first row operator = %q, want alice", got)
	}
	if got := records[0][4]; got != "prod" {
		t.Errorf("first row cluster = %q, want prod", got)
	}
	// 缺失字段渲染成空串，而不是 "<nil>" / "null"。
	if got := records[0][8]; got != "" {
		t.Errorf("missing success field = %q, want empty", got)
	}
}

// 命中数超过 ES 的 from+size 上限时，导出应在上限处截断并标记，而不是报错或无限拉取。
func TestCollectArchiveRecordsTruncatesAtWindowLimit(t *testing.T) {
	server := newPagedFakeES(t, 50000)
	sink := newExportTestSink(t, []string{server.URL})

	request := archiveExportRequest{
		kind:      ESKindAccessLog,
		timeField: esFieldTimestamp,
		columns:   accessLogArchiveColumns,
	}
	records, total, truncated, err := collectArchiveRecords(
		context.Background(), sink, request, time.Time{}, time.Time{},
	)
	if err != nil {
		t.Fatalf("collectArchiveRecords() error = %v", err)
	}
	if len(records) != archiveExportWindowLimit {
		t.Errorf("rows = %d, want %d (capped at the paging window)", len(records), archiveExportWindowLimit)
	}
	if !truncated {
		t.Error("truncated = false, want true when hits exceed the paging window")
	}
	if total != 50000 {
		t.Errorf("total = %d, want 50000 (needed by the UI hint)", total)
	}
}

// 归档里只有 result 一个字段，导出时派生成 success + reason 两列，与本地导出的表头对齐。
func TestRenderArchiveRecordDerivesLoginSuccessAndReason(t *testing.T) {
	if got := strings.Join(archiveHeaders(loginRecordArchiveColumns), ","); got != "time,username,provider,success,reason,ip,userAgent" {
		t.Fatalf("login archive header = %s", got)
	}

	success := renderArchiveRecord(loginRecordArchiveColumns, map[string]any{
		"username": "alice",
		"result":   model.AuditResultSuccess,
	})
	if success[3] != "true" || success[4] != "" {
		t.Errorf("successful login row = %v, want success=true and empty reason", success)
	}

	failed := renderArchiveRecord(loginRecordArchiveColumns, map[string]any{
		"username": "bob",
		"result":   "invalid password",
	})
	if failed[3] != "false" || failed[4] != "invalid password" {
		t.Errorf("failed login row = %v, want success=false and the reason", failed)
	}
}

// ES 的 JSON 数字统一解码成 float64：导出里的状态码、时延不该变成科学计数法。
func TestArchiveFieldStringKeepsNumbersReadable(t *testing.T) {
	cases := []struct {
		value any
		want  string
	}{
		{nil, ""},
		{"kubectl", "kubectl"},
		{true, "true"},
		{float64(200), "200"},
		{float64(1.5), "1.5"},
		{[]string{"a", "b"}, `["a","b"]`},
	}
	for _, tc := range cases {
		if got := archiveFieldString(tc.value); got != tc.want {
			t.Errorf("archiveFieldString(%#v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}
