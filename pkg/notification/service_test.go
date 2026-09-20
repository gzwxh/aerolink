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
