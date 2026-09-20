package model

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 删除账号不得带走它的审计记录（等保三级安全审计）：OperatorID 置空、用户名快照保留，
// 记录本身必须还在。
func TestDeleteUserKeepsAuditHistory(t *testing.T) {
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
		t.Fatalf("enabling foreign keys: %v", err)
	}
	if err := db.AutoMigrate(
		&User{},
		&Role{},
		&RoleAssignment{},
		&BindingGroupMember{},
		&GroupMember{},
		&ResourceHistory{},
	); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = previousDB })

	user := &User{Username: "departing", Password: "x", Provider: AuthProviderPassword, Enabled: true}
	if err := db.Create(user).Error; err != nil {
		t.Fatalf("creating user: %v", err)
	}

	history := ResourceHistory{
		ClusterName:   "prod",
		ResourceType:  "pods",
		ResourceName:  "web-1",
		Namespace:     "default",
		OperationType: "delete",
		OperatorID:    OperatorRef(user.ID),
		OperatorName:  user.Username,
		Success:       true,
	}
	if err := db.Create(&history).Error; err != nil {
		t.Fatalf("creating audit history: %v", err)
	}

	if err := DeleteUserByID(user.ID); err != nil {
		t.Fatalf("deleting user: %v", err)
	}

	var remaining []ResourceHistory
	if err := db.Find(&remaining).Error; err != nil {
		t.Fatalf("loading audit history: %v", err)
	}
	if len(remaining) != 1 {
		t.Fatalf("expected the audit record to survive the account deletion, got %d record(s)", len(remaining))
	}
	if remaining[0].OperatorName != "departing" {
		t.Fatalf("operator name snapshot = %q, want %q", remaining[0].OperatorName, "departing")
	}
	if remaining[0].OperatorID != nil {
		t.Fatalf("operator id should be cleared once the account is gone, got %v", *remaining[0].OperatorID)
	}
}
