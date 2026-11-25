package audit

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"aerolink/pkg/model"
)

// newFakeES 起一个假的 ES：记录请求并把预置响应写回去。
// 必须带 X-Elastic-Product 头，否则 go-elasticsearch 会判定「不是 ES」并拒绝响应。
func newFakeES(t *testing.T, path, body *string, response string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*path = r.URL.Path
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("failed to read request body: %v", err)
		}
		*body = string(raw)

		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(response))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestESSinkIndexNameByDay(t *testing.T) {
	sink := &ESSink{config: model.ESArchive{IndexPrefix: "aerolink-audit"}}
	at := time.Date(2026, 9, 20, 10, 30, 0, 0, time.UTC)
	if got := sink.IndexName(at); got != "aerolink-audit-2026.09.20" {
		t.Fatalf("IndexName() = %q, want aerolink-audit-2026.09.20", got)
	}

	empty := &ESSink{}
	if got := empty.IndexName(at); got != model.DefaultESIndexPrefix+"-2026.09.20" {
		t.Fatalf("IndexName() with empty prefix = %q", got)
	}
}

func TestESSinkIndexWritesBulkNDJSON(t *testing.T) {
	var path, body string
	server := newFakeES(t, &path, &body, `{"errors":false,"items":[]}`)

	sink, err := NewESSink(model.ESArchive{Enabled: true, URLs: []string{server.URL}, IndexPrefix: "aerolink-audit"})
	if err != nil {
		t.Fatalf("NewESSink() error = %v", err)
	}

	at := time.Date(2026, 9, 20, 10, 30, 0, 0, time.UTC)
	fields := map[string]any{"cluster_name": "prod", "success": true}
	err = sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAuditHistory, ID: "42", At: at, Fields: fields},
	})
	if err != nil {
		t.Fatalf("Index() error = %v", err)
	}

	if path != "/_bulk" {
		t.Errorf("bulk path = %q, want /_bulk", path)
	}
	lines := strings.Split(strings.TrimSpace(body), "\n")
	if len(lines) != 2 {
		t.Fatalf("bulk body has %d lines, want 2:\n%s", len(lines), body)
	}
	if !strings.Contains(lines[0], `"_index":"aerolink-audit-2026.09.20"`) || !strings.Contains(lines[0], `"_id":"42"`) {
		t.Errorf("bulk action line = %s", lines[0])
	}
	if !strings.Contains(lines[1], `"kind":"audit_history"`) {
		t.Errorf("bulk doc line missing injected kind: %s", lines[1])
	}
	// 不应把 kind 写回调用方的 map（避免副作用）。
	if _, mutated := fields["kind"]; mutated {
		t.Error("Index() mutated the caller's Fields map")
	}
}

func TestESSinkIndexGroupsByDay(t *testing.T) {
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(raw))
		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		_, _ = w.Write([]byte(`{"errors":false,"items":[]}`))
	}))
	t.Cleanup(server.Close)

	sink, err := NewESSink(model.ESArchive{Enabled: true, URLs: []string{server.URL}, IndexPrefix: "aerolink-audit"})
	if err != nil {
		t.Fatalf("NewESSink() error = %v", err)
	}

	err = sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAccessLog, At: time.Date(2026, 9, 19, 23, 59, 0, 0, time.UTC), Fields: map[string]any{}},
		{Kind: ESKindAccessLog, At: time.Date(2026, 9, 20, 0, 1, 0, 0, time.UTC), Fields: map[string]any{}},
	})
	if err != nil {
		t.Fatalf("Index() error = %v", err)
	}

	if len(bodies) != 2 {
		t.Fatalf("got %d bulk requests, want 2 (one per day)", len(bodies))
	}
	if !strings.Contains(bodies[0], "aerolink-audit-2026.09.19") || !strings.Contains(bodies[1], "aerolink-audit-2026.09.20") {
		t.Errorf("documents were not grouped per day:\n%s\n%s", bodies[0], bodies[1])
	}
}

func TestESSinkIndexSurfacesItemErrors(t *testing.T) {
	var path, body string
	server := newFakeES(t, &path, &body,
		`{"errors":true,"items":[{"index":{"status":400,"error":{"type":"mapper_parsing_exception"}}}]}`)

	sink, err := NewESSink(model.ESArchive{Enabled: true, URLs: []string{server.URL}})
	if err != nil {
		t.Fatalf("NewESSink() error = %v", err)
	}

	err = sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAccessLog, At: time.Now(), Fields: map[string]any{}},
	})
	if err == nil {
		t.Fatal("Index() with per-item errors returned nil, want error")
	}
	if !strings.Contains(err.Error(), "mapper_parsing_exception") {
		t.Errorf("error %q does not surface the ES failure reason", err)
	}
}

func TestESSinkSearchBuildsDSL(t *testing.T) {
	var path, body string
	server := newFakeES(t, &path, &body,
		`{"hits":{"total":{"value":1},"hits":[{"_source":{"kind":"audit_history","id":7}}]}}`)

	sink, err := NewESSink(model.ESArchive{Enabled: true, URLs: []string{server.URL}, IndexPrefix: "aerolink-audit"})
	if err != nil {
		t.Fatalf("NewESSink() error = %v", err)
	}

	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	result, err := sink.Search(context.Background(), archiveQuery{
		kind:      ESKindAuditHistory,
		timeField: esFieldCreatedAt,
		filters:   []archiveCondition{{field: esFieldClusterName, op: opEq, value: "prod"}},
	}, from, to, 2, 20)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	if path != "/aerolink-audit-*/_search" {
		t.Errorf("search path = %q, want /aerolink-audit-*/_search", path)
	}
	if result.Total != 1 || len(result.Hits) != 1 {
		t.Fatalf("Search() = total %d, hits %d; want 1/1", result.Total, len(result.Hits))
	}

	var payload struct {
		From  int              `json:"from"`
		Size  int              `json:"size"`
		Query map[string]any   `json:"query"`
		Sort  []map[string]any `json:"sort"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("search body is not valid JSON: %v\n%s", err, body)
	}
	if payload.From != 20 || payload.Size != 20 {
		t.Errorf("pagination = from %d size %d, want 20/20", payload.From, payload.Size)
	}
	// 精确匹配统一落到 .keyword 子字段（字符串在 ES 里是 text，term 查询会先分词）。
	if !strings.Contains(body, `"kind":"audit_history"`) ||
		!strings.Contains(body, `"cluster_name.keyword":"prod"`) ||
		!strings.Contains(body, `"created_at"`) {
		t.Errorf("search body missing expected filters: %s", body)
	}
}

func TestNewESSinkDisabled(t *testing.T) {
	if _, err := NewESSink(model.ESArchive{Enabled: false}); !errors.Is(err, ErrESArchiveDisabled) {
		t.Fatalf("NewESSink(disabled) error = %v, want ErrESArchiveDisabled", err)
	}
}

// 短暂抖动（503）应当重试并最终成功；这批审计文档不该因为 ES 正在重启就丢掉。
func TestESSinkIndexRetriesTransientFailures(t *testing.T) {
	var attempts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		if attempts < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"unavailable"}`))
			return
		}
		_, _ = w.Write([]byte(`{"errors":false,"items":[]}`))
	}))
	t.Cleanup(server.Close)

	sink, err := NewESSink(model.ESArchive{Enabled: true, URLs: []string{server.URL}})
	if err != nil {
		t.Fatalf("NewESSink() error = %v", err)
	}

	err = sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAccessLog, At: time.Now(), Fields: map[string]any{}},
	})
	if err != nil {
		t.Fatalf("Index() should succeed after retries, got %v", err)
	}
	if attempts != 3 {
		t.Errorf("attempts = %d, want 3 (two failures then success)", attempts)
	}
}

// 4xx 是请求/数据本身的问题，重试只是白跑——必须只请求一次。
func TestESSinkIndexDoesNotRetryClientErrors(t *testing.T) {
	var attempts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"type":"illegal_argument_exception"}}`))
	}))
	t.Cleanup(server.Close)

	sink, err := NewESSink(model.ESArchive{Enabled: true, URLs: []string{server.URL}})
	if err != nil {
		t.Fatalf("NewESSink() error = %v", err)
	}

	if err := sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAccessLog, At: time.Now(), Fields: map[string]any{}},
	}); err == nil {
		t.Fatal("Index() with 4xx should return an error")
	}
	if attempts != 1 {
		t.Errorf("attempts = %d, want 1 (client errors must not be retried)", attempts)
	}
}
