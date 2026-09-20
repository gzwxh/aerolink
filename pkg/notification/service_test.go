package notification

import (
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func newNotificationTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if sqlDB, dbErr := db.DB(); dbErr == nil {
		sqlDB.SetMaxOpenConns(1)
	}
	if err := db.AutoMigrate(
		&model.User{},
		&model.NotificationSetting{},
		&model.NotificationTemplate{},
		&model.NotificationSubscription{},
		&model.Notification{},
		// 管理员解析（强制送达的安全事件）走 role_assignments，缺表会静默查不到管理员。
		&model.Role{},
		&model.RoleAssignment{},
	); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	model.DB = db
	t.Cleanup(func() {
		model.DB = originalDB
		if sqlDB, dbErr := db.DB(); dbErr == nil {
			_ = sqlDB.Close()
		}
	})
}

// seedNotificationAdmin 建一个持有内置 admin 角色的账号：强制送达的安全事件要发给它。
func seedNotificationAdmin(t *testing.T, username string) *model.User {
	t.Helper()
	user := seedNotificationUser(t, username)

	var role model.Role
	if err := model.DB.Where("name = ?", model.DefaultAdminRole.Name).First(&role).Error; err != nil {
		role = model.Role{Name: model.DefaultAdminRole.Name, Description: "admin"}
		if err := model.DB.Create(&role).Error; err != nil {
			t.Fatalf("seeding admin role: %v", err)
		}
	}
	if err := model.DB.Create(&model.RoleAssignment{
		RoleID:      role.ID,
		SubjectType: model.SubjectTypeUser,
		Subject:     user.Username,
	}).Error; err != nil {
		t.Fatalf("assigning the admin role to %s: %v", username, err)
	}
	return user
}

func seedNotificationUser(t *testing.T, username string) *model.User {
	t.Helper()
	user := &model.User{Username: username, Provider: model.AuthProviderPassword, Enabled: true}
	if err := model.DB.Create(user).Error; err != nil {
		t.Fatalf("seeding %s: %v", username, err)
	}
	// Enabled 的列默认值是 true，零值会被列默认值覆盖，这里显式写回。
	if err := model.DB.Model(&model.User{}).Where("id = ?", user.ID).
		Update("enabled", true).Error; err != nil {
		t.Fatalf("enabling %s: %v", username, err)
	}
	return user
}

func inAppCount(t *testing.T, userID uint) int {
	t.Helper()
	var count int64
	if err := model.DB.Model(&model.Notification{}).
		Where("user_id = ?", userID).Count(&count).Error; err != nil {
		t.Fatalf("counting notifications for user %d: %v", userID, err)
	}
	return int(count)
}

// 站内信只发给**订阅了**该事件 + 站内信渠道的接收者。
//
// 改前 SendEvent 还接受调用方传入的「额外接收人」（受影响的那个用户、全部管理员等），
// 那条路径不看订阅，于是从没订阅过站内信的人也会收到 —— 现网就是这样：订阅表是空的，
// 但通知表里有上千条。
func TestSendEventDeliversInAppOnlyToSubscribers(t *testing.T) {
	newNotificationTestDB(t)
	alice := seedNotificationUser(t, "alice")
	bob := seedNotificationUser(t, "bob")
	if err := model.DB.Create(&model.NotificationTemplate{
		Event:   model.NotificationEventRemoteLogin,
		Subject: "异地登录",
		Body:    "{{username}} 在 {{ip}} 登录",
		Enabled: true,
	}).Error; err != nil {
		t.Fatalf("seeding template: %v", err)
	}

	variables := map[string]string{"username": "alice", "ip": "10.0.0.1"}

	// 没有任何订阅：谁都不该收到。
	SendEvent(model.NotificationEventRemoteLogin, variables)
	if got := inAppCount(t, alice.ID) + inAppCount(t, bob.ID); got != 0 {
		t.Fatalf("without any subscription %d in-app notifications were stored, want 0", got)
	}

	// 只给 bob 订阅站内信：只有 bob 收到。
	if err := model.DB.Create(&model.NotificationSubscription{
		Event:        model.NotificationEventRemoteLogin,
		Channel:      model.NotificationChannelInApp,
		ReceiverType: model.NotificationReceiverUser,
		ReceiverID:   bob.ID,
		Receiver:     bob.Username,
		Enabled:      true,
	}).Error; err != nil {
		t.Fatalf("seeding subscription: %v", err)
	}
	SendEvent(model.NotificationEventRemoteLogin, variables)
	if got := inAppCount(t, bob.ID); got != 1 {
		t.Fatalf("subscriber got %d in-app notifications, want 1", got)
	}
	if got := inAppCount(t, alice.ID); got != 0 {
		t.Fatalf("non-subscriber got %d in-app notifications, want 0", got)
	}

	// 订阅被停用后不再投递。
	if err := model.DB.Model(&model.NotificationSubscription{}).
		Where("receiver_id = ?", bob.ID).Update("enabled", false).Error; err != nil {
		t.Fatalf("disabling subscription: %v", err)
	}
	SendEvent(model.NotificationEventRemoteLogin, variables)
	if got := inAppCount(t, bob.ID); got != 1 {
		t.Fatalf("disabled subscription still delivered: count = %d, want 1", got)
	}

	// 只订阅邮件渠道时不该写站内信。
	if err := model.DB.Create(&model.NotificationSubscription{
		Event:        model.NotificationEventRemoteLogin,
		Channel:      model.NotificationChannelEmail,
		ReceiverType: model.NotificationReceiverEmail,
		Receiver:     "ops@example.com",
		Enabled:      true,
	}).Error; err != nil {
		t.Fatalf("seeding email subscription: %v", err)
	}
	SendEvent(model.NotificationEventRemoteLogin, variables)
	if got := inAppCount(t, alice.ID) + inAppCount(t, bob.ID); got != 1 {
		t.Fatalf("email-only subscription wrote an in-app notification: total = %d, want 1", got)
	}
}

func seedNotificationTemplate(t *testing.T, event string) {
	t.Helper()
	if err := model.DB.Create(&model.NotificationTemplate{
		Event:   event,
		Subject: "异地登录",
		Body:    "{{username}} 登录",
		Enabled: true,
	}).Error; err != nil {
		t.Fatalf("seeding template: %v", err)
	}
}

func seedAllUsersSubscription(t *testing.T, event, channel string) {
	t.Helper()
	if err := model.DB.Create(&model.NotificationSubscription{
		Event:        event,
		Channel:      channel,
		ReceiverType: model.NotificationReceiverAllUsers,
		Enabled:      true,
	}).Error; err != nil {
		t.Fatalf("seeding all-users subscription: %v", err)
	}
}

func setUserEnabled(t *testing.T, userID uint, enabled bool) {
	t.Helper()
	if err := model.DB.Model(&model.User{}).Where("id = ?", userID).
		Update("enabled", enabled).Error; err != nil {
		t.Fatalf("setting enabled on user %d: %v", userID, err)
	}
}

func setUserEmail(t *testing.T, userID uint, email string) {
	t.Helper()
	if err := model.DB.Model(&model.User{}).Where("id = ?", userID).
		Update("email", email).Error; err != nil {
		t.Fatalf("setting email on user %d: %v", userID, err)
	}
}

// 「全体用户」订阅是在**投递时**展开的，不是把订阅那一刻的账号列表固定下来：
// 订阅建好之后新入职的账号也要收到（否则管理员得为每个新人回来补一条）。
func TestAllUsersSubscriptionExpandsAtDeliveryTime(t *testing.T) {
	newNotificationTestDB(t)
	alice := seedNotificationUser(t, "alice")
	seedNotificationTemplate(t, model.NotificationEventRemoteLogin)
	seedAllUsersSubscription(t, model.NotificationEventRemoteLogin, model.NotificationChannelInApp)

	// 订阅之后再入职一个账号。
	carol := seedNotificationUser(t, "carol")

	SendEvent(model.NotificationEventRemoteLogin, map[string]string{"username": "alice"})

	if got := inAppCount(t, alice.ID); got != 1 {
		t.Fatalf("existing user got %d in-app notifications, want 1", got)
	}
	if got := inAppCount(t, carol.ID); got != 1 {
		t.Fatalf("user created after the subscription got %d in-app notifications, want 1", got)
	}
}

// 停用账号不属于「全体用户」；同一个人被「全体用户」与单独订阅同时命中时只发一份。
// 邮件渠道下没有邮箱的账号也会被跳过。
func TestAllUsersSubscriptionResolvesCurrentRecipients(t *testing.T) {
	newNotificationTestDB(t)
	event := model.NotificationEventRemoteLogin
	alice := seedNotificationUser(t, "alice")
	bob := seedNotificationUser(t, "bob")
	carol := seedNotificationUser(t, "carol") // 没有邮箱
	setUserEmail(t, alice.ID, "alice@example.com")
	setUserEmail(t, bob.ID, "bob@example.com")
	// alice 已停用：既不该收站内信，也不该收邮件。
	setUserEnabled(t, alice.ID, false)

	seedAllUsersSubscription(t, event, model.NotificationChannelInApp)

	users, _ := resolveRecipients(event)
	if containsID(users, alice.ID) {
		t.Errorf("disabled user %d is still a recipient", alice.ID)
	}
	for _, want := range []uint{bob.ID, carol.ID} {
		if !containsID(users, want) {
			t.Errorf("user %d is missing from the expanded recipients: %v", want, users)
		}
	}

	// 再叠一条单独订阅 bob 的规则：不能因此出现两份。
	if err := model.DB.Create(&model.NotificationSubscription{
		Event:        event,
		Channel:      model.NotificationChannelInApp,
		ReceiverType: model.NotificationReceiverUser,
		ReceiverID:   bob.ID,
		Receiver:     bob.Username,
		Enabled:      true,
	}).Error; err != nil {
		t.Fatalf("seeding user subscription: %v", err)
	}
	users, _ = resolveRecipients(event)
	if len(users) != 2 {
		t.Fatalf("recipients = %v, want exactly bob and carol once each", users)
	}
	if countID(users, bob.ID) != 1 {
		t.Fatalf("bob appears %d times, want 1", countID(users, bob.ID))
	}

	// 邮件渠道：只收有邮箱的账号（alice 停用、carol 没邮箱）。
	if err := model.DB.Model(&model.NotificationSubscription{}).
		Where("receiver_type = ?", model.NotificationReceiverAllUsers).
		Update("channel", model.NotificationChannelEmail).Error; err != nil {
		t.Fatalf("switching the all-users subscription to email: %v", err)
	}
	_, emails := resolveRecipients(event)
	if emails["bob@example.com"] != true {
		t.Errorf("bob's address is missing from the email recipients: %v", emails)
	}
	if emails["alice@example.com"] {
		t.Errorf("a disabled user's address is still a recipient: %v", emails)
	}
	if len(emails) != 1 {
		t.Errorf("emails = %v, want only bob's address", emails)
	}
}

func containsID(ids []uint, want uint) bool {
	return countID(ids, want) > 0
}

func countID(ids []uint, want uint) int {
	count := 0
	for _, id := range ids {
		if id == want {
			count++
		}
	}
	return count
}
