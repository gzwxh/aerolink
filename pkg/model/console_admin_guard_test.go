package model

import (
	"errors"
	"fmt"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var guardTestDBCounter int

// newGuardTestDB 每个测试一个独立的共享缓存内存库：`:memory:` 下每条连接各自一个空库，
// 事务与事务外的读取必须看到同一个库（与真实部署的连接池行为一致）。
func newGuardTestDB(t *testing.T) {
	t.Helper()
	guardTestDBCounter++
	originalDB := DB
	dsn := fmt.Sprintf("file:console-admin-guard-%d?mode=memory&cache=shared", guardTestDBCounter)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(
		&GeneralSetting{},
		&User{},
		&Cluster{},
		&Role{},
		&RoleAssignment{},
		&BindingGroup{},
		&BindingGroupNamespace{},
		&BindingGroupMember{},
		&GroupMember{},
		&ResourceHistory{},
	); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })
}

func createGuardTestUser(t *testing.T, username string, enabled bool) User {
	t.Helper()
	// Enabled 带 `default:true`，GORM 在 Create 时会跳过它的零值，所以显式回写一次。
	user := User{Username: username, Enabled: true, Provider: "password"}
	if err := DB.Create(&user).Error; err != nil {
		t.Fatalf("creating user %q: %v", username, err)
	}
	if !enabled {
		if err := DB.Model(&User{}).Where("id = ?", user.ID).
			Update("enabled", false).Error; err != nil {
			t.Fatalf("disabling user %q: %v", username, err)
		}
		user.Enabled = false
	}
	return user
}

func assignGuardTestRole(t *testing.T, roleName, subject string) {
	t.Helper()
	if err := EnsureRoleAssignment(roleName, SubjectTypeUser, subject); err != nil {
		t.Fatalf("assigning role %q to %s: %v", roleName, subject, err)
	}
}

func createGuardTestRole(t *testing.T, role Role) Role {
	t.Helper()
	if err := DB.Create(&role).Error; err != nil {
		t.Fatalf("creating role %q: %v", role.Name, err)
	}
	return role
}

// assignGuardTestRoleToGroup 把一个角色分配给用户组（组主体）。
func assignGuardTestRoleToGroup(t *testing.T, roleName, groupName string) {
	t.Helper()
	role, err := GetRoleByName(roleName)
	if err != nil {
		t.Fatalf("load role %q: %v", roleName, err)
	}
	if err := DB.Create(&RoleAssignment{
		RoleID: role.ID, SubjectType: SubjectTypeGroup, Subject: groupName,
	}).Error; err != nil {
		t.Fatalf("assigning role %q to group %q: %v", roleName, groupName, err)
	}
}

// assignGuardTestGroupMember 把一个角色通过权限绑定组授给某个用户。
func assignGuardTestGroupMember(t *testing.T, projectID uint, username, roleName string) {
	t.Helper()
	role, err := GetRoleByName(roleName)
	if err != nil {
		t.Fatalf("load role %q: %v", roleName, err)
	}
	if err := DB.Create(&BindingGroupMember{
		ProjectID:   projectID,
		SubjectType: SubjectTypeUser,
		Subject:     username,
		RoleID:      role.ID,
	}).Error; err != nil {
		t.Fatalf("creating binding group member: %v", err)
	}
}

func reloadGuardTestUser(t *testing.T, id uint) User {
	t.Helper()
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		t.Fatalf("reloading user %d: %v", id, err)
	}
	return user
}

// 存量库补标只做一次：管理员删掉补标出来的账号之后，重启不能再把标记安到「当时
// 仍然持有 admin 的账号」身上。
func TestFlagExistingSuperAdminRunsOnce(t *testing.T) {
	newGuardTestDB(t)
	if err := InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}

	alice := createGuardTestUser(t, "alice", true)
	assignGuardTestRole(t, DefaultAdminRole.Name, alice.Username)

	if err := flagExistingSuperAdmin(); err != nil {
		t.Fatalf("flagExistingSuperAdmin: %v", err)
	}
	if !reloadGuardTestUser(t, alice.ID).IsSuperAdmin {
		t.Fatal("the only direct admin holder should have been flagged as super administrator")
	}
	setting, err := GetGeneralSetting()
	if err != nil {
		t.Fatalf("GetGeneralSetting: %v", err)
	}
	if !setting.SuperAdminFlagged {
		t.Fatal("the one-shot marker should have been recorded")
	}

	// 管理员删掉这个账号，另一个人接手 admin：判别已经跑过，不能再补标。
	if err := DB.Where("id = ?", alice.ID).Delete(&User{}).Error; err != nil {
		t.Fatalf("deleting alice: %v", err)
	}
	bob := createGuardTestUser(t, "bob", true)
	assignGuardTestRole(t, DefaultAdminRole.Name, bob.Username)
	if err := flagExistingSuperAdmin(); err != nil {
		t.Fatalf("second flagExistingSuperAdmin: %v", err)
	}
	if reloadGuardTestUser(t, bob.ID).IsSuperAdmin {
		t.Fatal("the one-shot marker must stop the legacy heuristic from flagging someone else")
	}
}

// 有多个 admin 候选说明这不是初始化向导建出来的库：宁可不补标，也不要猜错人。
func TestFlagExistingSuperAdminSkipsAmbiguousDatabases(t *testing.T) {
	newGuardTestDB(t)
	if err := InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}

	first := createGuardTestUser(t, "first", true)
	second := createGuardTestUser(t, "second", true)
	assignGuardTestRole(t, DefaultAdminRole.Name, first.Username)
	assignGuardTestRole(t, DefaultAdminRole.Name, second.Username)

	if err := flagExistingSuperAdmin(); err != nil {
		t.Fatalf("flagExistingSuperAdmin: %v", err)
	}
	if reloadGuardTestUser(t, first.ID).IsSuperAdmin || reloadGuardTestUser(t, second.ID).IsSuperAdmin {
		t.Fatal("an ambiguous database must not get a super administrator flag")
	}
	setting, err := GetGeneralSetting()
	if err != nil {
		t.Fatalf("GetGeneralSetting: %v", err)
	}
	if !setting.SuperAdminFlagged {
		t.Fatal("the one-shot marker should still be recorded so the guess never runs again")
	}
}

// 超级管理员**永远不支持删除**（只能停用）；停用则要求系统里还有别的启用账号持有系统
// 管理员角色。
func TestSuperAdminIsNeverDeletable(t *testing.T) {
	newGuardTestDB(t)
	if err := InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}

	super := createGuardTestUser(t, "super", true)
	if err := DB.Model(&User{}).Where("id = ?", super.ID).
		Update("is_super_admin", true).Error; err != nil {
		t.Fatalf("flagging super: %v", err)
	}
	assignGuardTestRole(t, DefaultAdminRole.Name, super.Username)

	// 其余账号只有一个普通自定义角色：既救不了场，也不是管理员。
	devops := createGuardTestUser(t, "devops", true)
	createGuardTestRole(t, Role{
		Name:      "devops",
		Clusters:  SliceString{"*"},
		Resources: SliceString{"*"},
		Verbs:     SliceString{"*"},
	})
	assignGuardTestRole(t, "devops", devops.Username)

	if err := DeleteUserByID(super.ID); !errors.Is(err, ErrSuperAdminNotDeletable) {
		t.Fatalf("deleting the super administrator returned %v, want ErrSuperAdminNotDeletable", err)
	}

	// 只给安全管理员**不够**：它能打开自己的页面，但接手不了系统管理员的职责。
	ops := createGuardTestUser(t, "ops", true)
	assignGuardTestRole(t, DefaultSecurityAdminRole.Name, ops.Username)
	if err := SetUserEnabled(super.ID, false); !errors.Is(err, ErrLastAdministrator) {
		t.Fatalf("the security administrator role alone must not be enough, got %v", err)
	}

	// 另一个启用账号持有系统管理员角色之后，停用放行。
	// （注意不能分配给已持安全管理员的 ops：那样的账号会被职责分离整体拒绝。）
	assignGuardTestRole(t, DefaultAdminRole.Name, devops.Username)
	if err := SetUserEnabled(super.ID, false); err != nil {
		t.Fatalf("disabling the super administrator should now succeed: %v", err)
	}
	if err := SetUserEnabled(super.ID, true); err != nil {
		t.Fatalf("re-enabling the super administrator: %v", err)
	}

	// 即使已经有人能接管，删除仍然是禁止的。
	if err := DeleteUserByID(super.ID); !errors.Is(err, ErrSuperAdminNotDeletable) {
		t.Fatalf("deleting the super administrator must stay refused, got %v", err)
	}
	var remaining int64
	DB.Model(&User{}).Where("id = ?", super.ID).Count(&remaining)
	if remaining != 1 {
		t.Fatal("the super administrator must still exist")
	}
}

// 普通账号：停用 / 删除后仍要有别的启用管理员，否则管理面会没人能接管；
// 与管理员无关的账号不受限制。
func TestAdministratorRemainsGuard(t *testing.T) {
	newGuardTestDB(t)
	if err := InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}

	alice := createGuardTestUser(t, "alice", true)
	assignGuardTestRole(t, DefaultAdminRole.Name, alice.Username)
	bob := createGuardTestUser(t, "bob", true)

	// alice 是唯一的在管管理员：停用与删除都要被拒。
	if err := SetUserEnabled(alice.ID, false); !errors.Is(err, ErrLastAdministrator) {
		t.Fatalf("disabling the only administrator returned %v, want ErrLastAdministrator", err)
	}
	if err := DeleteUserByID(alice.ID); !errors.Is(err, ErrLastAdministrator) {
		t.Fatalf("deleting the only administrator returned %v, want ErrLastAdministrator", err)
	}

	// bob 与管理员无关：不受这条保护（也不能被这条保护拦住）。
	if err := DeleteUserByID(bob.ID); err != nil {
		t.Fatalf("deleting a plain account should succeed: %v", err)
	}

	// 还有一个管理员时，停用与删除都放行。
	carol := createGuardTestUser(t, "carol", true)
	assignGuardTestRole(t, DefaultAdminRole.Name, carol.Username)
	if err := SetUserEnabled(alice.ID, false); err != nil {
		t.Fatalf("disabling an administrator while another exists: %v", err)
	}
	if err := SetUserEnabled(alice.ID, true); err != nil {
		t.Fatalf("re-enabling alice: %v", err)
	}
	if err := DeleteUserByID(carol.ID); err != nil {
		t.Fatalf("deleting an administrator while another exists: %v", err)
	}
}

// 「还有别的系统管理员」只认真正能接手的账号：停用的、只持安全 / 审计管理员角色的、只通过
// 普通（非全局）权限绑定组授权的、以及职责分离冲突被整体拒绝的都不算。
func TestEnabledAdministratorsFiltersUnusableAccounts(t *testing.T) {
	cases := []struct {
		name       string
		setup      func(t *testing.T)
		wantMember bool
	}{
		{
			name: "disabled account does not count",
			setup: func(t *testing.T) {
				ops := createGuardTestUser(t, "ops", false)
				assignGuardTestRole(t, DefaultAdminRole.Name, ops.Username)
			},
			wantMember: false,
		},
		{
			name: "only a security administrator does not count",
			setup: func(t *testing.T) {
				ops := createGuardTestUser(t, "ops", true)
				assignGuardTestRole(t, DefaultSecurityAdminRole.Name, ops.Username)
			},
			wantMember: false,
		},
		{
			name: "non-global binding group does not count",
			setup: func(t *testing.T) {
				ops := createGuardTestUser(t, "ops", true)
				group := BindingGroup{Cluster: "dev", Name: "普通组"}
				if err := DB.Create(&group).Error; err != nil {
					t.Fatalf("creating binding group: %v", err)
				}
				assignGuardTestGroupMember(t, group.ID, ops.Username, DefaultAdminRole.Name)
			},
			wantMember: false,
		},
		{
			name: "global binding group member counts",
			setup: func(t *testing.T) {
				ops := createGuardTestUser(t, "ops", true)
				group := BindingGroup{Cluster: "dev", Name: "超级权限绑定", Global: true}
				if err := DB.Create(&group).Error; err != nil {
					t.Fatalf("creating binding group: %v", err)
				}
				assignGuardTestGroupMember(t, group.ID, ops.Username, DefaultAdminRole.Name)
			},
			wantMember: true,
		},
		{
			name: "user group membership counts",
			setup: func(t *testing.T) {
				ops := createGuardTestUser(t, "ops", true)
				// 角色分配给用户组，用户靠所属组获得（rbac 读的是 users.oidc_groups 快照列）。
				if err := DB.Model(&User{}).Where("id = ?", ops.ID).
					Update("o_id_c_groups", "平台运维").Error; err != nil {
					t.Fatalf("setting user groups: %v", err)
				}
				assignGuardTestRoleToGroup(t, DefaultAdminRole.Name, "平台运维")
			},
			wantMember: true,
		},
		{
			name: "separation-of-duties conflict does not count",
			setup: func(t *testing.T) {
				ops := createGuardTestUser(t, "ops", true)
				// 系统管理员 + 安全管理员：管理面会被整体拒绝，不能算作兜底。
				assignGuardTestRole(t, DefaultAdminRole.Name, ops.Username)
				assignGuardTestRole(t, DefaultSecurityAdminRole.Name, ops.Username)
			},
			wantMember: false,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			newGuardTestDB(t)
			if err := InitDefaultRole(); err != nil {
				t.Fatalf("InitDefaultRole: %v", err)
			}
			testCase.setup(t)

			administrators, err := enabledAdministrators()
			if err != nil {
				t.Fatalf("enabledAdministrators: %v", err)
			}
			_, got := administrators["ops"]
			if got != testCase.wantMember {
				t.Fatalf("ops in enabledAdministrators = %v, want %v", got, testCase.wantMember)
			}
		})
	}
}
