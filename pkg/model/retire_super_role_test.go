package model

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 代次 3 的单向迁移：内置超级角色并入系统管理员。老库里的 super-admin 角色行与它的
// 引用都必须被清掉，而且**不会再回来**——系统里永远只有一个最高权限角色（admin）。
//
// 权限覆盖本身由 pkg/rbac 的 roleAllows 断言（见 separation_of_duties_test.go）。
func TestRetireSuperRoleIsOneWay(t *testing.T) {
	originalDB := DB
	// 共享缓存的命名内存库：事务与事务外的读取要用同一个库（`:memory:` 下每条连接
	// 各自一个空库，与真实部署的连接池行为不符）。
	db, err := gorm.Open(sqlite.Open("file:super-role-retire-test?mode=memory&cache=shared"), &gorm.Config{
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
		&BindingGroupMember{},
	); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })

	roleExists := func() bool {
		var count int64
		DB.Model(&Role{}).Where("name = ?", SuperRoleName).Count(&count)
		return count > 0
	}

	// 存量库的形态：老代码播种出来的 super-admin 角色，且已经被分配 / 绑进权限绑定组。
	legacy := Role{
		Name:        SuperRoleName,
		Description: "Super administrator role with unrestricted access",
		IsSystem:    true,
		Clusters:    SliceString{"*"},
		Namespaces:  SliceString{"*"},
		Resources:   SliceString{"*", "settings"},
		Verbs:       SliceString{"*"},
	}
	if err := DB.Create(&legacy).Error; err != nil {
		t.Fatalf("seeding the legacy super role: %v", err)
	}
	if err := DB.Create(&RoleAssignment{
		RoleID: legacy.ID, SubjectType: SubjectTypeUser, Subject: "super",
	}).Error; err != nil {
		t.Fatalf("assigning the legacy super role: %v", err)
	}
	group := BindingGroup{Cluster: "dev", Name: SuperBindingGroupName, Global: true, Protected: true}
	if err := DB.Create(&group).Error; err != nil {
		t.Fatalf("creating binding group: %v", err)
	}
	if err := DB.Create(&BindingGroupMember{
		ProjectID: group.ID, SubjectType: SubjectTypeUser, Subject: "super",
		RoleID: legacy.ID, Protected: true,
	}).Error; err != nil {
		t.Fatalf("creating binding group member: %v", err)
	}

	// 完整启动顺序：播种 → 代次迁移 → 退休迁移。
	if err := InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}
	if err := MigrateSystemRoleRules(); err != nil {
		t.Fatalf("MigrateSystemRoleRules: %v", err)
	}
	if err := RetireSuperRole(); err != nil {
		t.Fatalf("RetireSuperRole: %v", err)
	}

	if roleExists() {
		t.Fatal("the legacy super role should be deleted by the retirement migration")
	}
	if !SuperRoleRemoved() {
		t.Fatal("the retirement migration should record its marker")
	}
	var assignments int64
	DB.Model(&RoleAssignment{}).Where("role_id = ?", legacy.ID).Count(&assignments)
	if assignments != 0 {
		t.Fatal("the retired role must leave no direct assignment behind")
	}
	var members int64
	DB.Model(&BindingGroupMember{}).Where("role_id = ?", legacy.ID).Count(&members)
	if members != 0 {
		t.Fatal("the retired role must leave no binding group member behind")
	}

	// 重启（再播种 + 再迁移）都不能把它带回来。
	if err := InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole after retirement: %v", err)
	}
	if err := RestoreSystemRoleDefaults(); err != nil {
		t.Fatalf("RestoreSystemRoleDefaults: %v", err)
	}
	if roleExists() {
		t.Fatal("a restart must not resurrect the retired super role")
	}

	// 只做一次：第二次调用是空操作，标记保持。
	if err := RetireSuperRole(); err != nil {
		t.Fatalf("second RetireSuperRole: %v", err)
	}
	if !SuperRoleRemoved() {
		t.Fatal("the retirement marker must stay recorded")
	}

	// 唯一的高权限角色是系统管理员，且它不再是「排除授权对象」的窄口径定义。
	admin, err := GetRoleByName(DefaultAdminRole.Name)
	if err != nil {
		t.Fatalf("GetRoleByName(admin): %v", err)
	}
	if !admin.IsSystem {
		t.Fatal("the merged administrator role must stay a built-in role")
	}
	for _, pattern := range admin.Resources {
		if len(pattern) > 0 && pattern[0] == '!' {
			t.Fatalf("the merged administrator role must not keep exclusion rules: %v", admin.Resources)
		}
	}
}
