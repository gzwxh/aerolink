package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type blockingExecutor struct {
	started chan struct{}
	release chan struct{}
}

func (e *blockingExecutor) Run(context.Context, model.ScheduledTask) error {
	close(e.started)
	<-e.release
	return nil
}

func openSchedulerTestDB(t *testing.T) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&model.ScheduledTask{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	previous := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = previous })
}

// 长任务执行期间必须续租：否则 lock_until 到期后另一个实例会抢走同一任务，
// 同一个任务被并发执行两遍（例如同一个 Helm release 被同时升级）。
func TestRunTaskRenewsLockWhileExecuting(t *testing.T) {
	openSchedulerTestDB(t)

	task := model.ScheduledTask{
		ClusterName:     "c1",
		Type:            "auto-upgrade",
		Key:             "release-1",
		Enabled:         true,
		ScheduleType:    model.ScheduledTaskScheduleTypeInterval,
		IntervalMinutes: 60,
	}
	if err := model.DB.Create(&task).Error; err != nil {
		t.Fatalf("creating task: %v", err)
	}

	manager := NewManager()
	manager.lockDuration = 200 * time.Millisecond
	executor := &blockingExecutor{started: make(chan struct{}), release: make(chan struct{})}
	manager.Register("auto-upgrade", executor)

	done := make(chan struct{})
	go func() {
		defer close(done)
		manager.runDue(context.Background())
	}()

	<-executor.started
	startedAt := time.Now()

	// 等到明显越过原本的锁时长：没有续租的话，此刻锁早就过期了。
	for time.Now().Before(startedAt.Add(3 * manager.lockDuration)) {
		time.Sleep(10 * time.Millisecond)
	}

	var stored model.ScheduledTask
	if err := model.DB.First(&stored, task.ID).Error; err != nil {
		t.Fatalf("reloading task: %v", err)
	}
	if stored.LockUntil == nil || !stored.LockUntil.After(time.Now()) {
		t.Fatalf("lock_until = %v, want a renewed deadline in the future while the task runs", stored.LockUntil)
	}

	// 另一个实例此刻必须抢不走这个任务。
	other := NewManager()
	other.lockDuration = manager.lockDuration
	if other.acquire(stored, time.Now()) {
		t.Fatal("another instance acquired a task that is still running")
	}

	close(executor.release)
	<-done

	var finished model.ScheduledTask
	if err := model.DB.First(&finished, task.ID).Error; err != nil {
		t.Fatalf("reloading finished task: %v", err)
	}
	if finished.LockUntil != nil || finished.LockedBy != "" {
		t.Fatalf("task finished with lock still held: until=%v by=%q", finished.LockUntil, finished.LockedBy)
	}
}
