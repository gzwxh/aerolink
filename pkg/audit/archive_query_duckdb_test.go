//go:build duckdb_cli

package audit

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// newFakeDuckDB 造一个假 CLI：把收到的参数（SQL）追加写进日志文件，并输出固定 JSON。
// 真实二进制留给联调，单元测试只关心「我们发出去的 SQL」与「拿回来的结果怎么处理」。
func newFakeDuckDB(t *testing.T, response string) (sqlLog string) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "duckdb")
	sqlLog = filepath.Join(dir, "sql.log")

	content := "#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + sqlLog + "\n" +
		"cat <<'EOF'\n" + response + "\nEOF\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatalf("write fake duckdb: %v", err)
	}
	t.Setenv(duckdbPathEnv, script)
	return sqlLog
}

func readSQLLog(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read sql log: %v", err)
	}
	return string(raw)
}

// 本地有当天的目录就用本地路径，不该再去碰 S3；同时必须做列裁剪（不带大字段）。
func TestDuckDBBackendPrefersLocalParquet(t *testing.T) {
	sqlLog := newFakeDuckDB(t, `[{"__total": 42, "id": 7, "created_at": 1758396000000, "cluster_name": "prod"}]`)

	localDir := t.TempDir()
	dayDir := filepath.Join(localDir, string(KindAuditHistory), "2026", "09", "21")
	if err := os.MkdirAll(dayDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dayDir, "audit_history-1.parquet"), []byte("PAR1"), 0o644); err != nil {
		t.Fatalf("write parquet: %v", err)
	}

	backend, err := NewDuckDBBackend(localDir, model.S3Archive{
		Enabled: true, Endpoint: "https://cos.ap-guangzhou.myqcloud.com",
		Bucket: "bucket", Prefix: "wxh-test", Region: "ap-guangzhou",
	})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}

	from := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	to := from.Add(24 * time.Hour)
	result, err := backend.Search(context.Background(), archiveQuery{
		kind:      ESKindAuditHistory,
		timeField: esFieldCreatedAt,
		filters: []archiveCondition{
			{field: esFieldClusterName, op: opEq, value: "prod"},
		},
	}, from, to, 1, 20)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	if result.Total != 42 {
		t.Errorf("total = %d, want 42 (from count(*) OVER ())", result.Total)
	}
	if len(result.Hits) != 1 {
		t.Fatalf("hits = %d, want 1", len(result.Hits))
	}

	var row map[string]any
	if err := json.Unmarshal(result.Hits[0], &row); err != nil {
		t.Fatalf("hit is not valid JSON: %v", err)
	}
	// parquet 里是毫秒整数，必须转成 RFC3339，前端才能用同一套渲染逻辑。
	want := time.UnixMilli(1758396000000).Format(time.RFC3339)
	if row["created_at"] != want {
		t.Errorf("created_at = %v, want %q", row["created_at"], want)
	}
	if _, ok := row["__total"]; ok {
		t.Error("__total 是实现细节，不应出现在结果行里")
	}

	sql := readSQLLog(t, sqlLog)
	if !strings.Contains(sql, dayDir) {
		t.Errorf("SQL 应包含本地当天目录 %s:\n%s", dayDir, sql)
	}
	if strings.Contains(sql, "s3://") {
		t.Errorf("本地已有当天数据时不应再查 S3:\n%s", sql)
	}
	if strings.Contains(sql, "resource_yaml") {
		t.Error("大字段 resource_yaml 不该进 SELECT（列裁剪）")
	}
	if !strings.Contains(sql, "cluster_name = 'prod'") {
		t.Errorf("过滤条件没有被渲染成 SQL:\n%s", sql)
	}
	if !strings.Contains(sql, "count(*) OVER ()") {
		t.Errorf("应一次查询同时拿到总数与当前页:\n%s", sql)
	}
}

// fakeS3Lister 只回答「这个前缀下有哪些键」，用来在单测里替掉真实对象存储。
type fakeS3Lister struct {
	keys map[string][]string
	err  error
}

func (f fakeS3Lister) ListKeys(_ context.Context, prefix string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.keys[prefix], nil
}

// 本地没有的日期回落到 S3（且只把 S3 上确实有文件的日期写进查询），并带上 httpfs 配置。
func TestDuckDBBackendFallsBackToS3(t *testing.T) {
	sqlLog := newFakeDuckDB(t, `[{"__total": 1, "ts": 1758396000000, "method": "GET"}]`)

	backend, err := NewDuckDBBackend(t.TempDir(), model.S3Archive{
		Enabled:  true,
		Endpoint: "https://cos.ap-guangzhou.myqcloud.com",
		Bucket:   "devops-1253764832",
		Prefix:   "wxh-test/aerolink-audit-test",
		Region:   "ap-guangzhou",
		UseTLS:   true,
		// PathStyle=false → virtual-hosted（腾讯 COS 强制要求）。
		PathStyle: false,
	})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}
	// S3 上只有 09/21 有文件：09/22（时间范围内的另一天）必须被排除，
	// 否则 DuckDB 会因为 glob 无匹配直接报错。
	backend.s3Sink = fakeS3Lister{keys: map[string][]string{
		"wxh-test/aerolink-audit-test/access_log/2026/09/": {
			"wxh-test/aerolink-audit-test/access_log/2026/09/21/access_log-1.parquet",
		},
	}}

	from := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	if _, err := backend.Search(context.Background(), archiveQuery{
		kind:      ESKindAccessLog,
		timeField: esFieldTimestamp,
	}, from, from.Add(48*time.Hour), 1, 20); err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	sql := readSQLLog(t, sqlLog)
	if !strings.Contains(sql, "INSTALL httpfs") || !strings.Contains(sql, "LOAD httpfs") {
		t.Errorf("查 S3 前应加载 httpfs:\n%s", sql)
	}
	wantPath := "s3://devops-1253764832/wxh-test/aerolink-audit-test/access_log/2026/09/21/*.parquet"
	if !strings.Contains(sql, wantPath) {
		t.Errorf("SQL 应包含 S3 路径 %s:\n%s", wantPath, sql)
	}
	if strings.Contains(sql, "2026/09/22/*.parquet") {
		t.Errorf("S3 上没有文件的日期不该进 SQL（会让整次查询报错）:\n%s", sql)
	}
	if !strings.Contains(sql, "SET s3_url_style='vhost'") {
		t.Errorf("COS 需要 virtual-hosted 寻址:\n%s", sql)
	}
	if !strings.Contains(sql, "SET s3_endpoint='cos.ap-guangzhou.myqcloud.com'") {
		t.Errorf("s3_endpoint 应去掉协议头:\n%s", sql)
	}
}

// S3 探测失败时降级为「只查本地」，而不是让整次检索失败。
func TestDuckDBBackendToleratesS3ProbeFailure(t *testing.T) {
	sqlLog := newFakeDuckDB(t, `[{"__total": 3, "ts": 1758396000000, "method": "GET"}]`)

	localDir := t.TempDir()
	dayDir := filepath.Join(localDir, string(KindAccessLog), "2026", "09", "21")
	if err := os.MkdirAll(dayDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dayDir, "access_log-1.parquet"), []byte("PAR1"), 0o644); err != nil {
		t.Fatalf("write parquet: %v", err)
	}

	backend, err := NewDuckDBBackend(localDir, model.S3Archive{
		Enabled: true, Endpoint: "https://cos.ap-guangzhou.myqcloud.com",
		Bucket: "bucket", Region: "ap-guangzhou",
	})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}
	backend.s3Sink = fakeS3Lister{err: errors.New("s3 is down")}

	from := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	result, err := backend.Search(context.Background(), archiveQuery{
		kind:      ESKindAccessLog,
		timeField: esFieldTimestamp,
	}, from, from.Add(48*time.Hour), 1, 20)
	if err != nil {
		t.Fatalf("S3 探测失败不应让检索整体失败: %v", err)
	}
	if result.Total != 3 {
		t.Errorf("total = %d, want 3（本地结果照常返回）", result.Total)
	}

	sql := readSQLLog(t, sqlLog)
	if !strings.Contains(sql, dayDir) {
		t.Errorf("本地路径应照常参与查询:\n%s", sql)
	}
	if strings.Contains(sql, "s3://") {
		t.Errorf("S3 探测失败后不应把 S3 路径写进 SQL:\n%s", sql)
	}
}

// 时间范围缺省补默认跨度；过大直接拒绝（对象存储上扫全桶是灾难）。
func TestNormalizeDuckDBRange(t *testing.T) {
	now := time.Now()
	from, to, err := normalizeDuckDBRange(time.Time{}, time.Time{})
	if err != nil {
		t.Fatalf("normalizeDuckDBRange(zero) error = %v", err)
	}
	if to.Sub(from) < 6*24*time.Hour || to.Sub(from) > 8*24*time.Hour {
		t.Errorf("默认跨度 = %v, want 约 7 天", to.Sub(from))
	}

	if _, _, err := normalizeDuckDBRange(now.AddDate(0, 0, -200), now); err == nil {
		t.Error("超过上限的时间跨度应被拒绝")
	}
	if _, _, err := normalizeDuckDBRange(now, now.Add(-time.Hour)); err == nil {
		t.Error("from 晚于 to 应被拒绝")
	}
}

// 多段输出（先 SET 后 SELECT）也要能解析出 SELECT 的数组。
func TestParseDuckDBJSONHandlesMultipleStatements(t *testing.T) {
	raw := []byte("{\"Success\":true}\n[{\"__total\":1,\"id\":3}]\n")
	rows, err := parseDuckDBJSON(raw)
	if err != nil {
		t.Fatalf("parseDuckDBJSON() error = %v", err)
	}
	if len(rows) != 1 || toInt64(rows[0]["id"]) != 3 {
		t.Errorf("rows = %v, want the SELECT result", rows)
	}

	rows, err = parseDuckDBJSON([]byte("[]"))
	if err != nil || len(rows) != 0 {
		t.Errorf("空结果应解析为空切片: rows=%v err=%v", rows, err)
	}
}

// SQL 注入面：字段名必须过白名单，值里的单引号必须转义。
func TestToSQLWhereRejectsUnknownColumnsAndEscapesValues(t *testing.T) {
	if _, err := toSQLWhere([]archiveCondition{{field: "id; DROP TABLE x", op: opEq, value: "1"}},
		esFieldCreatedAt, time.Time{}, time.Time{}); err == nil {
		t.Error("非白名单列名必须被拒绝")
	}

	where, err := toSQLWhere([]archiveCondition{{field: esFieldClusterName, op: opEq, value: "a'b"}},
		esFieldCreatedAt, time.Time{}, time.Time{})
	if err != nil {
		t.Fatalf("toSQLWhere() error = %v", err)
	}
	if !strings.Contains(where, `cluster_name = 'a''b'`) {
		t.Errorf("单引号应被翻倍转义: %s", where)
	}

	if _, err := toSQLWhere([]archiveCondition{{field: esFieldClusterName, op: opEq, value: "a\x00b"}},
		esFieldCreatedAt, time.Time{}, time.Time{}); err == nil {
		t.Error("含 NUL 的值必须被拒绝")
	}
}

// 关键字检索渲染成多列 ILIKE（大小写不敏感）。
func TestToSQLWhereRendersContainsAsILike(t *testing.T) {
	where, err := toSQLWhere([]archiveCondition{
		{op: opContains, value: "nginx", searchFields: []string{esFieldResourceName, esFieldOperatorName}},
	}, esFieldCreatedAt, time.Time{}, time.Time{})
	if err != nil {
		t.Fatalf("toSQLWhere() error = %v", err)
	}
	if !strings.Contains(where, "resource_name ILIKE '%' || 'nginx' || '%'") ||
		!strings.Contains(where, "operator_name ILIKE '%' || 'nginx' || '%'") ||
		!strings.Contains(where, " OR ") {
		t.Errorf("contains 条件渲染不正确: %s", where)
	}
}

// 该时间段没有任何归档文件时返回空结果，而不是拉起 CLI 报错。
func TestDuckDBBackendReturnsEmptyWhenNoArchiveFiles(t *testing.T) {
	newFakeDuckDB(t, `[{"__total": 0}]`)
	backend, err := NewDuckDBBackend(t.TempDir(), model.S3Archive{})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}

	from := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	result, err := backend.Search(context.Background(), archiveQuery{
		kind: ESKindAuditHistory, timeField: esFieldCreatedAt,
	}, from, from.Add(24*time.Hour), 1, 20)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if result.Total != 0 || len(result.Hits) != 0 {
		t.Errorf("无归档文件时应返回空结果: total=%d hits=%d", result.Total, len(result.Hits))
	}
}
