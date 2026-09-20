package bindinggroups

import (
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupAutoBindTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.AutoMigrate(
		&model.Role{},
		&model.RoleAssignment{},
		&model.BindingGroup{},
		&model.BindingGroupNamespace{},
		&model.BindingGroupMember{},
	); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	model.DB = db
	t.Cleanup(func() { model.DB = originalDB })
}

func autoBindTestUser(name string, groups ...string) model.User {
	return model.User{Username: name, OIDCGroups: groups}
}

func autoBindTestRole(t *testing.T, name string, system bool, clusters, namespaces model.SliceString) model.Role {
	t.Helper()
	role := model.Role{Name: name, IsSystem: system, Clusters: clusters, Namespaces: namespaces}
	if err := model.DB.Create(&role).Error; err != nil {
		t.Fatalf("create role %s: %v", name, err)
	}
	return role
}

func autoBindTestGroup(t *testing.T, name string, global bool) model.BindingGroup {
	t.Helper()
	group := model.BindingGroup{Cluster: "c1", Name: name, Global: global}
	if err := model.DB.Create(&group).Error; err != nil {
		t.Fatalf("create group %s: %v", name, err)
	}
	return group
}

func autoBindTestMember(t *testing.T, group model.BindingGroup, subjectType, subject string, role model.Role) {
	t.Helper()
	m := model.BindingGroupMember{
		ProjectID:   group.ID,
		SubjectType: subjectType,
		Subject:     subject,
		RoleID:      role.ID,
	}
	if err := model.DB.Create(&m).Error; err != nil {
		t.Fatalf("create member: %v", err)
	}
}

func bindingsOf(t *testing.T) []model.BindingGroupNamespace {
	t.Helper()
	var rows []model.BindingGroupNamespace
	if err := model.DB.Find(&rows).Error; err != nil {
		t.Fatalf("list bindings: %v", err)
	}
	return rows
}

func roleNamespaces(t *testing.T, roleID uint) string {
	t.Helper()
	var role model.Role
	if err := model.DB.First(&role, roleID).Error; err != nil {
		t.Fatalf("reload role: %v", err)
	}
	value, err := role.Namespaces.Value()
	if err != nil {
		t.Fatalf("encode namespaces: %v", err)
	}
	text, _ := value.(string)
	return text
}

func TestAutoBindCreatedNamespace(t *testing.T) {
	setupAutoBindTestDB(t)
	reader := autoBindTestUser("reader")
	admin := model.User{
		Username: "boss",
		Roles:    []common.Role{{Name: model.DefaultAdminRole.Name}},
	}
	role := autoBindTestRole(t, "team-role", false, model.SliceString{"*"}, model.SliceString{"team-a"})

	// 1) 管理员：不归属
	if out := AutoBindCreatedNamespace(admin, "c1", "ns-admin"); out.Bound || out.Reason != NamespaceBindingReasonAdministrator {
		t.Fatalf("admin: got %+v", out)
	}
	if len(bindingsOf(t)) != 0 {
		t.Fatal("admin must not create bindings")
	}

	// 2) 普通用户、没有任何绑定组与受限角色：不归属
	if out := AutoBindCreatedNamespace(reader, "c1", "ns-lonely"); out.Bound || out.Reason != NamespaceBindingReasonNoCandidates {
		t.Fatalf("lonely: got %+v", out)
	}

	// 3) 恰好一个绑定组（直接成员）：自动归属
	group := autoBindTestGroup(t, "team", false)
	autoBindTestMember(t, group, model.SubjectTypeUser, "reader", role)
	out := AutoBindCreatedNamespace(reader, "c1", "ns-one")
	if !out.Bound || out.Method != NamespaceBindingMethodGroup || out.BindingName != "team" {
		t.Fatalf("one group: got %+v", out)
	}
	rows := bindingsOf(t)
	if len(rows) != 1 || rows[0].Namespace != "ns-one" || rows[0].ProjectID != group.ID {
		t.Fatalf("one group rows: %+v", rows)
	}

	// 4) 命名空间已被别的组占用：不覆盖，返回 conflict
	other := autoBindTestGroup(t, "other", false)
	if err := model.DB.Create(&model.BindingGroupNamespace{
		ProjectID: other.ID, Cluster: "c1", Namespace: "ns-taken",
	}).Error; err != nil {
		t.Fatalf("seed taken namespace: %v", err)
	}
	if out := AutoBindCreatedNamespace(reader, "c1", "ns-taken"); out.Bound || out.Reason != NamespaceBindingReasonConflict {
		t.Fatalf("conflict: got %+v", out)
	}

	// 5) 另一个集群：该集群里没有绑定组，不归属
	if out := AutoBindCreatedNamespace(reader, "c2", "ns-other-cluster"); out.Bound {
		t.Fatalf("other cluster: got %+v", out)
	}

	// 6) 通过用户组成为成员：自动归属
	group2 := autoBindTestGroup(t, "team-g", false)
	autoBindTestMember(t, group2, model.SubjectTypeGroup, "devs", role)
	grouped := autoBindTestUser("member", "devs")
	// 再加一个同样通过 "devs" 绑定的组 → 两个候选，不归属
	group3 := autoBindTestGroup(t, "team-g2", false)
	autoBindTestMember(t, group3, model.SubjectTypeGroup, "devs", role)
	if out := AutoBindCreatedNamespace(grouped, "c1", "ns-two-groups"); out.Bound ||
		out.Reason != NamespaceBindingReasonMultipleGroups {
		t.Fatalf("two groups: got %+v", out)
	}
	// 删掉一个候选组后只剩一个 → 归属
	if err := model.DB.Delete(&model.BindingGroupMember{}, "project_id = ?", group3.ID).Error; err != nil {
		t.Fatalf("delete members: %v", err)
	}
	if out := AutoBindCreatedNamespace(grouped, "c1", "ns-via-group"); !out.Bound || out.BindingName != "team-g" {
		t.Fatalf("via user group: got %+v", out)
	}

	// 7) 全局作用域的组不是候选：不归属（成员本来就覆盖全部命名空间）
	setupAutoBindTestDB(t)
	globalGroup := autoBindTestGroup(t, "super", true)
	autoBindTestMember(t, globalGroup, model.SubjectTypeUser, "reader", role)
	if out := AutoBindCreatedNamespace(reader, "c1", "ns-global"); out.Bound {
		t.Fatalf("global group must not capture namespaces: %+v", out)
	}
	if len(bindingsOf(t)) != 0 {
		t.Fatal("global group must not own the namespace")
	}
}

func TestAutoBindCreatedNamespaceFallbackToRoles(t *testing.T) {
	setupAutoBindTestDB(t)
	user := autoBindTestUser("dev")
	restricted := autoBindTestRole(t, "dev-role", false, model.SliceString{"*"}, model.SliceString{"team-a"})
	systemRole := autoBindTestRole(t, "viewer", true, model.SliceString{"*"}, model.SliceString{"team-a"})
	wildcardRole := autoBindTestRole(t, "wide", false, model.SliceString{"*"}, model.SliceString{"*"})
	foreignRole := autoBindTestRole(t, "other-cluster", false, model.SliceString{"c9"}, model.SliceString{"team-a"})
	for _, roleID := range []uint{restricted.ID, systemRole.ID, wildcardRole.ID, foreignRole.ID} {
		if err := model.DB.Create(&model.RoleAssignment{
			RoleID: roleID, SubjectType: model.SubjectTypeUser, Subject: "dev",
		}).Error; err != nil {
			t.Fatalf("assign role: %v", err)
		}
	}

	out := AutoBindCreatedNamespace(user, "c1", "team-b")
	if !out.Bound || out.Method != NamespaceBindingMethodRoles {
		t.Fatalf("fallback: got %+v", out)
	}
	if len(out.Roles) != 1 || out.Roles[0] != "dev-role" {
		t.Fatalf("only the non-system, restricted, in-cluster role may be widened: %+v", out.Roles)
	}
	if got := roleNamespaces(t, restricted.ID); got != "team-a,team-b" {
		t.Fatalf("restricted role namespaces: %q", got)
	}
	if got := roleNamespaces(t, systemRole.ID); got != "team-a" {
		t.Fatalf("system role must stay untouched: %q", got)
	}
	if got := roleNamespaces(t, wildcardRole.ID); got != "*" {
		t.Fatalf("wildcard role must stay untouched: %q", got)
	}
	if got := roleNamespaces(t, foreignRole.ID); got != "team-a" {
		t.Fatalf("role of another cluster must stay untouched: %q", got)
	}

	// 已包含该命名空间时不重复追加
	out = AutoBindCreatedNamespace(user, "c1", "team-b")
	if out.Bound {
		t.Fatalf("second call must be a no-op: %+v", out)
	}
	if got := roleNamespaces(t, restricted.ID); got != "team-a,team-b" {
		t.Fatalf("no duplicate expected: %q", got)
	}
}
