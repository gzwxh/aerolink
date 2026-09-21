package audit

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// —— 并发写入相关测试 ——
//
// 这一组测试针对的是「多用户同时操作」下最容易出问题的两处：
//  1. 落盘后的上传是网络 IO，如果它跑在写入循环里，会把整类日志的消费卡住，缓冲一满就丢记录；
//  2. 多个请求并发投递同一类记录时，缓冲区必须能承接住（设计上允许在极端量级下丢弃，
//     但绝不允许丢在「本该接住」的负载上，也不允许出现数据竞争或 panic）。

// readAllOperationRows 读出归档目录下所有 parquet 文件里的行（用于验证「文件里真的有这些行」，
// 而不只是计数器好看）。
func readAllOperationRows(t *testing.T, archiveDir string) []operationLogRow {
	t.Helper()

	var paths []string
	err := filepath.WalkDir(filepath.Join(archiveDir, string(KindAuditHistory)), func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && strings.HasSuffix(path, ".parquet") {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk archive dir: %v", err)
	}

	var rows []operationLogRow
	for _, path := range paths {
		rows = append(rows, readParquetRows[operationLogRow](t, path)...)
	}
	return rows
}

// 核心回归：上传慢到离谱时，写入循环也必须照常消费——这正是「同步上传」时代的死穴。
//
// 判据是 dropped == 0 且全部落盘：如果把上传放回写盘协程（同步执行），这段投递量会撑爆
// 缓冲区并丢掉大量记录，测试会直接失败。
func TestParquetWriterKeepsWritingWhileUploadIsSlow(t *testing.T) {
	dir := t.TempDir()
	writer := NewParquetWriter[operationLogRow](dir, KindAuditHistory, model.FlushSetting{
		IntervalSeconds: 3600,
		MaxBatchRows:    100,
	})

	// 与生产同一组参数（archiveDiskWorkers / archiveUploadWorkers / archiveQueueSize）：
	// 队列要足够大才吸收得住突发，否则队列一满就会走同步兜底、把压力传回写入循环——
	// 那条路径由 TestArchiveDispatcherFallsBackInlineWhenQueueIsFull 单独覆盖。
	disk := newArchiveDispatcher("disk", archiveDiskWorkers, archiveQueueSize)
	upload := newArchiveDispatcher("upload", archiveUploadWorkers, archiveQueueSize)
	writer.SetDispatchers(disk, upload)
	t.Cleanup(func() {
		disk.Stop()
		upload.Stop()
	})

	var uploads atomic.Int64
	writer.AddFlushHook(func(string) error {
		uploads.Add(1)
		time.Sleep(20 * time.Millisecond)
		return nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { writer.Run(ctx); close(done) }()

	// 80 个批次 × 20ms 的上传：若上传占用写盘协程，消费速率会被钉在
	// 「批次大小 / 上传耗时」= 100 / 20ms = 5000 条/秒。
	//
	// 投递速率刻意做成「分散到达」而不是一次性灌入：真实的审计记录是随请求逐条产生的
	// （每条前面还有一次数据库写入），不是紧密循环瞬间轰炸。瞬间轰炸时 channel 投递只要
	// 1ms 左右，连 Run 协程被调度都来不及，测的是调度运气而不是设计——那样连改造前的老代码
	// 也会因为「丢得不够多」而看不出差别。
	const total = 8000
	for i := 0; i < total; i++ {
		if i%25 == 0 {
			// 25 条/毫秒 ≈ 2.5 万条/秒：远高于同步上传时 5000 条/秒 的消费能力，
			// 也远低于异步改造后「只做内存搬运」的消费能力。
			time.Sleep(time.Millisecond)
		}
		if !writer.Append(operationLogRow{ID: uint64(i + 1), CreatedAt: time.Now().UnixMilli()}) {
			t.Fatalf("Append(%d) 被丢弃：写入循环被慢上传堵住了", i)
		}
	}

	cancel()
	<-done
	// 先停写盘池（写完之后才会有上传任务），再等上传跑完。
	disk.Stop()
	upload.Stop()

	dropped, written := writer.Stats()
	if dropped != 0 {
		t.Errorf("dropped = %d, want 0（上传慢不应该导致丢记录）", dropped)
	}
	if written != total {
		t.Errorf("written = %d, want %d", written, total)
	}
	if rows := readAllOperationRows(t, dir); len(rows) != total {
		t.Errorf("parquet 文件里共 %d 行, want %d", len(rows), total)
	}
	if uploads.Load() == 0 {
		t.Error("flush hook 从未被调用：上传任务没有真的被执行")
	}
}

// 并发投递：多个 goroutine 同时 Append 同一类记录，全部该被接住并落盘。
func TestParquetWriterConcurrentAppendsAreNotLost(t *testing.T) {
	dir := t.TempDir()
	writer := NewParquetWriter[operationLogRow](dir, KindAuditHistory, model.FlushSetting{
		IntervalSeconds: 3600,
		MaxBatchRows:    64,
	})

	disk := newArchiveDispatcher("disk", archiveDiskWorkers, archiveQueueSize)
	upload := newArchiveDispatcher("upload", archiveUploadWorkers, archiveQueueSize)
	writer.SetDispatchers(disk, upload)
	t.Cleanup(func() {
		disk.Stop()
		upload.Stop()
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { writer.Run(ctx); close(done) }()

	const writers = 8
	const perWriter = 200 // 合计 1600，远低于缓冲区上限，设计上一条都不该丢

	var rejected atomic.Int64
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				row := operationLogRow{
					ID:        uint64(w*perWriter + i + 1),
					CreatedAt: time.Now().UnixMilli(),
				}
				if !writer.Append(row) {
					rejected.Add(1)
				}
			}
		}(w)
	}
	wg.Wait()

	cancel()
	<-done
	disk.Stop()
	upload.Stop()

	if rejected.Load() != 0 {
		t.Errorf("缓冲区拒收了 %d 条记录（总投递 %d）", rejected.Load(), writers*perWriter)
	}

	dropped, written := writer.Stats()
	if dropped != 0 || written != writers*perWriter {
		t.Errorf("dropped=%d written=%d, want 0 / %d", dropped, written, writers*perWriter)
	}

	rows := readAllOperationRows(t, dir)
	if len(rows) != writers*perWriter {
		t.Fatalf("parquet 文件里共 %d 行, want %d", len(rows), writers*perWriter)
	}
	// 并发投递不允许出现重复或丢失：ID 必须刚好覆盖 1..N。
	seen := make(map[uint64]bool, len(rows))
	for _, row := range rows {
		if row.ID == 0 || row.ID > uint64(writers*perWriter) {
			t.Fatalf("落盘的 ID 越界: %d", row.ID)
		}
		if seen[row.ID] {
			t.Fatalf("ID %d 重复落盘", row.ID)
		}
		seen[row.ID] = true
	}
}

// 队列满时的语义：不丢任务，改为由调用方同步执行（背压），并计入 backpressure 计数。
func TestArchiveDispatcherFallsBackInlineWhenQueueIsFull(t *testing.T) {
	// 单 worker + 容量 1 的队列：第一个任务占住 worker，第二个填满队列，第三个必然走兜底。
	dispatcher := newArchiveDispatcher("test", 1, 1)
	defer dispatcher.Stop()

	blocked := make(chan struct{})
	release := make(chan struct{})
	dispatcher.Submit(func() {
		close(blocked)
		<-release
	})
	<-blocked

	var ran atomic.Int64
	dispatcher.Submit(func() { ran.Add(1) })
	dispatcher.Submit(func() { ran.Add(1) }) // 队列已满 → 同步执行

	if ran.Load() != 1 {
		t.Errorf("队列满时任务应同步执行一次, ran = %d", ran.Load())
	}
	if pending, fallback := dispatcher.Stats(); pending != 1 || fallback != 1 {
		t.Errorf("pending=%d syncFallback=%d, want 1 / 1", pending, fallback)
	}

	close(release)
	dispatcher.Stop()

	if ran.Load() != 2 {
		t.Errorf("停止前队列里的任务必须执行完, ran = %d, want 2（不丢任务）", ran.Load())
	}
}

// 停止后的提交不能被静默丢弃：池已关闭时直接执行。
func TestArchiveDispatcherRunsTasksAfterStop(t *testing.T) {
	dispatcher := newArchiveDispatcher("test", 1, 4)
	dispatcher.Stop()

	var ran atomic.Bool
	dispatcher.Submit(func() { ran.Store(true) })

	if !ran.Load() {
		t.Error("池停止后提交的任务应被直接执行，而不是无声丢弃")
	}
}
