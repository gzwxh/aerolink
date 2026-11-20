//go:build !duckdb_cli

package audit

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/parquet-go/parquet-go"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

// SDK 驱动的测试必须用**真实的 parquet 文件**：CLI 驱动的测试可以用假脚本断言「发出去的
// SQL」，但 SDK 是进程内真引擎，没有可拦截的中间层——喂假文件只会得到解析错误。

// writeOperationParquet 用与生产同一套 writer 落一个真实的 parquet 文件。
func writeOperationParquet(t *testing.T, archiveDir string, day time.Time, rows []operationLogRow) {
	t.Helper()

	dir := filepath.Join(archiveDir, string(KindAuditHistory), day.Format("2006"), day.Format("01"), day.Format("02"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	path := filepath.Join(dir, "audit_history-test.parquet")

	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	writer := parquet.NewGenericWriter[operationLogRow](file)
	if _, err := writer.Write(rows); err != nil {
		t.Fatalf("write parquet: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close parquet writer: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close %s: %v", path, err)
	}
}

// sampleOperationRows 造三条记录：两条 prod（第二条更晚）、一条 dev。
func sampleOperationRows(day time.Time) []operationLogRow {
	return []operationLogRow{
		{
			ID: 1, CreatedAt: day.Add(1 * time.Hour).UnixMilli(),
			ClusterName: "prod", ResourceType: "pods", ResourceName: "nginx-a", Namespace: "default",
			OperationType: "delete", Success: true, ClientIP: "10.0.0.1", OperatorName: "alice",
			// 大字段：断言它不会出现在检索结果里（列裁剪）。
			ResourceYAML: "kind: Pod\nmetadata:\n  name: nginx-a\n",
		},
		{
			ID: 2, CreatedAt: day.Add(2 * time.Hour).UnixMilli(),
			ClusterName: "prod", ResourceType: "deployments", ResourceName: "web", Namespace: "default",
			OperationType: "update", Success: false, ErrorMessage: "conflict",
			ClientIP: "10.0.0.2", OperatorName: "bob", UserAgent: "kubectl/1.30",
		},
		{
			ID: 3, CreatedAt: day.Add(3 * time.Hour).UnixMilli(),
			ClusterName: "dev", ResourceType: "pods", ResourceName: "nginx-c", Namespace: "kube-system",
			OperationType: "delete", Success: true, ClientIP: "10.0.0.3", OperatorName: "carol",
		},
	}
}

// SDK 后端能查真实 parquet，并且结果形态与 CLI 驱动一致（毫秒→RFC3339、列裁剪、DESC 排序）。
func TestDuckDBSDKBackendSearchesRealParquet(t *testing.T) {
	day := time.Date(2026, 9, 21, 0, 0, 0, 0, time.Local)
	localDir := t.TempDir()
	writeOperationParquet(t, localDir, day, sampleOperationRows(day))

	backend, err := NewDuckDBBackend(localDir, model.S3Archive{})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}
	if _, ok := backend.runner.(*duckdbSDKRunner); !ok {
		t.Fatalf("runner = %T, want *duckdbSDKRunner（SDK 构建下应优先用进程内引擎）", backend.runner)
	}

	result, err := backend.Search(context.Background(), archiveQuery{
		kind:      ESKindAuditHistory,
		timeField: esFieldCreatedAt,
		filters: []archiveCondition{
			{field: esFieldClusterName, op: opEq, value: "prod"},
		},
	}, day, day.Add(24*time.Hour), 1, 20)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	if result.Total != 2 {
		t.Errorf("total = %d, want 2（只有 prod 的两条）", result.Total)
	}
	if len(result.Hits) != 2 {
		t.Fatalf("hits = %d, want 2", len(result.Hits))
	}

	first := decodeArchiveHit(t, result.Hits[0])
	// ORDER BY created_at DESC：ID=2 时间最晚，应排在第一行。
	if first["resource_name"] != "web" {
		t.Errorf("第一行 resource_name = %v, want web（ID=2 时间最晚）", first["resource_name"])
	}

	// 毫秒整数必须已经被转成 RFC3339：两个驱动都要给前端同一套渲染输入。
	createdAt := time.UnixMilli(day.Add(2 * time.Hour).UnixMilli()).Format(time.RFC3339)
	if first[esFieldCreatedAt] != createdAt {
		t.Errorf("created_at = %v, want %q", first[esFieldCreatedAt], createdAt)
	}
	if _, ok := first["resource_yaml"]; ok {
		t.Error("resource_yaml 不该进 SELECT 结果（列裁剪）")
	}
	if _, ok := first["__total"]; ok {
		t.Error("__total 是实现细节，不应出现在结果行里")
	}
	// 布尔与数字必须保持原生 JSON 类型，而不是被 base64/字符串化。
	if success, ok := first["success"].(bool); !ok || success {
		t.Errorf("success = %v (%T), want false", first["success"], first["success"])
	}
	if id, ok := first["id"].(float64); !ok || int64(id) != 2 {
		t.Errorf("id = %v (%T), want 2", first["id"], first["id"])
	}
}

// 分页：第二页只拿到剩下的那条，且总数不变（count(*) OVER () 在 LIMIT 之前算）。
func TestDuckDBSDKBackendPaginates(t *testing.T) {
	day := time.Date(2026, 9, 21, 0, 0, 0, 0, time.Local)
	localDir := t.TempDir()
	writeOperationParquet(t, localDir, day, sampleOperationRows(day))

	backend, err := NewDuckDBBackend(localDir, model.S3Archive{})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}

	result, err := backend.Search(context.Background(), archiveQuery{
		kind:      ESKindAuditHistory,
		timeField: esFieldCreatedAt,
	}, day, day.Add(24*time.Hour), 3, 1)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if result.Total != 3 {
		t.Errorf("total = %d, want 3（总数与分页无关）", result.Total)
	}
	if len(result.Hits) != 1 {
		t.Fatalf("hits = %d, want 1", len(result.Hits))
	}
	if row := decodeArchiveHit(t, result.Hits[0]); int64(row["id"].(float64)) != 1 {
		t.Errorf("第三页应是 ID=1（时间最早）: %v", row["id"])
	}
}

// 去重 SQL 必须能被真实引擎执行：本地与「远端」互有独占时两边都扫，同一个
// 文件（文件名相同）按 (文件名, 行号) 去重。这里用第二个本地目录模拟远端路径，
// SQL 层面只关心路径字符串，与真实 S3 布局同构。
func TestDuckDBSDKBackendDedupsSharedCopies(t *testing.T) {
	day := time.Date(2026, 9, 21, 0, 0, 0, 0, time.Local)
	localDir := t.TempDir()
	writeOperationParquet(t, localDir, day, sampleOperationRows(day))

	remoteDir := t.TempDir()
	writeOperationParquet(t, remoteDir, day, sampleOperationRows(day))

	backend, err := NewDuckDBBackend(localDir, model.S3Archive{})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}

	dayDir := filepath.Join(localDir, string(KindAuditHistory), "2026", "09", "21")
	remoteDayDir := filepath.Join(remoteDir, string(KindAuditHistory), "2026", "09", "21")
	statement, err := buildDuckDBSQL(archiveQuery{
		kind:      ESKindAuditHistory,
		timeField: esFieldCreatedAt,
	}, archiveColumnsFor(ESKindAuditHistory), []string{
		filepath.Join(dayDir, "*.parquet"),
		filepath.Join(remoteDayDir, "*.parquet"),
	}, true, day, day.Add(24*time.Hour), 1, 20)
	if err != nil {
		t.Fatalf("buildDuckDBSQL() error = %v", err)
	}

	rows, err := backend.runner.Query(context.Background(), nil, statement)
	if err != nil {
		t.Fatalf("dedup query failed: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3（同一份文件的两个副本必须去重）", len(rows))
	}
	if total := toInt64(rows[0]["__total"]); total != 3 {
		t.Errorf("__total = %d, want 3（count 必须在去重后的行集上算）", total)
	}
	ids := map[int64]bool{}
	for _, row := range rows {
		ids[toInt64(row["id"])] = true
	}
	if len(ids) != 3 {
		t.Errorf("ids = %v, want the three distinct rows", ids)
	}
}

// 该时间段没有任何归档文件时返回空结果，而不是抛引擎错误。
func TestDuckDBSDKBackendEmptyRange(t *testing.T) {
	backend, err := NewDuckDBBackend(t.TempDir(), model.S3Archive{})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}

	day := time.Date(2026, 9, 21, 0, 0, 0, 0, time.Local)
	result, err := backend.Search(context.Background(), archiveQuery{
		kind: ESKindAuditHistory, timeField: esFieldCreatedAt,
	}, day, day.Add(24*time.Hour), 1, 20)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if result.Total != 0 || len(result.Hits) != 0 {
		t.Errorf("无归档文件时应返回空结果: total=%d hits=%d", result.Total, len(result.Hits))
	}
	// 必须是空切片而不是 nil：nil 会序列化成 `data: null`，界面 data.length 会崩。
	if result.Hits == nil {
		t.Error("无归档文件时 Hits 不能是 nil（应为空切片）")
	}
}

// 跨驱动一致性：同一份 parquet，SDK 与 CLI 必须给出**完全相同**的结果。
//
// 这是「切换驱动」最容易出问题的地方：两个驱动的类型系统不同（SDK 给原生 int64/[]byte，
// CLI 给 JSON 的 float64/string），一旦归一化有偏差，前端就会出现「同一个查询换后端变样」。
func TestDuckDBDriversAgreeOnSameData(t *testing.T) {
	if !duckdbCLIAvailable() {
		t.Skip("duckdb cli is not installed; skipping the cross-driver comparison")
	}

	day := time.Date(2026, 9, 21, 0, 0, 0, 0, time.Local)
	localDir := t.TempDir()
	writeOperationParquet(t, localDir, day, sampleOperationRows(day))

	query := archiveQuery{
		kind:      ESKindAuditHistory,
		timeField: esFieldCreatedAt,
		filters: []archiveCondition{
			{field: esFieldClusterName, op: opEq, value: "prod"},
		},
	}
	from, to := day, day.Add(24*time.Hour)

	sdkBackend, err := NewDuckDBBackend(localDir, model.S3Archive{})
	if err != nil {
		t.Fatalf("NewDuckDBBackend() error = %v", err)
	}
	sdkResult, err := sdkBackend.Search(context.Background(), query, from, to, 1, 20)
	if err != nil {
		t.Fatalf("sdk Search() error = %v", err)
	}

	cliRunner, err := newDuckDBCLIRunner()
	if err != nil {
		t.Fatalf("newDuckDBCLIRunner() error = %v", err)
	}
	cliBackend := &DuckDBBackend{runner: cliRunner, localDir: localDir}
	cliResult, err := cliBackend.Search(context.Background(), query, from, to, 1, 20)
	if err != nil {
		t.Fatalf("cli Search() error = %v", err)
	}

	if sdkResult.Total != cliResult.Total {
		t.Errorf("total 不一致: sdk=%d cli=%d", sdkResult.Total, cliResult.Total)
	}
	if len(sdkResult.Hits) != len(cliResult.Hits) {
		t.Fatalf("命中数不一致: sdk=%d cli=%d", len(sdkResult.Hits), len(cliResult.Hits))
	}
	for i := range sdkResult.Hits {
		sdkRow := decodeArchiveHit(t, sdkResult.Hits[i])
		cliRow := decodeArchiveHit(t, cliResult.Hits[i])
		if len(sdkRow) != len(cliRow) {
			t.Errorf("第 %d 行字段数不一致: sdk=%d cli=%d", i, len(sdkRow), len(cliRow))
		}
		for key, sdkValue := range sdkRow {
			cliValue, ok := cliRow[key]
			if !ok {
				t.Errorf("第 %d 行缺少字段 %s（sdk 有 cli 没有）", i, key)
				continue
			}
			if sdkValue != cliValue {
				t.Errorf("第 %d 行字段 %s 不一致: sdk=%v(%T) cli=%v(%T)",
					i, key, sdkValue, sdkValue, cliValue, cliValue)
			}
		}
	}
}

// decodeArchiveHit 把一条命中解成 map，便于断言。
func decodeArchiveHit(t *testing.T, hit json.RawMessage) map[string]any {
	t.Helper()
	var row map[string]any
	if err := json.Unmarshal(hit, &row); err != nil {
		t.Fatalf("hit is not valid JSON: %v", err)
	}
	return row
}

// fakeExecer 是 driver.ExecerContext 的替身：记录执行过的语句，按子串决定哪些失败。
type fakeExecer struct {
	failOn   string
	executed []string
}

func (f *fakeExecer) ExecContext(_ context.Context, statement string, _ []driver.NamedValue) (driver.Result, error) {
	f.executed = append(f.executed, statement)
	if f.failOn != "" && strings.Contains(statement, f.failOn) {
		return nil, errors.New("statement failed")
	}
	return driver.RowsAffected(0), nil
}

// S3 初始化失败（装不上 httpfs、扩展目录不可写）不能把整个引擎拖下水：
// 本地 parquet 检索不依赖 httpfs，最近几天的审计日志必须照常可查。
func TestDuckDBSDKInitializeKeepsLocalSearchWhenS3Fails(t *testing.T) {
	runner := newDuckDBSDKRunner(model.S3Archive{Enabled: true, Endpoint: "cos.example.com", Bucket: "bucket"})
	execer := &fakeExecer{failOn: "INSTALL httpfs"}

	if err := runner.initialize(execer); err != nil {
		t.Fatalf("initialize() error = %v, want nil（S3 只是可选能力）", err)
	}
	if err := runner.s3Unavailable("SELECT * FROM read_parquet(['s3://bucket/x.parquet'])"); err == nil {
		t.Error("S3 初始化失败后，读 s3:// 的语句必须给出明确原因")
	}
	if err := runner.s3Unavailable("SELECT * FROM read_parquet(['/tmp/x.parquet'])"); err != nil {
		t.Errorf("本地语句不该被 S3 的失败牵连: %v", err)
	}

	// 第一条 S3 语句失败后就该停：SET s3_* 每条都会再触发一次扩展 autoload，继续没有意义。
	for _, statement := range execer.executed {
		if strings.HasPrefix(statement, "SET s3_") {
			t.Errorf("S3 初始化失败后不应继续执行 %q", statement)
		}
	}
}

// 引擎自身的会话设置失败仍是硬错误——那不是可选能力。
func TestDuckDBSDKInitializeFailsOnCoreStatementError(t *testing.T) {
	runner := newDuckDBSDKRunner(model.S3Archive{})
	execer := &fakeExecer{failOn: "SET memory_limit"}

	if err := runner.initialize(execer); err == nil {
		t.Fatal("核心 SET 失败必须让初始化失败")
	}
}

// S3 全部就绪时不该留下「不可用」标记。
func TestDuckDBSDKInitializeS3Success(t *testing.T) {
	runner := newDuckDBSDKRunner(model.S3Archive{Enabled: true, Endpoint: "https://cos.example.com", Bucket: "bucket"})
	if err := runner.initialize(&fakeExecer{}); err != nil {
		t.Fatalf("initialize() error = %v", err)
	}
	if err := runner.s3Unavailable("SELECT * FROM read_parquet(['s3://bucket/x.parquet'])"); err != nil {
		t.Errorf("S3 初始化成功后不该报不可用: %v", err)
	}
}

// 扩展目录必须显式落定：DuckDB 默认的 ~/.duckdb 在容器里不可写（HOME 属主是 root）。
func TestDuckdbS3StatementsPinExtensionDirectory(t *testing.T) {
	original := common.DuckDBExtensionDir
	common.DuckDBExtensionDir = t.TempDir()
	t.Cleanup(func() { common.DuckDBExtensionDir = original })

	statements := duckdbS3Statements(model.S3Archive{Enabled: true, Endpoint: "cos.example.com", Bucket: "bucket"})
	joined := strings.Join(statements, "; ")
	want := "SET extension_directory='" + common.DuckDBExtensionDir + "'"
	if !strings.Contains(joined, want) {
		t.Errorf("S3 语句应把扩展目录固定为 %q:\n%s", common.DuckDBExtensionDir, joined)
	}
	if index, install := strings.Index(joined, want), strings.Index(joined, "INSTALL httpfs"); index < 0 || install < 0 || index > install {
		t.Error("扩展目录必须在 INSTALL 之前设置，否则扩展会被装到默认目录")
	}
}
