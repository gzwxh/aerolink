package scheduler

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/notification"
	"k8s.io/klog/v2"
)

const (
	defaultScanInterval = time.Minute
	defaultLockDuration = 10 * time.Minute
)

// timeLayout 用于格式化站内信里的时间（notification 包里的同名常量未导出）。
const timeLayout = "2006-01-02 15:04:05"

type Executor interface {
	Run(context.Context, model.ScheduledTask) error
}

type Manager struct {
	executors    map[string]Executor
	instanceID   string
	scanInterval time.Duration
	lockDuration time.Duration
}

func NewManager() *Manager {
	hostname, _ := os.Hostname()
	return &Manager{
		executors:    map[string]Executor{},
		instanceID:   fmt.Sprintf("%s-%d", hostname, os.Getpid()),
		scanInterval: defaultScanInterval,
		lockDuration: defaultLockDuration,
	}
}

func (m *Manager) Register(taskType string, executor Executor) {
	m.executors[taskType] = executor
}

func (m *Manager) Start(ctx context.Context) {
	go m.run(ctx)
}

func (m *Manager) run(ctx context.Context) {
	ticker := time.NewTicker(m.scanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.runDue(ctx)
		}
	}
}

func (m *Manager) runDue(ctx context.Context) {
	now := time.Now()
	var tasks []model.ScheduledTask
	if err := model.DB.
		Where("enabled = ?", true).
		Where("next_run_at IS NULL OR next_run_at <= ?", now).
		Where("lock_until IS NULL OR lock_until < ?", now).
		Find(&tasks).Error; err != nil {
		klog.Errorf("Failed to list scheduled tasks: %v", err)
		return
	}
	for i := range tasks {
		if ctx.Err() != nil {
			return
		}
		task := tasks[i]
		if !m.acquire(task, now) {
			continue
		}
		m.runTask(ctx, task)
	}
}

func (m *Manager) acquire(task model.ScheduledTask, now time.Time) bool {
	lockUntil := now.Add(m.lockDuration)
	result := model.DB.Model(&model.ScheduledTask{}).
		Where("id = ? AND (lock_until IS NULL OR lock_until < ?)", task.ID, now).
		Updates(map[string]interface{}{
			"locked_at":  now,
			"locked_by":  m.instanceID,
			"lock_until": lockUntil,
		})
	if result.Error != nil {
		klog.Errorf("Failed to lock scheduled task %s/%s/%s: %v", task.ClusterName, task.Type, task.Key, result.Error)
		return false
	}
	return result.RowsAffected == 1
}

func (m *Manager) runTask(ctx context.Context, task model.ScheduledTask) {
	runAt := time.Now()
	// 执行期间必须续租：acquire 只在开始时写一次 lock_until，长任务会在锁到期后
	// 被另一个实例当成「无人执行」而抢走，同一个任务就被并发跑了两遍。
	stopHeartbeat := m.startLockHeartbeat(ctx, task)
	defer stopHeartbeat()

	klog.Infof("Scheduled task started: cluster=%s type=%s key=%s id=%d", task.ClusterName, task.Type, task.Key, task.ID)
	executor := m.executors[task.Type]
	var err error
	if executor == nil {
		err = fmt.Errorf("scheduled task executor not found: %s", task.Type)
	} else {
		err = executor.Run(ctx, task)
	}
	// 先停心跳再收尾：否则续租可能和 finish 的清锁互相覆盖。
	stopHeartbeat()
	m.finish(task, runAt, err)
	if err != nil {
		klog.Errorf("Scheduled task finished with error: cluster=%s type=%s key=%s id=%d duration=%s error=%v", task.ClusterName, task.Type, task.Key, task.ID, time.Since(runAt), err)
		m.notifyTaskFailure(task, err)
		return
	}
	klog.Infof("Scheduled task finished: cluster=%s type=%s key=%s id=%d duration=%s", task.ClusterName, task.Type, task.Key, task.ID, time.Since(runAt))
}

// notifyTaskFailure 把一次执行失败告诉任务创建者。
//
// 定时任务在人不在场的时候跑，失败原本只写进 scheduled_tasks.last_error，创建者不会主动
// 去看——这正是「不在场时发生的、与自己相关的事」，按失败反馈口径应该走站内信
// （见 plans/2026-09-21-notification-recipient-and-failure-feedback.md §2.3）。
// 收件人是创建者本人，通过 SendEventTo 的「当事人必收」档送达，不依赖订阅配置。
//
// 只处理执行失败：调度配置本身有问题（scheduleErr）时 next_run_at 不会推进，任务会被
// 每一轮扫描重复捡起，在这里通知会变成刷屏。
//
// 投递是同步的：与每日检查（notification.triggers）一致，而调度循环本来就串行等待执行器。
func (m *Manager) notifyTaskFailure(task model.ScheduledTask, runErr error) {
	// 建任务时 CreatorID 一律来自当前登录用户（见 helmrelease_handler 的 UpdateAutoUpgrade），
	// 为 0 只能是早期数据，没有收件人可发。
	if task.CreatorID == 0 {
		return
	}
	// 这一调用发生在调度循环的 goroutine 里，一次 panic 会把整个调度器带崩，
	// 而通知失败本身不该影响任务收尾（与 notification.NotifyRemoteLogin 同一处理）。
	defer func() {
		if r := recover(); r != nil {
			klog.Errorf("panic while notifying the failure of scheduled task %d: %v", task.ID, r)
		}
	}()

	taskName := task.Name
	if taskName == "" {
		taskName = task.Key
	}
	notification.SendEventTo(model.NotificationEventScheduledTaskFailed, map[string]string{
		"taskName": taskName,
		"taskType": task.Type,
		"cluster":  task.ClusterName,
		"key":      task.Key,
		"reason":   runErr.Error(),
		"time":     time.Now().Format(timeLayout),
	}, task.CreatorID)
}

// startLockHeartbeat 在任务执行期间周期性把 lock_until 往后推，返回的函数用于
// 停止心跳（幂等，可重复调用）。
func (m *Manager) startLockHeartbeat(ctx context.Context, task model.ScheduledTask) func() {
	interval := m.lockDuration / 2
	if interval <= 0 {
		interval = time.Millisecond
	}
	done := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := m.renewLock(task); err != nil {
					klog.Errorf("Failed to renew the lock on scheduled task %s/%s/%s: %v",
						task.ClusterName, task.Type, task.Key, err)
				}
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

// renewLock 只续租本实例持有的锁：锁若已被别的实例抢走，就不要再动它。
func (m *Manager) renewLock(task model.ScheduledTask) error {
	return model.DB.Model(&model.ScheduledTask{}).
		Where("id = ? AND locked_by = ?", task.ID, m.instanceID).
		Update("lock_until", time.Now().Add(m.lockDuration)).Error
}

func (m *Manager) finish(task model.ScheduledTask, runAt time.Time, err error) {
	nextRunAt, scheduleErr := NextRunAt(runAt, task.ScheduleType, task.IntervalMinutes, task.ScheduleTime)
	updates := map[string]interface{}{
		"last_run_at": runAt,
		"last_error":  "",
		"locked_at":   nil,
		"locked_by":   "",
		"lock_until":  nil,
	}
	if scheduleErr == nil {
		updates["next_run_at"] = nextRunAt
	}
	switch {
	case err != nil:
		updates["last_error"] = err.Error()
	case scheduleErr != nil:
		updates["last_error"] = scheduleErr.Error()
	default:
		updates["last_success_at"] = runAt
	}
	if dbErr := model.DB.Model(&model.ScheduledTask{}).Where("id = ?", task.ID).Updates(updates).Error; dbErr != nil {
		klog.Errorf("Failed to update scheduled task %s/%s/%s: %v", task.ClusterName, task.Type, task.Key, dbErr)
	}
}

func NextRunAt(from time.Time, scheduleType string, intervalMinutes int, scheduleTime string) (time.Time, error) {
	switch scheduleType {
	case model.ScheduledTaskScheduleTypeInterval:
		if intervalMinutes < 1 {
			return time.Time{}, fmt.Errorf("intervalMinutes must be at least 1")
		}
		return from.Add(time.Duration(intervalMinutes) * time.Minute), nil
	case model.ScheduledTaskScheduleTypeDaily:
		hour, minute, err := parseScheduleTime(scheduleTime)
		if err != nil {
			return time.Time{}, err
		}
		next := time.Date(from.Year(), from.Month(), from.Day(), hour, minute, 0, 0, from.Location())
		if !next.After(from) {
			next = next.AddDate(0, 0, 1)
		}
		return next, nil
	default:
		return time.Time{}, fmt.Errorf("unsupported scheduleType: %s", scheduleType)
	}
}

func parseScheduleTime(value string) (int, int, error) {
	parsed, err := time.Parse("15:04", value)
	if err != nil {
		return 0, 0, fmt.Errorf("scheduleTime must use HH:MM")
	}
	return parsed.Hour(), parsed.Minute(), nil
}
