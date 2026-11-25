package rbac

import (
	"testing"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func newAdminUsersTestDB(t *testing.T) {
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

func seedAdminUsersTestUser(t *testing.T, username string, enabled bool) *model.User {
	t.Helper()
	user := &model.User{Username: username, Provider: model.AuthProviderPassword, Enabled: enabled}
	if err := model.DB.Create(user).Error; err != nil {
		t.Fatalf("creating user %s: %v", username, err)
	}
	// enabled 的列默认值是 true，显式写回才能落到 false。
	if err := model.DB.Model(&model.User{}).Where("id = ?", user.ID).
		Update("enabled", enabled).Error; err != nil {
		t.Fatalf("setting enabled on %s: %v", username, err)
	}
	return user
}

// AdminUserIDs 必须覆盖两条授权路径：直接分配 admin 角色，以及通过**全局权限绑定组**
// 持有该角色（后者只能用内存里的角色映射判定，pkg/notification 看不到 rbac，所以由
// app.go 注入本函数）。
func TestAdminUserIDsCoversDirectAndGroupGrants(t *testing.T) {
	newAdminUsersTestDB(t)

	// 直接授权（SQL 路径）。
	direct := seedAdminUsersTestUser(t, "direct-admin", true)
	role := model.Role{Name: model.DefaultAdminRole.Name, Description: "管理所有资源"}
	if err := model.DB.Create(&role).Error; err != nil {
		t.Fatalf("creating the admin role: %v", err)
	}
	if err := model.DB.Create(&model.RoleAssignment{
		RoleID:      role.ID,
		SubjectType: model.SubjectTypeUser,
		Subject:     direct.Username,
	}).Error; err != nil {
		t.Fatalf("assigning the admin role: %v", err)
	}

	// 组授权（全局绑定组，内存缓存路径）。
	groupAdmin := seedAdminUsersTestUser(t, "group-admin", true)
	ordinary := seedAdminUsersTestUser(t, "ordinary", true)

	setupBindingGroupCache(t, &bindingGroupCache{
		byNamespace: map[string]uint{},
		projects:    map[uint]string{1: "c1"},
		globals:     map[uint]bool{1: true},
		members: map[uint][]bindingGroupMemberEntry{
			1: {{
				subjectType: model.SubjectTypeUser,
				subject:     groupAdmin.Username,
				role:        common.Role{Name: model.DefaultAdminRole.Name},
			}},
		},
	})

	ids, err := AdminUserIDs()
	if err != nil {
		t.Fatalf("AdminUserIDs() error = %v", err)
	}
	found := map[uint]bool{}
	for _, id := range ids {
		found[id] = true
	}
	if !found[direct.ID] {
		t.Errorf("directly assigned admin %d is missing from %v", direct.ID, ids)
	}
	if !found[groupAdmin.ID] {
		t.Errorf("group-granted admin %d is missing from %v", groupAdmin.ID, ids)
	}
	if found[ordinary.ID] {
		t.Errorf("ordinary user %d must not be reported as an admin", ordinary.ID)
	}
}

// 停用账号不进名单：站内信没人看，也不该为它算收件人。
func TestAdminUserIDsSkipsDisabledAccounts(t *testing.T) {
	newAdminUsersTestDB(t)

	disabled := seedAdminUsersTestUser(t, "disabled-admin", false)
	role := model.Role{Name: model.DefaultAdminRole.Name}
	if err := model.DB.Create(&role).Error; err != nil {
		t.Fatalf("creating the admin role: %v", err)
	}
	if err := model.DB.Create(&model.RoleAssignment{
		RoleID:      role.ID,
		SubjectType: model.SubjectTypeUser,
		Subject:     disabled.Username,
	}).Error; err != nil {
		t.Fatalf("assigning the admin role: %v", err)
	}

	ids, err := AdminUserIDs()
	if err != nil {
		t.Fatalf("AdminUserIDs() error = %v", err)
	}
	for _, id := range ids {
		if id == disabled.ID {
			t.Fatalf("disabled admin %d was reported as a recipient", disabled.ID)
		}
	}
}
