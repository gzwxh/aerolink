package audit

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeArchiveFixture(t *testing.T, path string, size int, mod time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func TestPruneExpiredFilesRemovesOnlyExpiredParquet(t *testing.T) {
	root := t.TempDir()
	kindDir := filepath.Join(root, string(KindAuditHistory))

	oldPath := filepath.Join(kindDir, "2026", "01", "01", "audit_history-old.parquet")
	freshPath := filepath.Join(kindDir, "2026", "09", "20", "audit_history-fresh.parquet")
	otherPath := filepath.Join(kindDir, "2026", "01", "01", "notes.txt")
	expired := time.Now().AddDate(0, 0, -30)

	writeArchiveFixture(t, oldPath, 16, expired)
	writeArchiveFixture(t, freshPath, 16, time.Now())
	writeArchiveFixture(t, otherPath, 16, expired)

	// requireUpload=false：没有配置对象存储时按保留期正常清理。
	pruneExpiredFiles(kindDir, time.Now().AddDate(0, 0, -7), false)

	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Error("expired .parquet was not removed")
	}
	if _, err := os.Stat(freshPath); err != nil {
		t.Error("fresh .parquet should be kept")
	}
	if _, err := os.Stat(otherPath); err != nil {
		t.Error("non-parquet files must be left alone")
	}
}

func TestPruneExpiredFilesRemovesEmptyDirectories(t *testing.T) {
	root := t.TempDir()
	kindDir := filepath.Join(root, string(KindLoginRecord))
	oldPath := filepath.Join(kindDir, "2026", "01", "01", "login_record-1.parquet")
	writeArchiveFixture(t, oldPath, 16, time.Now().AddDate(0, 0, -30))

	pruneExpiredFiles(kindDir, time.Now().AddDate(0, 0, -7), false)

	// 日期目录与年份/月份目录都应该被清掉，不留下空壳。
	if _, err := os.Stat(filepath.Join(kindDir, "2026")); !os.IsNotExist(err) {
		t.Error("empty date directories were not cleaned up")
	}
	if _, err := os.Stat(kindDir); err != nil {
		t.Error("the kind directory itself should stay")
	}
}

func TestEnforceMaxBytesRemovesOldestFirst(t *testing.T) {
	root := t.TempDir()
	kindDir := filepath.Join(root, string(KindAccessLog))
	dateDir := filepath.Join(kindDir, "2026", "09", "20")

	oldest := filepath.Join(dateDir, "access_log-1.parquet")
	middle := filepath.Join(dateDir, "access_log-2.parquet")
	newest := filepath.Join(dateDir, "access_log-3.parquet")
	writeArchiveFixture(t, oldest, 100, time.Now().Add(-3*time.Hour))
	writeArchiveFixture(t, middle, 100, time.Now().Add(-2*time.Hour))
	writeArchiveFixture(t, newest, 100, time.Now().Add(-1*time.Hour))

	// 总大小 300 字节、上限 150：必须删掉最旧的两份才能降到上限以内。
	enforceMaxBytes(kindDir, 150, false)

	if _, err := os.Stat(newest); err != nil {
		t.Error("newest file should survive")
	}
	if _, err := os.Stat(oldest); !os.IsNotExist(err) {
		t.Error("oldest file should be removed first")
	}
	if _, err := os.Stat(middle); !os.IsNotExist(err) {
		t.Error("middle file should be removed to get under the limit")
	}
}

func TestEnforceMaxBytesKeepsEverythingUnderLimit(t *testing.T) {
	root := t.TempDir()
	kindDir := filepath.Join(root, string(KindAccessLog))
	path := filepath.Join(kindDir, "2026", "09", "20", "access_log-1.parquet")
	writeArchiveFixture(t, path, 10, time.Now())

	enforceMaxBytes(kindDir, 1024, false)

	if _, err := os.Stat(path); err != nil {
		t.Error("file under the limit must be kept")
	}
}
