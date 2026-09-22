package audit

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// newFakeOpenObserve 起一个假的 OO 实例：请求全交给 handle，测试结束自动关闭。
func newFakeOpenObserve(t *testing.T, handle http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handle)
	t.Cleanup(server.Close)
	return server
}

// newOpenObserveSink 按地址构造 sink（启用与地址是构造的硬前提）。
func newOpenObserveSink(t *testing.T, config model.OpenObserveArchive, urls ...string) *OpenObserveSink {
	t.Helper()
	config.Enabled = true
	config.URLs = urls
	sink, err := NewOpenObserveSink(config)
	if err != nil {
		t.Fatalf("NewOpenObserveSink() error = %v", err)
	}
	return sink
}

func TestNewOpenObserveSinkRequiresEnabledAndURLs(t *testing.T) {
	if _, err := NewOpenObserveSink(model.OpenObserveArchive{}); !errors.Is(err, ErrOpenObserveDisabled) {
		t.Errorf("未启用时应返回 ErrOpenObserveDisabled, got %v", err)
	}
	if _, err := NewOpenObserveSink(model.OpenObserveArchive{Enabled: true}); err == nil {
		t.Error("启用但没有地址时必须报错")
	}
}

func TestOpenObserveSinkWritePostsRecordsArray(t *testing.T) {
	var path, contentType, authorization, body string
	server := newFakeOpenObserve(t, func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("failed to read request body: %v", err)
		}
		path, contentType, authorization, body = r.URL.Path, r.Header.Get("Content-Type"), r.Header.Get("Authorization"), string(raw)
		w.WriteHeader(http.StatusOK)
	})

	sink := newOpenObserveSink(t, model.OpenObserveArchive{
		Org:      "kite-org",
		Stream:   "audit-stream",
		Username: "ops@example.com",
		Password: model.SecretString("s3cr3t"),
	}, server.URL)

	at := time.Date(2026, 9, 20, 10, 30, 0, 0, time.UTC)
	fields := map[string]any{"cluster_name": "prod", "success": true}
	err := sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAuditHistory, ID: "42", At: at, Fields: fields},
		// At 是零值：不该写 `_timestamp`，让服务端用摄取时间。
		{Kind: ESKindAccessLog, At: time.Time{}, Fields: map[string]any{"method": "GET"}},
	})
	if err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	if path != "/api/kite-org/audit-stream/_json" {
		t.Errorf("ingest path = %q, want /api/kite-org/audit-stream/_json", path)
	}
	if contentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", contentType)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops@example.com:s3cr3t"))
	if authorization != wantAuth {
		t.Errorf("Authorization = %q, want %q", authorization, wantAuth)
	}

	// body 必须是**数组**（`_json` 接口的约定），且带上 kind 与微秒时间戳。
	var records []map[string]any
	if err := json.Unmarshal([]byte(body), &records); err != nil {
		t.Fatalf("body is not a JSON array: %v\n%s", err, body)
	}
	if len(records) != 2 {
		t.Fatalf("records = %d, want 2", len(records))
	}
	if records[0]["kind"] != ESKindAuditHistory {
		t.Errorf("record[0].kind = %v, want %s", records[0]["kind"], ESKindAuditHistory)
	}
	if got := records[0][ooTimestampField]; got != float64(at.UnixMicro()) {
		t.Errorf("record[0]._timestamp = %v, want %d（微秒）", got, at.UnixMicro())
	}
	if records[0]["cluster_name"] != "prod" {
		t.Errorf("业务字段必须原样写入, got %v", records[0]["cluster_name"])
	}
	if _, exists := records[1][ooTimestampField]; exists {
		t.Error("At 为零值时不该写 _timestamp（交给服务端用摄取时间）")
	}

	// 不能把辅助字段写回调用方的 map：同一批文档可能还要写别的 sink。
	if _, mutated := fields["kind"]; mutated {
		t.Error("Write() mutated the caller's Fields map")
	}
	if _, mutated := fields[ooTimestampField]; mutated {
		t.Error("Write() mutated the caller's Fields map with _timestamp")
	}
}

func TestOpenObserveSinkWriteFailsOverToNextEndpoint(t *testing.T) {
	var first, second int32
	broken := newFakeOpenObserve(t, func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&first, 1)
		w.WriteHeader(http.StatusInternalServerError)
	})
	healthy := newFakeOpenObserve(t, func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&second, 1)
		w.WriteHeader(http.StatusOK)
	})

	sink := newOpenObserveSink(t, model.OpenObserveArchive{}, broken.URL, healthy.URL)
	if err := sink.Write(context.Background(), []ESDocument{{Kind: ESKindLoginRecord, Fields: map[string]any{}}}); err != nil {
		t.Fatalf("Write() 应在第二个地址成功, got %v", err)
	}
	if atomic.LoadInt32(&second) != 1 {
		t.Errorf("第二个地址收到 %d 次请求, want 1", atomic.LoadInt32(&second))
	}
}

func TestOpenObserveSinkWriteRetriesServerErrors(t *testing.T) {
	var attempts int32
	server := newFakeOpenObserve(t, func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&attempts, 1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	sink := newOpenObserveSink(t, model.OpenObserveArchive{}, server.URL)
	if err := sink.Write(context.Background(), []ESDocument{{Kind: ESKindLoginRecord, Fields: map[string]any{}}}); err != nil {
		t.Fatalf("Write() 应在重试后成功, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Errorf("attempts = %d, want 3", got)
	}
}

func TestOpenObserveSinkWriteDoesNotRetryClientErrors(t *testing.T) {
	var attempts int32
	server := newFakeOpenObserve(t, func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":401,"error":"unauthorized"}`))
	})

	sink := newOpenObserveSink(t, model.OpenObserveArchive{}, server.URL)
	err := sink.Write(context.Background(), []ESDocument{{Kind: ESKindLoginRecord, Fields: map[string]any{}}})
	if err == nil {
		t.Fatal("401 必须返回错误")
	}
	if !errors.Is(err, errLogSinkNotRetryable) {
		t.Errorf("认证失败应标记为不可重试, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Errorf("attempts = %d, want 1（4xx 不重试）", got)
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("错误信息应带状态码: %v", err)
	}
}

func TestOpenObserveSQLRendersConditions(t *testing.T) {
	sink := newOpenObserveSink(t, model.OpenObserveArchive{Stream: "aerolink-audit"}, "http://openobserve:5080")

	cases := []struct {
		name    string
		filters []archiveCondition
		want    []string
	}{
		{
			name:    "精确匹配",
			filters: []archiveCondition{{field: esFieldClusterName, op: opEq, value: "prod"}},
			want:    []string{"cluster_name = 'prod'"},
		},
		{
			name:    "排除值",
			filters: []archiveCondition{notEqCondition(esFieldResult, "success")},
			want:    []string{"result <> 'success'"},
		},
		{
			name:    "关键字多列 OR 且转义单引号",
			filters: []archiveCondition{{op: opContains, value: "it's", searchFields: []string{esFieldResourceName, esFieldOperatorName}}},
			want:    []string{"resource_name ILIKE '%' || 'it''s' || '%'", "operator_name ILIKE", " OR "},
		},
		{
			name:    "多值 IN",
			filters: []archiveCondition{{field: esFieldOperationType, op: opIn, value: []any{"update", "delete"}}},
			want:    []string{"operation_type IN ('update', 'delete')"},
		},
		{
			name:    "无过滤条件",
			filters: nil,
			want:    []string{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sql, err := sink.openObserveSQL(archiveQuery{
				kind:      ESKindAuditHistory,
				timeField: esFieldCreatedAt,
				filters:   tc.filters,
			})
			if err != nil {
				t.Fatalf("openObserveSQL() error = %v", err)
			}

			// kind 是四类记录共用一个流时的唯一区分依据，必须始终出现在 WHERE 里。
			for _, want := range append([]string{"kind = 'audit_history'", `FROM "aerolink-audit"`, "ORDER BY _timestamp DESC"}, tc.want...) {
				if !strings.Contains(sql, want) {
					t.Errorf("SQL 缺少 %q:\n%s", want, sql)
				}
			}
			if tc.filters == nil && strings.Contains(sql, " AND ") {
				t.Errorf("无过滤条件时不该有 AND:\n%s", sql)
			}
		})
	}
}

func TestOpenObserveSQLRejectsUnsupportedKindAndUnsafeStream(t *testing.T) {
	sink := newOpenObserveSink(t, model.OpenObserveArchive{Stream: "aerolink-audit"}, "http://openobserve:5080")
	if _, err := sink.openObserveSQL(archiveQuery{kind: "unknown", timeField: esFieldCreatedAt}); err == nil {
		t.Error("未知 kind 必须报错，而不是查出一堆无关记录")
	}

	escaped, err := openObserveIdentifier(`we"ird`)
	if err != nil {
		t.Fatalf("openObserveIdentifier() error = %v", err)
	}
	if escaped != `"we""ird"` {
		t.Errorf("流名标识符转义 = %q, want %q", escaped, `"we""ird"`)
	}
	if _, err := openObserveIdentifier("   "); err == nil {
		t.Error("空流名必须报错")
	}
}

// 检索请求与响应的形状是「OpenObserve 版本升级」的高风险面：这个用例把请求体与响应解析钉死，
// 接口一变就会失败，而不是静默查到错数据（见 openobserve_sink.go 的版本隔离说明）。
func TestOpenObserveSinkSearchPinsRequestShapeAndParsesResponse(t *testing.T) {
	var body string
	var hitCount int32
	server := newFakeOpenObserve(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		w.Header().Set("Content-Type", "application/json")
		// total 用字符串：与 VictoriaLogs 的 stats 输出一样，部分版本这么编码。
		_, _ = w.Write([]byte(`{"hits":[{"kind":"audit_history","id":7,"resource_name":"web"}],"total":"42","took":3}`))
		atomic.AddInt32(&hitCount, 1)
	})

	sink := newOpenObserveSink(t, model.OpenObserveArchive{Org: "default", Stream: "aerolink-audit"}, server.URL)

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

	var payload struct {
		Query map[string]any `json:"query"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("search body is not valid JSON: %v\n%s", err, body)
	}
	query := payload.Query
	if query == nil {
		t.Fatalf("search body 缺少 query 对象: %s", body)
	}
	if _, ok := query["sql"]; !ok {
		t.Errorf("query 缺少 sql 字段: %s", body)
	}
	if query["start_time"] != float64(from.UnixMicro()) || query["end_time"] != float64(to.UnixMicro()) {
		t.Errorf("时间窗必须是微秒: got %v/%v want %d/%d",
			query["start_time"], query["end_time"], from.UnixMicro(), to.UnixMicro())
	}
	if query["from"] != float64(20) || query["size"] != float64(20) {
		t.Errorf("分页 = from %v size %v, want 20/20", query["from"], query["size"])
	}
	if sql, _ := query["sql"].(string); !strings.Contains(sql, "cluster_name = 'prod'") {
		t.Errorf("SQL 未包含过滤条件: %q", sql)
	}

	if result.Total != 42 {
		t.Errorf("Total = %d, want 42（字符串形式的总数也要认）", result.Total)
	}
	if len(result.Hits) != 1 || !strings.Contains(string(result.Hits[0]), `"resource_name":"web"`) {
		t.Errorf("Hits 应原样保留命中行, got %v", result.Hits)
	}
	if atomic.LoadInt32(&hitCount) != 1 {
		t.Errorf("Search 应只发一次请求（总数在同一个响应里）, got %d", atomic.LoadInt32(&hitCount))
	}
}

func TestParseOpenObserveTotal(t *testing.T) {
	cases := map[string]int64{
		`42`:     42,
		`"42"`:   42,
		`0`:      0,
		``:       0,
		`null`:   0,
		`"oops"`: 0,
		`1.5`:    0,
	}
	for raw, want := range cases {
		if got := parseOpenObserveTotal(json.RawMessage(raw)); got != want {
			t.Errorf("parseOpenObserveTotal(%s) = %d, want %d", raw, got, want)
		}
	}
}

func TestOpenObserveSinkSearchSurfacesErrors(t *testing.T) {
	server := newFakeOpenObserve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":400,"error":"invalid sql"}`))
	})

	sink := newOpenObserveSink(t, model.OpenObserveArchive{}, server.URL)
	_, err := sink.Search(context.Background(), archiveQuery{kind: ESKindAuditHistory, timeField: esFieldCreatedAt}, time.Now().Add(-time.Hour), time.Now(), 1, 20)
	if err == nil {
		t.Fatal("非 2xx 必须返回错误")
	}
	if !strings.Contains(err.Error(), "400") || !strings.Contains(err.Error(), "invalid sql") {
		t.Errorf("错误信息应带状态码与响应片段: %v", err)
	}
}

func TestOpenObserveSinkPing(t *testing.T) {
	ok := newFakeOpenObserve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("ping path = %q, want /healthz", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	})
	sink := newOpenObserveSink(t, model.OpenObserveArchive{}, ok.URL)
	if err := sink.Ping(context.Background()); err != nil {
		t.Errorf("Ping() error = %v", err)
	}

	broken := newFakeOpenObserve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	brokenSink := newOpenObserveSink(t, model.OpenObserveArchive{}, broken.URL)
	if err := brokenSink.Ping(context.Background()); err == nil {
		t.Error("非 2xx 时 Ping 必须报错")
	}
}
