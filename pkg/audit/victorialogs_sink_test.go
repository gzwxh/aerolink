package audit

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aerolink/pkg/model"
)

// newFakeVictoriaLogs 起一个假的 VL 实例：请求全交给 handle，测试结束自动关闭。
func newFakeVictoriaLogs(t *testing.T, handle http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handle)
	t.Cleanup(server.Close)
	return server
}

// newVictoriaLogsSink 按地址构造 sink（配置里的开关与地址是构造的硬前提）。
func newVictoriaLogsSink(t *testing.T, config model.VictoriaLogsArchive, urls ...string) *VictoriaLogsSink {
	t.Helper()
	config.Enabled = true
	config.URLs = urls
	sink, err := NewVictoriaLogsSink(config)
	if err != nil {
		t.Fatalf("NewVictoriaLogsSink() error = %v", err)
	}
	return sink
}

func TestVictoriaLogsSinkWriteEncodesBulkNDJSON(t *testing.T) {
	var path, contentType, account, project, body string
	server := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("failed to read request body: %v", err)
		}
		path = r.URL.Path
		contentType = r.Header.Get("Content-Type")
		account = r.Header.Get("AccountID")
		project = r.Header.Get("ProjectID")
		body = string(raw)
		w.WriteHeader(http.StatusNoContent)
	})

	sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{AccountID: "12", ProjectID: "34"}, server.URL)

	at := time.Date(2026, 9, 20, 10, 30, 0, 0, time.UTC)
	fields := map[string]any{"cluster_name": "prod", "success": true}
	err := sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAuditHistory, ID: "42", At: at, Fields: fields},
		// At 是零值：不该写 `_time`，让 VL 用接收时间（RFC3339 表达不了零值）。
		{Kind: ESKindAccessLog, At: time.Time{}, Fields: map[string]any{"method": "GET"}},
	})
	if err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	if path != "/insert/elasticsearch/_bulk" {
		t.Errorf("insert path = %q, want /insert/elasticsearch/_bulk", path)
	}
	if contentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", contentType)
	}
	// 多租户：写进 A 租户却从 0 租户查，界面上就是「一条记录都没有」。
	if account != "12" || project != "34" {
		t.Errorf("tenant headers = %q/%q, want 12/34", account, project)
	}

	lines := strings.Split(strings.TrimSpace(body), "\n")
	if len(lines) != 4 {
		t.Fatalf("bulk body has %d lines, want 4 (two docs x action+document):\n%s", len(lines), body)
	}
	for _, index := range []int{0, 2} {
		if lines[index] != `{"create":{}}` {
			t.Errorf("action line %d = %s, want {\"create\":{}}", index, lines[index])
		}
	}
	if !strings.Contains(lines[1], `"_time":"2026-09-20T10:30:00Z"`) {
		t.Errorf("document line missing _time: %s", lines[1])
	}
	if !strings.Contains(lines[1], `"kind":"audit_history"`) {
		t.Errorf("document line missing injected kind: %s", lines[1])
	}
	// `_msg` 是 VL 的日志正文：不填在它的 Web UI / Grafana 里只有 `-`。
	if !strings.Contains(lines[1], `"_msg":"audit_history cluster_name=prod success=true"`) {
		t.Errorf("document line has unexpected _msg: %s", lines[1])
	}
	if !strings.Contains(lines[1], `"cluster_name":"prod"`) {
		t.Errorf("document line dropped the caller's fields: %s", lines[1])
	}
	if strings.Contains(lines[3], `"_time"`) {
		t.Errorf("zero At must not write _time: %s", lines[3])
	}

	// 不应把辅助字段写回调用方的 map（同一批文档可能还要写 ES，会污染那边的 schema）。
	for _, key := range []string{"kind", "_time", "_msg"} {
		if _, mutated := fields[key]; mutated {
			t.Errorf("Write() mutated the caller's Fields map with %q", key)
		}
	}
}

func TestVictoriaLogsSinkWriteSkipsEmptyBatch(t *testing.T) {
	var requests int32
	server := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		w.WriteHeader(http.StatusNoContent)
	})

	if err := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, server.URL).Write(context.Background(), nil); err != nil {
		t.Fatalf("Write(nil) error = %v", err)
	}
	if got := atomic.LoadInt32(&requests); got != 0 {
		t.Errorf("empty batch sent %d requests, want 0", got)
	}
}

// 多地址：第一个地址不可用就换下一个（轮询 + 故障切换）。
func TestVictoriaLogsSinkWriteFailsOverToNextEndpoint(t *testing.T) {
	var failing, healthy int32
	broken := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&failing, 1)
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	working := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&healthy, 1)
		w.WriteHeader(http.StatusNoContent)
	})

	sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, broken.URL, working.URL)
	err := sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAccessLog, At: time.Now(), Fields: map[string]any{}},
	})
	if err != nil {
		t.Fatalf("Write() should fail over to the healthy endpoint, got %v", err)
	}
	if got := atomic.LoadInt32(&healthy); got != 1 {
		t.Errorf("healthy endpoint got %d requests, want 1", got)
	}
	if got := atomic.LoadInt32(&failing); got == 0 {
		t.Error("broken endpoint was never tried")
	}
}

// 短暂抖动（503）应当重试并最终成功：这批审计文档不该因为 VL 正在重启就丢掉。
func TestVictoriaLogsSinkWriteRetriesServerErrors(t *testing.T) {
	var attempts int32
	server := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&attempts, 1) < 3 {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, server.URL)
	err := sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAccessLog, At: time.Now(), Fields: map[string]any{}},
	})
	if err != nil {
		t.Fatalf("Write() should succeed after retries, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Errorf("attempts = %d, want 3 (two failures then success)", got)
	}
}

// 4xx 是请求/数据本身的问题，重试只是白跑——必须只请求一次。
func TestVictoriaLogsSinkWriteDoesNotRetryClientErrors(t *testing.T) {
	var attempts int32
	server := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		http.Error(w, "tenant is not authorized", http.StatusForbidden)
	})

	sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, server.URL)
	err := sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAccessLog, At: time.Now(), Fields: map[string]any{}},
	})
	if err == nil {
		t.Fatal("Write() with 4xx should return an error")
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Errorf("attempts = %d, want 1 (client errors must not be retried)", got)
	}
	// 报错要能看出是哪个状态码、对端说了什么（排障时第一眼要看的就是这两个）。
	if !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "tenant is not authorized") {
		t.Errorf("error %q does not surface the status code and response snippet", err)
	}
}

// 4xx 每个地址只发一次（不重试），但仍会换下一个地址：多地址场景下各节点的租户/权限配置未必一致。
func TestVictoriaLogsSinkWriteFailsOverAfterClientError(t *testing.T) {
	var denying, healthy int32
	denied := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&denying, 1)
		http.Error(w, "tenant is not authorized", http.StatusForbidden)
	})
	working := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&healthy, 1)
		w.WriteHeader(http.StatusNoContent)
	})

	sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, denied.URL, working.URL)
	err := sink.Write(context.Background(), []ESDocument{
		{Kind: ESKindAccessLog, At: time.Now(), Fields: map[string]any{}},
	})
	if err != nil {
		t.Fatalf("Write() should fail over after a 4xx, got %v", err)
	}
	if got := atomic.LoadInt32(&denying); got != 1 {
		t.Errorf("denying endpoint got %d requests, want 1 (4xx must not be retried)", got)
	}
	if got := atomic.LoadInt32(&healthy); got != 1 {
		t.Errorf("healthy endpoint got %d requests, want 1", got)
	}
}

func TestToLogsQLQueryRendersConditions(t *testing.T) {
	tests := []struct {
		name    string
		query   archiveQuery
		want    string
		wantErr bool
	}{
		{
			name: "精确匹配与取反",
			query: archiveQuery{kind: ESKindLoginRecord, filters: []archiveCondition{
				{field: esFieldUsername, op: opEq, value: "admin"},
				{field: esFieldResult, op: opNotEq, value: "success"},
			}},
			want: `kind:="login_record" AND username:="admin" AND NOT result:="success"`,
		},
		{
			name: "状态码按数字渲染",
			query: archiveQuery{kind: ESKindAccessLog, filters: []archiveCondition{
				{field: esFieldStatusCode, op: opEq, value: 500},
			}},
			want: `kind:="access_log" AND status_code:=500`,
		},
		{
			name: "关键字在多列里做子串匹配",
			query: archiveQuery{kind: ESKindAuditHistory, filters: []archiveCondition{
				{op: opContains, value: "api", searchFields: []string{esFieldResourceName, esFieldOperatorName}},
			}},
			want: `kind:="audit_history" AND (resource_name:*"api"* OR operator_name:*"api"*)`,
		},
		{
			name: "关键字里的引号与反斜杠被转义",
			query: archiveQuery{kind: ESKindAuditHistory, filters: []archiveCondition{
				{op: opContains, value: `we"ird\`, searchFields: []string{esFieldResourceName}},
			}},
			want: `kind:="audit_history" AND (resource_name:*"we\"ird\\"*)`,
		},
		{
			name: "多值 in",
			query: archiveQuery{kind: ESKindAuditHistory, filters: []archiveCondition{
				{field: esFieldOperationType, op: opIn, value: []any{"view-file", "download-file", "upload-file"}},
			}},
			want: `kind:="audit_history" AND operation_type:in("view-file", "download-file", "upload-file")`,
		},
		{
			name: "空的 in 列表不产生条件",
			query: archiveQuery{kind: ESKindAccessLog, filters: []archiveCondition{
				{field: esFieldOperationType, op: opIn, value: []any{}},
			}},
			want: `kind:="access_log"`,
		},
		{
			name: "不在白名单的字段被拒绝",
			query: archiveQuery{kind: ESKindAuditHistory, filters: []archiveCondition{
				{field: `resource_name:"x" OR *`, op: opEq, value: "boom"},
			}},
			wantErr: true,
		},
		{
			name: "未知条件类型被拒绝",
			query: archiveQuery{kind: ESKindAuditHistory, filters: []archiveCondition{
				{field: esFieldClusterName, op: conditionOp("regexp"), value: "prod"},
			}},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := toLogsQLQuery(test.query)
			if test.wantErr {
				if err == nil {
					t.Fatalf("toLogsQLQuery() = %q, want error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("toLogsQLQuery() error = %v", err)
			}
			if got != test.want {
				t.Errorf("toLogsQLQuery() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestVictoriaLogsSinkSearchBuildsLogsQL(t *testing.T) {
	var pageQuery, countQuery url.Values
	pageHits := `{"ts":"2026-09-20T10:30:00Z","method":"GET"}` + "\n" +
		`{"ts":"2026-09-20T10:31:00Z","method":"POST"}` + "\n"

	server := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("failed to parse form: %v", err)
			return
		}
		if strings.Contains(r.PostForm.Get("query"), "stats count()") {
			countQuery = r.PostForm
			_, _ = w.Write([]byte(`{"total":"123"}`))
			return
		}
		pageQuery = r.PostForm
		_, _ = w.Write([]byte(pageHits))
	})

	sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, server.URL)
	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)

	result, err := sink.Search(context.Background(), archiveQuery{
		kind:      ESKindAccessLog,
		timeField: esFieldTimestamp,
		filters:   []archiveCondition{{field: esFieldMethod, op: opEq, value: "GET"}},
	}, from, to, 2, 20)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	if pageQuery == nil {
		t.Fatal("Search() sent no page query")
	}
	logsQL := pageQuery.Get("query")
	if !strings.Contains(logsQL, `kind:="access_log"`) || !strings.Contains(logsQL, `method:="GET"`) {
		t.Errorf("query = %q, want the kind and the eq filter rendered as LogsQL", logsQL)
	}
	// 只取检索页需要的列：VL 按列存盘，少读列就少读盘。
	if !strings.Contains(logsQL, "| fields ts, client_ip, method, path, status_code, latency_ms, cluster, user") {
		t.Errorf("query = %q, want a `| fields` pipe with the archive columns", logsQL)
	}
	// 时间窗走 HTTP 参数（end 为开区间，与 [from, to) 语义一致），不写进 LogsQL。
	if strings.Contains(logsQL, "_time:") {
		t.Errorf("query = %q must carry the time window via start/end args, not a _time filter", logsQL)
	}
	if pageQuery.Get("start") != from.Format(time.RFC3339) || pageQuery.Get("end") != to.Format(time.RFC3339) {
		t.Errorf("time window = %q/%q, want %q/%q",
			pageQuery.Get("start"), pageQuery.Get("end"), from.Format(time.RFC3339), to.Format(time.RFC3339))
	}
	// 分页：limit + offset，且**不**加 sort 管道（limit 已按 _time 倒序返回）。
	if pageQuery.Get("limit") != "20" || pageQuery.Get("offset") != "20" {
		t.Errorf("pagination = limit %q offset %q, want 20/20", pageQuery.Get("limit"), pageQuery.Get("offset"))
	}
	if strings.Contains(logsQL, "sort") {
		t.Errorf("query = %q must not add a sort pipe, limit already returns the most recent entries", logsQL)
	}

	if len(result.Hits) != 2 {
		t.Fatalf("Hits = %d, want 2", len(result.Hits))
	}
	if string(result.Hits[0]) != `{"ts":"2026-09-20T10:30:00Z","method":"GET"}` {
		t.Errorf("Hits[0] = %s, want the response line verbatim", result.Hits[0])
	}

	if countQuery == nil {
		t.Fatal("Search() sent no count query")
	}
	if !strings.Contains(countQuery.Get("query"), "| stats count() total") {
		t.Errorf("count query = %q, want a `| stats count() total` pipe", countQuery.Get("query"))
	}
	if countQuery.Get("limit") != "" || countQuery.Get("offset") != "" {
		t.Errorf("count query must not carry pagination, got limit %q offset %q",
			countQuery.Get("limit"), countQuery.Get("offset"))
	}
	// 总数也必须落在同一个时间窗里，否则与列表页对不上。
	if countQuery.Get("start") != from.Format(time.RFC3339) || countQuery.Get("end") != to.Format(time.RFC3339) {
		t.Errorf("count query time window = %q/%q, want the requested range",
			countQuery.Get("start"), countQuery.Get("end"))
	}
	if result.Total != 123 {
		t.Errorf("Total = %d, want 123", result.Total)
	}
}

// 总数拿不到只是少一个「共 N 条」，不该让整页检索失败；拿得到时字符串/数字都要认。
func TestVictoriaLogsSinkSearchToleratesUnexpectedTotal(t *testing.T) {
	tests := []struct {
		name  string
		count string
		want  int64
	}{
		{name: "字符串（VL 的实际格式）", count: `{"total":"123"}`, want: 123},
		{name: "数字", count: `{"total":7}`, want: 7},
		{name: "空响应体（没有命中）", count: ``, want: 0},
		{name: "字段缺失", count: `{"other":"1"}`, want: 0},
		{name: "不是数字", count: `{"total":"not-a-number"}`, want: 0},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
				if err := r.ParseForm(); err != nil {
					t.Errorf("failed to parse form: %v", err)
					return
				}
				if strings.Contains(r.PostForm.Get("query"), "stats count()") {
					_, _ = w.Write([]byte(test.count))
					return
				}
				_, _ = w.Write([]byte(`{"ts":"2026-09-20T10:30:00Z"}` + "\n"))
			})

			sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, server.URL)
			result, err := sink.Search(context.Background(), archiveQuery{kind: ESKindAccessLog}, time.Time{}, time.Time{}, 1, 20)
			if err != nil {
				t.Fatalf("Search() error = %v", err)
			}
			if result.Total != test.want {
				t.Errorf("Total = %d, want %d", result.Total, test.want)
			}
			if len(result.Hits) != 1 {
				t.Errorf("Hits = %d, want 1 (the total must not affect the page)", len(result.Hits))
			}
		})
	}
}

func TestVictoriaLogsSinkSearchSurfacesErrors(t *testing.T) {
	server := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>bad gateway</html>"))
	})

	sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, server.URL)
	_, err := sink.Search(context.Background(), archiveQuery{kind: ESKindAccessLog}, time.Time{}, time.Time{}, 1, 20)
	if err == nil {
		t.Fatal("Search() with 502 should return an error")
	}
	if !strings.Contains(err.Error(), "502") || !strings.Contains(err.Error(), server.URL) {
		t.Errorf("error %q does not surface the address and status code", err)
	}
}

func TestVictoriaLogsSinkPing(t *testing.T) {
	var query, limit string
	reachable := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("failed to parse form: %v", err)
			return
		}
		query = r.PostForm.Get("query")
		limit = r.PostForm.Get("limit")
		w.WriteHeader(http.StatusOK)
	})

	if err := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, reachable.URL).Ping(context.Background()); err != nil {
		t.Fatalf("Ping() error = %v", err)
	}
	if query != "*" || limit != "1" {
		t.Errorf("ping query = %q limit = %q, want * and 1", query, limit)
	}

	broken := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	})
	err := newVictoriaLogsSink(t, model.VictoriaLogsArchive{}, broken.URL).Ping(context.Background())
	if err == nil {
		t.Fatal("Ping() against a failing instance should return an error")
	}
	if !strings.Contains(err.Error(), "503") || !strings.Contains(err.Error(), broken.URL) {
		t.Errorf("error %q does not surface the address and status code", err)
	}
}

// 回归（验收台账 D-177）：界面上填的 archive.victorialogs.stream 以前**完全不生效**——
// 它存库、也参与 recordArchiveSettingChange 的变更留痕比对，但导出器通篇只引用 urls，
// 实测 VL 里 `_stream` 恒为默认流 `{}`，用户以为做了流隔离其实没有。
//
// 在活的 VictoriaLogs 上对照过三种写法，只有下面这件管用：bulk 动作里填 ES 习惯的
// `_index` **不分流**（仍是 `{}`），必须「文档带 stream 字段」+「查询串带
// _stream_fields=stream」两件一起做。
func TestVictoriaLogsSinkWriteHonorsConfiguredStream(t *testing.T) {
	cases := []struct {
		name       string
		stream     string
		wantURI    string
		wantStream bool
	}{
		{name: "填了 stream：带上分流字段与查询参数", stream: "aerolink-r24",
			wantURI: "/insert/elasticsearch/_bulk?_stream_fields=stream", wantStream: true},
		// 不兜默认值：已有部署都写在 VL 自己的默认流里，静默改流会让旧记录与新记录分在两处。
		{name: "没填 stream：保持现状", stream: "",
			wantURI: "/insert/elasticsearch/_bulk", wantStream: false},
		{name: "只有空格：等同没填", stream: "   ",
			wantURI: "/insert/elasticsearch/_bulk", wantStream: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var uri, body string
			server := newFakeVictoriaLogs(t, func(w http.ResponseWriter, r *http.Request) {
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("failed to read request body: %v", err)
				}
				// RequestURI 含查询串；只看 Path 会漏掉 _stream_fields。
				uri = r.URL.RequestURI()
				body = string(raw)
				w.WriteHeader(http.StatusNoContent)
			})

			sink := newVictoriaLogsSink(t, model.VictoriaLogsArchive{Stream: tc.stream}, server.URL)
			fields := map[string]any{"cluster_name": "prod"}
			if err := sink.Write(context.Background(), []ESDocument{
				{Kind: ESKindAuditHistory, At: time.Now(), Fields: fields},
			}); err != nil {
				t.Fatalf("Write() error = %v", err)
			}

			if uri != tc.wantURI {
				t.Errorf("insert URI = %q, want %q", uri, tc.wantURI)
			}
			want := strings.TrimSpace(tc.stream)
			hasStream := want != "" && strings.Contains(body, `"stream":"`+want+`"`)
			if hasStream != tc.wantStream {
				t.Errorf("bulk body 里 stream 字段存在=%v, want %v; body=%s", hasStream, tc.wantStream, body)
			}
			if _, mutated := fields["stream"]; mutated {
				t.Error("Write() 把 stream 写回了调用方的 Fields map")
			}
		})
	}
}
