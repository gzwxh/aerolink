package audit

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// fakeS3Lister 只回答「这个前缀下有哪些键」，用来在单测里替掉真实对象存储。
// 放在无构建标签的文件里：CLI（duckdb_cli）与 SDK（默认构建）两种测试都能用。
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

// planTestBackend 构造一个不触发网络/引擎的 DuckDBBackend：路径规划不经过 runner。
func planTestBackend(localDir string, keys map[string][]string) *DuckDBBackend {
	return &DuckDBBackend{
		localDir: localDir,
		s3:       model.S3Archive{Enabled: true, Bucket: "bucket", Prefix: "pre"},
		s3Sink:   fakeS3Lister{keys: keys},
	}
}

func writeLocalParquet(t *testing.T, localDir string, kind ParquetKind, day time.Time, names ...string) {
	t.Helper()
	dayDir := filepath.Join(localDir, string(kind), day.Format("2006"), day.Format("01"), day.Format("02"))
	if err := os.MkdirAll(dayDir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dayDir, err)
	}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dayDir, name), []byte("PAR1"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
}

// 回归：同一天本地只剩部分文件时，S3 上其余文件仍要参与查询。旧实现
// 「本地有一个文件就整条跳过 S3」会静默漏掉 S3 独有的数据——容量清理只删
// 当天较旧的一部分、多副本各写各的本地目录，都会造成这种部分覆盖。
func TestParquetGlobsMergesPartialDayAcrossLocalAndS3(t *testing.T) {
	day := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	from, to := day, day.Add(24*time.Hour)
	kind := KindAuditHistory
	monthPrefix := "pre/" + string(kind) + "/2026/09/"

	t.Run("本地是 S3 的子集时整条走 S3（只扫一份，不重复读）", func(t *testing.T) {
		localDir := t.TempDir()
		writeLocalParquet(t, localDir, kind, day, "audit_history-1.parquet")
		backend := planTestBackend(localDir, map[string][]string{
			monthPrefix: {
				monthPrefix + "21/audit_history-1.parquet",
				monthPrefix + "21/audit_history-2.parquet",
			},
		})

		plan := backend.parquetGlobs(context.Background(), kind, from, to)
		if !plan.useS3 {
			t.Error("S3 覆盖更全时应使用 S3")
		}
		if plan.dedupCopies {
			t.Error("S3 是本地超集时共享文件只扫一份，无需去重")
		}
		want := "s3://bucket/" + monthPrefix + "21/*.parquet"
		if len(plan.globs) != 1 || !strings.Contains(plan.globs[0], want) {
			t.Fatalf("globs = %v, want only %s", plan.globs, want)
		}
	})

	t.Run("互有独占文件时两边都扫并标记去重", func(t *testing.T) {
		localDir := t.TempDir()
		writeLocalParquet(t, localDir, kind, day, "audit_history-1.parquet", "audit_history-3.parquet")
		backend := planTestBackend(localDir, map[string][]string{
			monthPrefix: {
				monthPrefix + "21/audit_history-1.parquet",
				monthPrefix + "21/audit_history-2.parquet",
			},
		})

		plan := backend.parquetGlobs(context.Background(), kind, from, to)
		if !plan.useS3 || !plan.dedupCopies {
			t.Fatalf("useS3=%t dedupCopies=%t, want both true（两边互有独占文件）", plan.useS3, plan.dedupCopies)
		}
		if len(plan.globs) != 2 {
			t.Fatalf("globs = %v, want the local glob and the s3 day glob", plan.globs)
		}
		if !strings.Contains(plan.globs[0], localDir) || !strings.Contains(plan.globs[1], "s3://bucket/") {
			t.Fatalf("globs = %v, want local first then s3", plan.globs)
		}
	})

	t.Run("本地与 S3 完全一致时保持本地优先", func(t *testing.T) {
		localDir := t.TempDir()
		writeLocalParquet(t, localDir, kind, day, "audit_history-1.parquet")
		backend := planTestBackend(localDir, map[string][]string{
			monthPrefix: {monthPrefix + "21/audit_history-1.parquet"},
		})

		plan := backend.parquetGlobs(context.Background(), kind, from, to)
		if plan.useS3 {
			t.Error("本地已覆盖全部数据时不应绕网络查 S3")
		}
		if len(plan.globs) != 1 || !strings.Contains(plan.globs[0], localDir) {
			t.Fatalf("globs = %v, want the local day glob only", plan.globs)
		}
	})
}

// 本地被删空的天保持旧的「回落 S3」行为；S3 探测失败时只查本地、不整体失败。
func TestParquetGlobsFallsBackToS3WhenLocalDayMissing(t *testing.T) {
	day := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	kind := KindAccessLog

	backend := planTestBackend(t.TempDir(), map[string][]string{
		"pre/" + string(kind) + "/2026/09/": {
			"pre/" + string(kind) + "/2026/09/21/access_log-1.parquet",
		},
	})

	plan := backend.parquetGlobs(context.Background(), kind, day, day.Add(24*time.Hour))
	if !plan.useS3 || plan.dedupCopies {
		t.Fatalf("useS3=%t dedupCopies=%t, want useS3 only", plan.useS3, plan.dedupCopies)
	}
	want := "s3://bucket/pre/" + string(kind) + "/2026/09/21/*.parquet"
	if len(plan.globs) != 1 || !strings.Contains(plan.globs[0], want) {
		t.Fatalf("globs = %v, want %s", plan.globs, want)
	}
}

// 回归：endpoint 带协议头时 TLS 与上传端同口径——https:// 强制开启 TLS。
// 此前这里仍按原始 UseTLS 生成明文连接，出现「上传走 TLS、冷层查询走明文」
// 的协议不匹配。
func TestDuckDBS3StatementsAlignTLSWithEndpoint(t *testing.T) {
	statements := duckdbS3Statements(model.S3Archive{
		Enabled:  true,
		Endpoint: "https://cos.ap-guangzhou.myqcloud.com",
		Bucket:   "bucket",
		UseTLS:   false,
	})
	joined := strings.Join(statements, "; ")
	if !strings.Contains(joined, "SET s3_use_ssl=true") {
		t.Errorf("https:// endpoint 应强制开启 TLS（与上传端一致）:\n%s", joined)
	}
	if !strings.Contains(joined, "SET s3_endpoint='cos.ap-guangzhou.myqcloud.com'") {
		t.Errorf("endpoint 应去掉协议头:\n%s", joined)
	}

	// 无协议头时仍按 UseTLS 配置。
	plain := strings.Join(duckdbS3Statements(model.S3Archive{
		Enabled: true, Endpoint: "cos.example.com", Bucket: "bucket", UseTLS: true,
	}), "; ")
	if !strings.Contains(plain, "SET s3_use_ssl=true") {
		t.Errorf("无协议头的 endpoint 应沿用 UseTLS 配置:\n%s", plain)
	}
}

// 去重路径的 SQL 形态：read_parquet 带上 filename/file_row_number，并按
// (文件名, 行号) 窗口去重；单来源查询保持原 SQL 形状不变。
func TestBuildDuckDBSQLDedupShape(t *testing.T) {
	query := archiveQuery{kind: ESKindAuditHistory, timeField: esFieldCreatedAt}
	columns := archiveColumnsFor(ESKindAuditHistory)

	plain, err := buildDuckDBSQL(query, columns, []string{"/tmp/a/*.parquet"}, false, time.Time{}, time.Time{}, 1, 20)
	if err != nil {
		t.Fatalf("plain sql: %v", err)
	}
	if strings.Contains(plain, "filename=true") {
		t.Errorf("单来源查询不应引入去重参数:\n%s", plain)
	}

	dedup, err := buildDuckDBSQL(query, columns, []string{"/tmp/a/*.parquet", "s3://bucket/a/*.parquet"}, true, time.Time{}, time.Time{}, 1, 20)
	if err != nil {
		t.Fatalf("dedup sql: %v", err)
	}
	for _, want := range []string{
		"filename=true, file_row_number=true",
		"QUALIFY row_number() OVER (PARTITION BY regexp_replace(filename, '^.*[/\\\\]', ''), file_row_number) = 1",
		"count(*) OVER ()",
	} {
		if !strings.Contains(dedup, want) {
			t.Errorf("去重 SQL 缺少 %q:\n%s", want, dedup)
		}
	}
}
