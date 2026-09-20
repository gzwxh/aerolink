package model

import (
	"fmt"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var groupMembershipTestDBCounter int

func newGroupMembershipTestDB(t *testing.T) {
	t.Helper()
	groupMembershipTestDBCounter++
	originalDB := DB
	dsn := fmt.Sprintf("file:group-membership-%d?mode=memory&cache=shared", groupMembershipTestDBCounter)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&User{}, &LocalGroup{}, &GroupMember{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })
}

func groupNamesOf(t *testing.T, userID uint) []string {
	t.Helper()
	var user User
	if err := DB.First(&user, userID).Error; err != nil {
		t.Fatalf("reloading user: %v", err)
	}
	return user.OIDCGroups
}

func membershipSources(t *testing.T, userID uint) map[string]string {
	t.Helper()
	var rows []GroupMember
	if err := DB.Where("user_id = ?", userID).Order("group_name asc").Find(&rows).Error; err != nil {
		t.Fatalf("loading memberships: %v", err)
	}
	sources := make(map[string]string, len(rows))
	for _, row := range rows {
		sources[row.GroupName] = row.Source
	}
	return sources
}

func containsGroup(groups []string, name string) bool {
	for _, group := range groups {
		if group == name {
			return true
		}
	}
	return false
}

// 核心需求：目录账号（LDAP / OIDC）也能被加进本地用户组，而且这份「本地附加」成员
// 关系不会被后续的目录同步冲掉；目录自己的组仍然由目录说了算。
func TestLocalGroupMembershipSurvivesDirectorySync(t *testing.T) {
	newGroupMembershipTestDB(t)

	ldapUser := User{Username: "ldap-user", Provider: AuthProviderLDAP, Enabled: true}
	if err := DB.Create(&ldapUser).Error; err != nil {
		t.Fatalf("creating ldap user: %v", err)
	}
	// 首次目录同步：目录给了 ldap-a。
	if _, err := SyncDirectoryGroupMembership(ldapUser.ID, []string{"ldap-a"}, GroupSourceLDAP); err != nil {
		t.Fatalf("seeding directory groups: %v", err)
	}

	// 管理员把该目录账号加入一个本地用户组。
	if err := AddLocalGroupMember(ldapUser.ID, "本地运维组"); err != nil {
		t.Fatalf("AddLocalGroupMember: %v", err)
	}
	if got := groupNamesOf(t, ldapUser.ID); !containsGroup(got, "ldap-a") || !containsGroup(got, "本地运维组") {
		t.Fatalf("effective groups = %v, want the directory group and the local group", got)
	}
	if local, err := IsLocalGroupMember(ldapUser.ID, "本地运维组"); err != nil || !local {
		t.Fatalf("本地运维组 should be a local membership, got local=%v err=%v", local, err)
	}
	if local, err := IsLocalGroupMember(ldapUser.ID, "ldap-a"); err != nil || local {
		t.Fatalf("ldap-a should not be a local membership, got local=%v err=%v", local, err)
	}

	// 下一次目录同步：目录把 ldap-a 换成 ldap-b，并且完全不提本地组。
	if _, err := SyncDirectoryGroupMembership(ldapUser.ID, []string{"ldap-b"}, GroupSourceLDAP); err != nil {
		t.Fatalf("SyncDirectoryGroupMembership: %v", err)
	}

	effective := groupNamesOf(t, ldapUser.ID)
	if !containsGroup(effective, "本地运维组") {
		t.Fatalf("the local membership must survive a directory sync, got %v", effective)
	}
	if !containsGroup(effective, "ldap-b") || containsGroup(effective, "ldap-a") {
		t.Fatalf("directory groups must follow the directory, got %v", effective)
	}
	sources := membershipSources(t, ldapUser.ID)
	if sources["本地运维组"] != GroupSourceLocal {
		t.Fatalf("本地运维组 source = %q, want %q", sources["本地运维组"], GroupSourceLocal)
	}
	if sources["ldap-b"] != GroupSourceLDAP {
		t.Fatalf("ldap-b source = %q, want %q", sources["ldap-b"], GroupSourceLDAP)
	}
	if _, ok := sources["ldap-a"]; ok {
		t.Fatalf("the stale directory membership should be gone: %v", sources)
	}

	// 移除本地附加成员关系：只掉本地组，目录组不受影响。
	if err := RemoveLocalGroupMember(ldapUser.ID, "本地运维组"); err != nil {
		t.Fatalf("RemoveLocalGroupMember: %v", err)
	}
	remaining := groupNamesOf(t, ldapUser.ID)
	if containsGroup(remaining, "本地运维组") {
		t.Fatalf("the local membership should be gone, got %v", remaining)
	}
	if !containsGroup(remaining, "ldap-b") {
		t.Fatalf("removing a local membership must not touch directory groups, got %v", remaining)
	}
}

// 本地账号（provider = password）的成员关系同样是本地来源，编辑用户时的「完整列表替换」
// 语义必须保留：不因为并集逻辑而残留已移除的组。
func TestNativeUserGroupMembershipIsFullyReplaced(t *testing.T) {
	newGroupMembershipTestDB(t)

	user := User{Username: "native-user", Provider: AuthProviderPassword, Enabled: true}
	if err := DB.Create(&user).Error; err != nil {
		t.Fatalf("creating native user: %v", err)
	}
	if got := groupSourceForProvider(AuthProviderPassword); got != GroupSourceLocal {
		t.Fatalf("native group source = %q, want %q", got, GroupSourceLocal)
	}
	if got := groupSourceForProvider(AuthProviderLDAP); got != GroupSourceLDAP {
		t.Fatalf("ldap group source = %q, want %q", got, GroupSourceLDAP)
	}
	if got := groupSourceForProvider("github"); got != GroupSourceOIDC {
		t.Fatalf("oidc group source = %q, want %q", got, GroupSourceOIDC)
	}

	// 管理员一次提交完整列表：a、b。（真实路径是 UpdateUser 写列 + 镜像到 group_members）
	edit := func(groups []string) error {
		if err := DB.Model(&User{}).Where("id = ?", user.ID).
			Update("o_id_c_groups", strings.Join(groups, ",")).Error; err != nil {
			return err
		}
		return SyncUserGroupMembership(user.ID, groups, GroupSourceLocal)
	}
	if err := edit([]string{"a", "b"}); err != nil {
		t.Fatalf("admin edit: %v", err)
	}
	if got := groupNamesOf(t, user.ID); len(got) != 2 {
		t.Fatalf("native user groups = %v, want [a b] after the admin edit", got)
	}
	// 再提交一次去掉 b：b 必须真的消失（不能因为「本地附加」语义而残留）。
	if err := edit([]string{"a"}); err != nil {
		t.Fatalf("second admin edit: %v", err)
	}
	if sources := membershipSources(t, user.ID); len(sources) != 1 || sources["a"] != GroupSourceLocal {
		t.Fatalf("native memberships = %v, want only a(local)", sources)
	}
}
