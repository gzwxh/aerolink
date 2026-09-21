package audit

import (
	"testing"

	"github.com/zxh326/kite/pkg/model"
)

// nil writer 必须被 writers()/runs() 跳过。
//
// 这条回归的来历：曾经用 `[]flushHookTarget{r.operation, ...}` 收集再筛选，而 nil 的
// *ParquetWriter[T] 装进接口后**接口本身不为 nil**，筛选失效 → 对 nil 调 SetDispatchers
// 直接 panic，服务启动即崩（sink=parquet/es 时某些类型本来就不会创建 writer）。
func TestArchiveRuntimeSkipsNilWriters(t *testing.T) {
	runtime := &archiveRuntime{}
	// 只给一个真实 writer，其余保持 nil。
	runtime.operation = NewParquetWriter[operationLogRow](t.TempDir(), KindAuditHistory, model.FlushSetting{})

	targets := runtime.writers()
	if len(targets) != 1 {
		t.Fatalf("writers() 返回 %d 个, want 1（nil writer 必须被跳过）", len(targets))
	}

	dispatcher := newArchiveDispatcher("test", 1, 4)
	t.Cleanup(dispatcher.Stop)

	// 有 nil 混进来时，这里会 panic——正是要防住的行为。
	for _, target := range targets {
		target.SetDispatchers(dispatcher, dispatcher)
	}

	if runs := runtime.runs(); len(runs) != 1 {
		t.Errorf("runs() 返回 %d 个, want 1", len(runs))
	}
}

// nil writer 上调用 AddFlushHook / SetDispatchers 必须安全（防御性，不依赖调用方判空）。
func TestNilParquetWriterAcceptsHooksAndDispatchers(t *testing.T) {
	var writer *ParquetWriter[operationLogRow]

	writer.AddFlushHook(func(string) error { return nil })
	writer.SetDispatchers(newArchiveDispatcher("test", 1, 2), nil)
	writer.Flush()

	if dropped, written := writer.Stats(); dropped != 0 || written != 0 {
		t.Errorf("nil writer 的计数应为 0, got dropped=%d written=%d", dropped, written)
	}
}
