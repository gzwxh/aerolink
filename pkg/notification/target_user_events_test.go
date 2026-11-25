package notification

import (
	"testing"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
)

// 「当事人必收」：事件描述的是这个账号自己的状态/凭据变化，没有任何订阅时本人也必须收到。
//
// 这一档是上一轮删掉通用 extras 参数（见 plans/2026-09-20-控制台体验与通知口径修复.md §5）
// 之后补回来的**受清单约束**的路径：只有 model.targetUserEvents 里的事件才认显式收件人。
func TestTargetUserEventsReachTheAffectedUserWithoutAnySubscription(t *testing.T) {
	newNotificationTestDB(t)
	alice := seedNotificationUser(t, "alice")
	bob := seedNotificationUser(t, "bob")
	seedNotificationTemplate(t, model.NotificationEventPasswordResetByAdmin)

	SendEventTo(model.NotificationEventPasswordResetByAdmin,
		map[string]string{"username": "alice", "operator": "root"}, alice.ID)

	if got := inAppCount(t, alice.ID); got != 1 {
		t.Fatalf("the affected user got %d in-app notifications, want 1", got)
	}
	if got := inAppCount(t, bob.ID); got != 0 {
		t.Fatalf("an unrelated user got %d in-app notifications, want 0", got)
	}
}

// 反面：不在清单里的事件，即使调用方传了收件人也不投递。
//
// 这是相对旧 extras 参数的关键护栏——否则任何调用方都能顺手把一个事件变成「不看订阅也发」。
func TestNonTargetUserEventsIgnoreExplicitRecipients(t *testing.T) {
	newNotificationTestDB(t)
	alice := seedNotificationUser(t, "alice")
	seedNotificationTemplate(t, model.NotificationEventTest)

	SendEventTo(model.NotificationEventTest, map[string]string{"username": "alice"}, alice.ID)

	if got := inAppCount(t, alice.ID); got != 0 {
		t.Fatalf("an event outside the target list delivered to the explicit recipient: count = %d, want 0", got)
	}
}

// 当事人与「全体用户」订阅命中同一个人时只写一条站内信（去重在并集之后做）。
func TestTargetUserEventDoesNotDuplicateForSubscribedUser(t *testing.T) {
	newNotificationTestDB(t)
	alice := seedNotificationUser(t, "alice")
	seedNotificationTemplate(t, model.NotificationEventRoleAssigned)
	seedAllUsersSubscription(t, model.NotificationEventRoleAssigned)

	SendEventTo(model.NotificationEventRoleAssigned,
		map[string]string{"username": "alice", "role": "viewer"}, alice.ID)

	if got := inAppCount(t, alice.ID); got != 1 {
		t.Fatalf("the target user got %d in-app notifications, want 1 (deduped)", got)
	}
}

// 当事人的账号**此刻正是停用状态**时，这条消息仍然要送达：
// account_disabled 的内容就是「你被停用了」，按「停用账号不收」过滤会让它永远发不出去。
func TestDisabledTargetUserStillReceivesAccountDisabled(t *testing.T) {
	newNotificationTestDB(t)
	alice := seedNotificationUser(t, "alice")
	seedNotificationTemplate(t, model.NotificationEventAccountDisabled)
	setUserEnabled(t, alice.ID, false)

	SendEventTo(model.NotificationEventAccountDisabled,
		map[string]string{"username": "alice", "operator": "root"}, alice.ID)

	if got := inAppCount(t, alice.ID); got != 1 {
		t.Fatalf("the disabled target user got %d in-app notifications, want 1", got)
	}
}

// 会话被顶下线是安全事件：零订阅时当事人也必须收到（count < 邮件节流阈值，因此不发邮件）。
func TestSessionTakeoverReachesTargetUserWithoutSubscription(t *testing.T) {
	newNotificationTestDB(t)
	alice := seedNotificationUser(t, "alice")
	seedNotificationTemplate(t, model.NotificationEventSessionTakeover)

	deliverSessionTakeover(*alice, "10.0.0.1", "curl/8", 1, time.Now())

	if got := inAppCount(t, alice.ID); got != 1 {
		t.Fatalf("the target user got %d in-app notifications, want 1", got)
	}
}

// 全局站内信开关关掉时，两档「必收」都不写站内信（全局开关是对整个通道的取舍，
// 与「某事件能不能退订」是两个维度）。
func TestInAppSwitchDisablesTargetUserDelivery(t *testing.T) {
	newNotificationTestDB(t)
	alice := seedNotificationUser(t, "alice")
	seedNotificationTemplate(t, model.NotificationEventPasswordResetByAdmin)

	setting, err := model.GetNotificationSetting()
	if err != nil {
		t.Fatalf("reading notification setting: %v", err)
	}
	setting.InAppEnabled = false
	if _, err := model.UpdateNotificationSetting(*setting); err != nil {
		t.Fatalf("disabling the in-app channel: %v", err)
	}

	SendEventTo(model.NotificationEventPasswordResetByAdmin,
		map[string]string{"username": "alice"}, alice.ID)

	if got := inAppCount(t, alice.ID); got != 0 {
		t.Fatalf("the in-app channel is off but %d notifications were stored", got)
	}
}

// 清单本身：它是「当事人必收」的全部依据，改动必须是有意识的。
func TestTargetUserEventList(t *testing.T) {
	known := map[string]bool{}
	for _, event := range model.NotificationEventList() {
		known[event] = true
	}

	targets := model.TargetUserEvents()
	// 14 个事件里 13 个的当事人是本人；只有「通知邮件发送失败」的受众纯粹是管理员。
	if len(targets) != len(model.NotificationEventList())-1 {
		t.Fatalf("target user events = %d, want %d", len(targets), len(model.NotificationEventList())-1)
	}
	for _, event := range targets {
		if !known[event] {
			t.Errorf("target user event %q is not in NotificationEventList()", event)
		}
		if !model.NotificationEventTargetsUser(event) {
			t.Errorf("NotificationEventTargetsUser(%q) = false", event)
		}
	}

	// 邮件通道故障的受众只有管理员（它同时也在管理员必收清单里）。
	if model.NotificationEventTargetsUser(model.NotificationEventMailDeliveryFailed) {
		t.Error("mail_delivery_failed must not be a target-user event")
	}
	// 测试邮件由管理员在界面上指定收件人，不经过当事人档。
	if model.NotificationEventTargetsUser(model.NotificationEventTest) {
		t.Error("test must not be a target-user event")
	}
	// 账号与权限类事件必须都在清单里：这些消息本人看不到就无从申诉与自查。
	for _, event := range []string{
		model.NotificationEventPasswordResetByAdmin,
		model.NotificationEventMFAResetByAdmin,
		model.NotificationEventAccountDisabled,
		model.NotificationEventAccountEnabled,
		model.NotificationEventInactiveUserDisabled,
		model.NotificationEventAccountExpiring,
		model.NotificationEventPasswordExpiring,
		model.NotificationEventPasswordExpired,
		model.NotificationEventRoleAssigned,
		model.NotificationEventRoleUnassigned,
		model.NotificationEventSessionTakeover,
		model.NotificationEventRemoteLogin,
		// 任务创建者不在场时，他自己的任务失败了：与账号类事件一样必须送到本人。
		model.NotificationEventScheduledTaskFailed,
	} {
		if !model.NotificationEventTargetsUser(event) {
			t.Errorf("%q must reach the affected user", event)
		}
	}
}
