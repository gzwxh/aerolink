package audit

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/parquet-go/parquet-go"
	"github.com/zxh326/kite/pkg/model"
)

// waitForArchiveFile 轮询等待终态 .parquet 出现，并断言没有 .tmp 残留。
func waitForArchiveFile(t *testing.T, dir string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var found string
		var temps []string
		_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil //nolint:nilerr // 轮询期间条目可能刚被 rename 掉，跳过即可。
			}
			if strings.HasSuffix(path, ".tmp") {
				temps = append(temps, path)
			}
			if strings.HasSuffix(path, ".parquet") {
				found = path
			}
			return nil
		})
		if found != "" {
			// 原子切换的断言：终态文件出现时，.tmp 必须已经消失（rename 是原子的）。
			if len(temps) > 0 {
				t.Fatalf("archive file published but temp file still present: %v", temps)
			}
			return found
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no archive file appeared")
	return ""
}

func readParquetRows[T any](t *testing.T, path string) []T {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("opening %s: %v", path, err)
	}
	defer func() { _ = file.Close() }()

	reader := parquet.NewGenericReader[T](file)
	defer func() { _ = reader.Close() }()

	var rows []T
	buffer := make([]T, 16)
	for {
		n, err := reader.Read(buffer)
		rows = append(rows, buffer[:n]...)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("reading parquet rows: %v", err)
		}
		if n == 0 {
			break
		}
	}
	return rows
}

func TestParquetWriterFlushesByRowCount(t *testing.T) {
	dir := t.TempDir()
	// 间隔拉到很长，确保这次落盘完全由「条数」触发。
	writer := NewParquetWriter[operationLogRow](dir, KindAuditHistory, model.FlushSetting{
		IntervalSeconds: 3600,
		MaxBatchRows:    2,
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { writer.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	at := time.Date(2026, 9, 20, 10, 30, 0, 0, time.UTC)
	rows := []operationLogRow{
		operationLogRowFromMessage(model.AuditMessage{
			Kind: model.AuditKindOperation, ID: 1, At: at,
			ResourceType: "deployment", ResourceName: "nginx", Success: true, OperatorName: "alice",
		}, false),
		operationLogRowFromMessage(model.AuditMessage{
			Kind: model.AuditKindOperation, ID: 2, At: at,
			ResourceType: "pod", ResourceName: "broken", Success: false, ErrorMessage: "boom",
		}, false),
	}
	for i, row := range rows {
		if !writer.Append(row) {
			t.Fatalf("Append(row %d) was dropped", i)
		}
	}

	path := waitForArchiveFile(t, dir)
	// 按天分区：<dir>/audit_history/<年>/<月>/<日>/audit_history-*.parquet
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		t.Fatalf("rel path: %v", err)
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) != 5 || parts[0] != string(KindAuditHistory) {
		t.Fatalf("unexpected archive layout: %s", rel)
	}
	// 文件名形如 <类型>-<时间>-<序号>-<实例标识>.parquet；时间、序号与标识不参与断言。
	if !strings.HasPrefix(filepath.Base(path), "audit_history-") {
		t.Fatalf("unexpected file name: %s", filepath.Base(path))
	}

	got := readParquetRows[operationLogRow](t, path)
	if len(got) != 2 {
		t.Fatalf("read back %d rows, want 2", len(got))
	}
	if got[0].ID != 1 || got[0].OperatorName != "alice" || !got[0].Success {
		t.Errorf("row 0 = %+v", got[0])
	}
	if got[1].ID != 2 || got[1].Success || got[1].ErrorMessage != "boom" {
		t.Errorf("row 1 = %+v", got[1])
	}
	if got[0].CreatedAt != at.UnixMilli() {
		t.Errorf("created_at = %d, want %d (ms)", got[0].CreatedAt, at.UnixMilli())
	}
}

func TestParquetWriterFlushSignalAndHook(t *testing.T) {
	dir := t.TempDir()
	// 条数阈值很高，靠 Flush() 信号落盘。
	writer := NewParquetWriter[loginRecordRow](dir, KindLoginRecord, model.FlushSetting{
		IntervalSeconds: 3600,
		MaxBatchRows:    1000,
	})

	hooked := make(chan string, 1)
	writer.AddFlushHook(func(path string) error {
		hooked <- path
		return nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { writer.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	writer.Append(loginRecordRowFromMessage(model.AuditMessage{
		Kind: model.AuditKindLogin, ID: 5, At: time.Now(),
		Username: "alice", Provider: "password", Result: model.AuditResultSuccess,
	}))
	writer.Flush()

	path := waitForArchiveFile(t, dir)
	select {
	case got := <-hooked:
		if got != path {
			t.Errorf("hook path = %q, want %q", got, path)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("flush hook was not called")
	}

	got := readParquetRows[loginRecordRow](t, path)
	if len(got) != 1 || got[0].Username != "alice" || got[0].Result != model.AuditResultSuccess {
		t.Fatalf("read back %+v", got)
	}
}

func TestParquetWriterFlushesRemainingOnShutdown(t *testing.T) {
	dir := t.TempDir()
	writer := NewParquetWriter[passwordChangeLogRow](dir, KindPasswordChangeLog, model.FlushSetting{
		IntervalSeconds: 3600,
		MaxBatchRows:    1000,
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { writer.Run(ctx); close(done) }()

	writer.Append(passwordChangeLogRowFromMessage(model.AuditMessage{
		Kind: model.AuditKindPasswordChange, ID: 7, At: time.Now(),
		UserID: 3, Username: "alice", Operator: "admin", Source: model.PasswordChangeSourceAdmin,
	}))
	// 让 Run 取走这一行，再触发退出：退出路径必须把缓冲区里剩下的记录落盘，而不是丢弃。
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	path := waitForArchiveFile(t, dir)
	got := readParquetRows[passwordChangeLogRow](t, path)
	if len(got) != 1 || got[0].UserID != 3 || got[0].Operator != "admin" {
		t.Fatalf("read back %+v", got)
	}
}

func TestParquetKindFor(t *testing.T) {
	cases := map[string]ParquetKind{
		model.AuditKindOperation:      KindAuditHistory,
		model.AuditKindLogin:          KindLoginRecord,
		model.AuditKindPasswordChange: KindPasswordChangeLog,
		model.AuditKindAccess:         KindAccessLog,
	}
	for kind, want := range cases {
		got, ok := ParquetKindFor(kind)
		if !ok || got != want {
			t.Errorf("ParquetKindFor(%q) = %q, %v; want %q, true", kind, got, ok, want)
		}
	}
	if _, ok := ParquetKindFor("nope"); ok {
		t.Error("ParquetKindFor(unknown) returned ok = true")
	}
}

func TestParquetWriterAppendAfterCloseIsDropped(t *testing.T) {
	dir := t.TempDir()
	writer := NewParquetWriter[accessLogRow](dir, KindAccessLog, model.FlushSetting{IntervalSeconds: 3600, MaxBatchRows: 10})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { writer.Run(ctx); close(done) }()

	writer.Close()
	<-done
	cancel()

	if writer.Append(accessLogRowFromMessage(model.AuditMessage{Kind: model.AuditKindAccess, At: time.Now()})) {
		t.Error("Append after Close should be dropped, not panic or block")
	}
}

// 资源清单默认不归档：includeYAML 关时必须留空，开时才写入（YAML 可能很大）。
func TestOperationLogRowRespectsIncludeYAMLFlag(t *testing.T) {
	message := model.AuditMessage{
		Kind:         model.AuditKindOperation,
		ID:           1,
		At:           time.Now(),
		ResourceType: "deployment",
		ResourceName: "nginx",
		ResourceYAML: "kind: Deployment",
		PreviousYAML: "kind: Deployment\nreplicas: 1",
	}

	without := operationLogRowFromMessage(message, false)
	if without.ResourceYAML != "" || without.PreviousYAML != "" {
		t.Errorf("YAML should be omitted when the flag is off: %+v", without)
	}

	with := operationLogRowFromMessage(message, true)
	if with.ResourceYAML != message.ResourceYAML || with.PreviousYAML != message.PreviousYAML {
		t.Errorf("YAML should be carried when the flag is on: %+v", with)
	}
}

// 多副本共享同一个归档目录时，两个副本可能在同一秒各落一个文件：文件名若只由「时间戳 + 进程内
// 序号」构成，两边算出的名字完全相同，后一次原子 rename 会直接覆盖先写好的那个文件——
// 丢掉的是整整一批记录，而且丢得毫无痕迹。这条用例钉住「同一秒、同一序号、不同实例 → 不同文件名」。
func TestArchiveFileNameIncludesInstanceToken(t *testing.T) {
	at := time.Date(2026, 9, 21, 14, 30, 5, 0, time.Local)

	first := archiveFileName(KindAuditHistory, at, 1, "a1b2c3d4")
	if first == archiveFileName(KindAuditHistory, at, 1, "deadbeef") {
		t.Fatalf("同一秒的两个副本算出了相同文件名: %s", first)
	}
	if !strings.HasPrefix(first, "audit_history-20260921-143005-1-") || !strings.HasSuffix(first, ".parquet") {
		t.Errorf("文件名格式变了: %s", first)
	}
	if archiveFileName(KindAuditHistory, at, 1, "a1b2c3d4") != first {
		t.Error("同样的输入必须得到同样的文件名（便于定位是哪个副本写的）")
	}
	// 不同类型 / 同进程内不同批次仍然要区分开。
	if archiveFileName(KindLoginRecord, at, 1, "a1b2c3d4") == first {
		t.Error("不同类型必须落在不同文件名上")
	}
	if archiveFileName(KindAuditHistory, at, 2, "a1b2c3d4") == first {
		t.Error("同一进程内的不同批次必须落在不同文件名上")
	}
}

// 实例标识由「主机名 + 进程号」算出：同一实例必须稳定，不同进程/不同主机必须不同。
func TestArchiveInstanceTokenDistinguishesProcesses(t *testing.T) {
	same := archiveInstanceTokenFor("kite-0", 1234)
	if same != archiveInstanceTokenFor("kite-0", 1234) {
		t.Error("同一实例的标识必须稳定")
	}
	if same == archiveInstanceTokenFor("kite-0", 5678) {
		t.Error("同一主机上的不同进程必须有不同标识")
	}
	if same == archiveInstanceTokenFor("kite-1", 1234) {
		t.Error("不同主机上的同号进程必须有不同标识")
	}
	if len(same) != 8 {
		t.Errorf("标识长度 = %d, want 8（短且够用）", len(same))
	}
	if archiveInstanceToken == "" {
		t.Error("本进程的实例标识不该为空")
	}
}
