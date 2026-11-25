package notification

import (
	"testing"

	"github.com/gzwxh/aerolink/pkg/model"
)

// 「管理员必收」的事件不允许被订阅配置关掉：没有任何订阅时，管理员也必须收到
// （重置密码、清动态码、角色变更、邮件通道故障这几类是追责与应急处置的线索）。
func TestMandatoryEventsReachAdminsWithoutAnySubscription(t *testing.T) {
	newNotificationTestDB(t)
	admin := seedNotificationAdmin(t)
	ordinary := seedNotificationUser(t, "alice")
	seedNotificationTemplate(t, model.NotificationEventRoleAssigned)

	SendEvent(model.NotificationEventRoleAssigned, map[string]string{"username": "alice"})

	if got := inAppCount(t, admin.ID); got != 1 {
		t.Fatalf("admin got %d in-app notifications, want 1", got)
	}
	if got := inAppCount(t, ordinary.ID); got != 0 {
		t.Fatalf("non-admin got %d in-app notifications, want 0", got)
	}
}

// 反面：非强制事件仍然只看订阅——管理员没订阅就收不到（这正是研发反馈的口径：
// 「没配置接收者就不要推给管理员」）。
func TestNonMandatoryEventsDoNotReachAdminsWithoutSubscription(t *testing.T) {
	newNotificationTestDB(t)
	admin := seedNotificationAdmin(t)
	seedNotificationTemplate(t, model.NotificationEventRemoteLogin)

	SendEvent(model.NotificationEventRemoteLogin, map[string]string{"username": "root", "ip": "10.0.0.1"})

	if got := inAppCount(t, admin.ID); got != 0 {
		t.Fatalf("admin got %d in-app notifications for a non-mandatory event, want 0", got)
	}
}

// 管理员退订不了：即便把该事件的订阅全部停用/删除，强制事件照样送达。
func TestMandatoryEventsIgnoreRemovedSubscriptions(t *testing.T) {
	newNotificationTestDB(t)
	admin := seedNotificationAdmin(t)
	seedNotificationTemplate(t, model.NotificationEventPasswordResetByAdmin)

	// 先有一条指向管理员的订阅，再删掉它（模拟管理员在界面上「取消推送」）。
	subscription := &model.NotificationSubscription{
		Event:        model.NotificationEventPasswordResetByAdmin,
		Channel:      model.NotificationChannelInApp,
		ReceiverType: model.NotificationReceiverUser,
		ReceiverID:   admin.ID,
		Receiver:     admin.Username,
		Enabled:      false,
	}
	if err := model.DB.Create(subscription).Error; err != nil {
		t.Fatalf("seeding subscription: %v", err)
	}
	if err := model.DB.Delete(subscription).Error; err != nil {
		t.Fatalf("deleting subscription: %v", err)
	}

	SendEvent(model.NotificationEventPasswordResetByAdmin, map[string]string{"username": "alice"})

	if got := inAppCount(t, admin.ID); got != 1 {
		t.Fatalf("admin got %d in-app notifications after unsubscribing, want 1", got)
	}
}

// 停用的账号不再收站内信（登不进来，也没人看）。这里顺带锁住「管理员解析」按 enabled 过滤。
func TestMandatoryEventsSkipDisabledAdmins(t *testing.T) {
	newNotificationTestDB(t)
	admin := seedNotificationAdmin(t)
	seedNotificationTemplate(t, model.NotificationEventMFAResetByAdmin)
	setUserEnabled(t, admin.ID, false)

	SendEvent(model.NotificationEventMFAResetByAdmin, map[string]string{"username": "alice"})

	if got := inAppCount(t, admin.ID); got != 0 {
		t.Fatalf("disabled admin got %d in-app notifications, want 0", got)
	}
}

// 投递必须走注入的解析器：pkg/rbac 依赖本包，只能由 app.go 注入更完整的实现
// （rbac.AdminUserIDs，覆盖权限绑定组授权）。这里注入一个受控实现，验证它真的被用上。
func TestMandatoryEventsUseInjectedAdminResolver(t *testing.T) {
	newNotificationTestDB(t)
	admin := seedNotificationAdmin(t)
	injected := seedNotificationUser(t, "ops")
	seedNotificationTemplate(t, model.NotificationEventRoleUnassigned)

	SetAdminUserResolver(func() ([]uint, error) { return []uint{injected.ID}, nil })
	t.Cleanup(func() { SetAdminUserResolver(nil) })

	SendEvent(model.NotificationEventRoleUnassigned, map[string]string{"username": "alice"})

	if got := inAppCount(t, injected.ID); got != 1 {
		t.Fatalf("injected admin got %d in-app notifications, want 1", got)
	}
	if got := inAppCount(t, admin.ID); got != 0 {
		t.Fatalf("default resolver was used despite the injected one: count = %d, want 0", got)
	}
}

// 强制事件与订阅命中同一个人时只写一条站内信（去重在并上管理员之后做）。
func TestMandatoryEventDoesNotDuplicateForSubscribedAdmin(t *testing.T) {
	newNotificationTestDB(t)
	admin := seedNotificationAdmin(t)
	seedNotificationTemplate(t, model.NotificationEventRoleAssigned)
	seedAllUsersSubscription(t, model.NotificationEventRoleAssigned)

	SendEvent(model.NotificationEventRoleAssigned, map[string]string{"username": "alice"})

	if got := inAppCount(t, admin.ID); got != 1 {
		t.Fatalf("admin got %d in-app notifications, want 1 (deduped)", got)
	}
}

// 清单本身：它就是「管理员不能退订」的全部依据，改动必须是有意识的。
func TestMandatoryEventList(t *testing.T) {
	mandatory := model.MandatoryAdminEvents()
	want := map[string]bool{
		model.NotificationEventPasswordResetByAdmin: true,
		model.NotificationEventMFAResetByAdmin:      true,
		model.NotificationEventRoleAssigned:         true,
		model.NotificationEventRoleUnassigned:       true,
		model.NotificationEventMailDeliveryFailed:   true,
	}
	if len(mandatory) != len(want) {
		t.Fatalf("mandatory events = %v, want %d entries", mandatory, len(want))
	}
	for _, event := range mandatory {
		if !want[event] {
			t.Errorf("unexpected mandatory event %q", event)
		}
		if !model.NotificationEventMandatoryForAdmins(event) {
			t.Errorf("NotificationEventMandatoryForAdmins(%q) = false", event)
		}
	}
	// 用户自己关心的事件（异地登录、密码过期）不在清单里：它们只发给订阅者。
	for _, event := range []string{
		model.NotificationEventRemoteLogin,
		model.NotificationEventPasswordExpiring,
		model.NotificationEventSessionTakeover,
	} {
		if model.NotificationEventMandatoryForAdmins(event) {
			t.Errorf("%q must not be mandatory: it would notify every admin on every login", event)
		}
	}
}
