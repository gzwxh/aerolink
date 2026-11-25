package notification

import (
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/gzwxh/aerolink/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func newExpiryTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	// 停用会走「最后一个管理员」保护，需要单连接避免内存库的多连接可见性问题。
	if sqlDB, dbErr := db.DB(); dbErr == nil {
		sqlDB.SetMaxOpenConns(1)
	}
	if err := db.AutoMigrate(&model.User{}, &model.Role{}, &model.RoleAssignment{}); err != nil {
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

// 「账号有效期」此前只存在于界面与模型注释里：既没有任务执行，登录与鉴权也不看它，
// 所以设了不生效。这里覆盖执行侧：过期的被停用并留下可核查的原因，未到期的不受影响。
func TestCheckExpiredUsersDisablesOnlyExpiredAccounts(t *testing.T) {
	newExpiryTestDB(t)

	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	seed := []*model.User{
		{Username: "expired", Provider: model.AuthProviderPassword, Enabled: true, ExpiresAt: &past},
		{Username: "not-yet", Provider: model.AuthProviderPassword, Enabled: true, ExpiresAt: &future},
		{Username: "never", Provider: model.AuthProviderPassword, Enabled: true},
		{Username: "already-off", Provider: model.AuthProviderPassword, Enabled: false, ExpiresAt: &past},
	}
	for _, user := range seed {
		if err := model.DB.Create(user).Error; err != nil {
			t.Fatalf("seeding %s: %v", user.Username, err)
		}
	}
	// Enabled 的列默认值是 true，Create 会把零值 false 交给列默认值处理，
	// 所以已停用那条要显式改回去。
	if err := model.DB.Model(&model.User{}).Where("id = ?", seed[3].ID).
		Update("enabled", false).Error; err != nil {
		t.Fatalf("disabling the already-off account: %v", err)
	}

	if disabled := checkExpiredUsers(); disabled != 1 {
		t.Fatalf("checkExpiredUsers() disabled %d accounts, want 1", disabled)
	}

	reload := func(user *model.User) model.User {
		t.Helper()
		var after model.User
		if err := model.DB.First(&after, user.ID).Error; err != nil {
			t.Fatalf("reloading %s: %v", user.Username, err)
		}
		return after
	}

	expired := reload(seed[0])
	if expired.Enabled {
		t.Error("expired account is still enabled")
	}
	if expired.DisabledReason != model.DisableReasonExpired || expired.DisabledAt == nil {
		t.Errorf("expired account DisabledReason/DisabledAt = %q/%v, want the expired marker",
			expired.DisabledReason, expired.DisabledAt)
	}

	for _, user := range []*model.User{seed[1], seed[2]} {
		if !reload(user).Enabled {
			t.Errorf("%s was disabled but its account has not expired", user.Username)
		}
	}
	if got := reload(seed[3]); got.Enabled || got.DisabledReason != "" {
		t.Errorf("already-disabled account was touched: enabled=%v reason=%q", got.Enabled, got.DisabledReason)
	}
}
