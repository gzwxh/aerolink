package audit

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeArchiveFile 造一个归档文件并把 mtime 往前拨 age（模拟「已过期」）。
func writeArchiveFile(t *testing.T, dir, name string, age time.Duration) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("PAR1-fake-parquet"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	modTime := time.Now().Add(-age)
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
	return path
}

func useRetainedCounter(t *testing.T) {
	t.Helper()
	original := archiveRetainedUnuploaded.Load()
	archiveRetainedUnuploaded.Store(0)
	t.Cleanup(func() { archiveRetainedUnuploaded.Store(original) })
}

// 到期清理必须放过「尚未上传成功」的文件：它可能还是唯一副本，删了就永久丢数据。
func TestPruneExpiredFilesKeepsUnuploaded(t *testing.T) {
	kindDir := filepath.Join(t.TempDir(), string(KindAuditHistory))
	if err := os.MkdirAll(kindDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	useRetainedCounter(t)

	uploaded := writeArchiveFile(t, kindDir, "uploaded.parquet", 10*24*time.Hour)
	unuploaded := writeArchiveFile(t, kindDir, "unuploaded.parquet", 10*24*time.Hour)
	if err := markUploaded(uploaded); err != nil {
		t.Fatalf("markUploaded: %v", err)
	}

	pruneExpiredFiles(kindDir, time.Now().AddDate(0, 0, -7), true)

	if _, err := os.Stat(uploaded); !os.IsNotExist(err) {
		t.Error("已上传且过期的文件应当被删除")
	}
	if _, err := os.Stat(uploaded + uploadMarkerSuffix); !os.IsNotExist(err) {
		t.Error("删除文件时应一并清掉上传标记")
	}
	if _, err := os.Stat(unuploaded); err != nil {
		t.Error("未上传的文件必须保留：它可能还是唯一副本")
	}
	if got := archiveRetainedUnuploaded.Load(); got != 1 {
		t.Errorf("retained unuploaded = %d, want 1", got)
	}
}

// 未配置对象存储（requireUpload=false）时按保留期正常清理，不受标记影响。
func TestPruneExpiredFilesWithoutUploadsRemovesEverything(t *testing.T) {
	kindDir := filepath.Join(t.TempDir(), string(KindAuditHistory))
	if err := os.MkdirAll(kindDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	useRetainedCounter(t)

	first := writeArchiveFile(t, kindDir, "a.parquet", 10*24*time.Hour)
	second := writeArchiveFile(t, kindDir, "b.parquet", 10*24*time.Hour)

	pruneExpiredFiles(kindDir, time.Now().AddDate(0, 0, -7), false)

	for _, path := range []string{first, second} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s 在没有对象存储时应当按保留期删除", filepath.Base(path))
		}
	}
	if got := archiveRetainedUnuploaded.Load(); got != 0 {
		t.Errorf("retained unuploaded = %d, want 0", got)
	}
}

// 未过期的文件不该被碰。
func TestPruneExpiredFilesKeepsFreshFiles(t *testing.T) {
	kindDir := filepath.Join(t.TempDir(), string(KindAuditHistory))
	if err := os.MkdirAll(kindDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	useRetainedCounter(t)

	fresh := writeArchiveFile(t, kindDir, "fresh.parquet", time.Hour)
	pruneExpiredFiles(kindDir, time.Now().AddDate(0, 0, -7), true)

	if _, err := os.Stat(fresh); err != nil {
		t.Error("未过期的文件不应被删除")
	}
}

// 容量清理同样不能删未上传的文件：宁可超容量，也不能丢唯一副本。
func TestEnforceMaxBytesKeepsUnuploaded(t *testing.T) {
	kindDir := filepath.Join(t.TempDir(), string(KindAuditHistory))
	if err := os.MkdirAll(kindDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	useRetainedCounter(t)

	// 两个文件各 17 字节：上限设为 20 字节，必须删掉一个才达标。
	// 让未上传的那份更旧（清理从最旧的开始），从而真实走到「跳过未上传」这条路径。
	unuploaded := writeArchiveFile(t, kindDir, "unuploaded.parquet", 3*time.Hour)
	uploaded := writeArchiveFile(t, kindDir, "uploaded.parquet", time.Hour)
	if err := markUploaded(uploaded); err != nil {
		t.Fatalf("markUploaded: %v", err)
	}

	enforceMaxBytes(kindDir, 20, true)

	if _, err := os.Stat(uploaded); !os.IsNotExist(err) {
		t.Error("容量超限时应优先删已上传的文件")
	}
	if _, err := os.Stat(unuploaded); err != nil {
		t.Error("未上传的文件不能因为容量超限被删除")
	}
	if got := archiveRetainedUnuploaded.Load(); got != 1 {
		t.Errorf("retained unuploaded = %d, want 1", got)
	}
}

func TestUploadMarkerRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := writeArchiveFile(t, dir, "x.parquet", time.Minute)

	if isUploaded(path) {
		t.Fatal("新文件不应带上传标记")
	}
	if err := markUploaded(path); err != nil {
		t.Fatalf("markUploaded: %v", err)
	}
	if !isUploaded(path) {
		t.Fatal("标记写入后 isUploaded 应为真")
	}
	removeUploadMarker(path)
	if isUploaded(path) {
		t.Fatal("删除标记后 isUploaded 应为假")
	}
}
