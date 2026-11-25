package scheduler

import (
	"context"
	"errors"
	"strings"
	"testing"

	"aerolink/pkg/model"
)

type failingExecutor struct {
	err error
}

func (e *failingExecutor) Run(context.Context, model.ScheduledTask) error {
	return e.err
}

type succeedingExecutor struct{}

func (e *succeedingExecutor) Run(context.Context, model.ScheduledTask) error {
	return nil
}

func seedSchedulerTestUser(t *testing.T, username string) *model.User {
	t.Helper()
	user := &model.User{Username: username, Provider: model.AuthProviderPassword, Enabled: true}
	if err := model.DB.Create(user).Error; err != nil {
		t.Fatalf("seeding %s: %v", username, err)
	}
	return user
}

func notificationsOf(t *testing.T, userID uint) []model.Notification {
	t.Helper()
	var notifications []model.Notification
	if err := model.DB.Where("user_id = ?", userID).Find(&notifications).Error; err != nil {
		t.Fatalf("loading notifications for user %d: %v", userID, err)
	}
	return notifications
}

// 定时任务失败是典型的「不在场时发生的、与自己相关的事」：只写进
// scheduled_tasks.last_error 的话，创建者要自己想起来去看才知道。
func TestRunTaskNotifiesCreatorOnFailure(t *testing.T) {
	openSchedulerTestDB(t)
	creator := seedSchedulerTestUser(t, "creator")
	bystander := seedSchedulerTestUser(t, "bystander")
	// 用预置模板而不是自造一条：这条用例顺带锁住「触发点传的变量名与模板占位符一致」，
	// 否则渲染出来的站内信会带着 {{taskName}} 一类的原文。
	if _, err := model.EnsureNotificationTemplates(); err != nil {
		t.Fatalf("seeding notification templates: %v", err)
	}

	runErr := errors.New("helm upgrade timed out")
	task := model.ScheduledTask{
		ClusterName:     "c1",
		Type:            "helm_release_auto_upgrade",
		Key:             "demo/nginx",
		Name:            "Helm release auto upgrade demo/nginx",
		CreatorID:       creator.ID,
		Enabled:         true,
		ScheduleType:    model.ScheduledTaskScheduleTypeInterval,
		IntervalMinutes: 60,
	}
	if err := model.DB.Create(&task).Error; err != nil {
		t.Fatalf("creating task: %v", err)
	}

	manager := NewManager()
	manager.Register(task.Type, &failingExecutor{err: runErr})
	manager.runDue(context.Background())

	notifications := notificationsOf(t, creator.ID)
	if len(notifications) != 1 {
		t.Fatalf("the creator got %d in-app notifications, want 1", len(notifications))
	}
	received := notifications[0]
	if received.Event != model.NotificationEventScheduledTaskFailed {
		t.Errorf("event = %q, want %q", received.Event, model.NotificationEventScheduledTaskFailed)
	}
	// 任务名与失败原因是这条消息全部的价值所在。
	for _, want := range []string{task.Name, runErr.Error(), task.ClusterName} {
		if !strings.Contains(received.Content, want) {
			t.Errorf("content %q does not mention %q", received.Content, want)
		}
	}
	if strings.Contains(received.Content, "{{") {
		t.Errorf("content %q still has an unrendered placeholder", received.Content)
	}

	// 收件人只有创建者：这个事件不在「管理员必收」清单里，不能变成群发。
	if got := len(notificationsOf(t, bystander.ID)); got != 0 {
		t.Errorf("an unrelated user got %d notifications, want 0", got)
	}

	// 站内信是新增的旁路，last_error 仍要照旧落库。
	var stored model.ScheduledTask
	if err := model.DB.First(&stored, task.ID).Error; err != nil {
		t.Fatalf("reloading task: %v", err)
	}
	if stored.LastError != runErr.Error() {
		t.Errorf("last_error = %q, want %q", stored.LastError, runErr.Error())
	}
}

func TestRunTaskDoesNotNotifyOnSuccess(t *testing.T) {
	openSchedulerTestDB(t)
	creator := seedSchedulerTestUser(t, "creator")
	if _, err := model.EnsureNotificationTemplates(); err != nil {
		t.Fatalf("seeding notification templates: %v", err)
	}

	task := model.ScheduledTask{
		ClusterName:     "c1",
		Type:            "helm_release_auto_upgrade",
		Key:             "demo/nginx",
		CreatorID:       creator.ID,
		Enabled:         true,
		ScheduleType:    model.ScheduledTaskScheduleTypeInterval,
		IntervalMinutes: 60,
	}
	if err := model.DB.Create(&task).Error; err != nil {
		t.Fatalf("creating task: %v", err)
	}

	manager := NewManager()
	manager.Register(task.Type, &succeedingExecutor{})
	manager.runDue(context.Background())

	if got := len(notificationsOf(t, creator.ID)); got != 0 {
		t.Fatalf("a successful run produced %d notifications, want 0", got)
	}
}
