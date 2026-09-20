package rbac

import (
	"testing"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

// 「创建命名空间」是管理员专属动作，不通过授权配置下发：命名空间统一由管理员创建，
// 再通过权限绑定组授权给用户使用。它同时覆盖资源创建接口，以及 YAML apply
// （`POST /resources/apply` 用的也是同一个 CanAccess）。
// 口径见 docs/dev/plans/2026-09-20-namespace-create-admin-only.md。

func namespaceCreateTestRole(name string, namespaces, resources, verbs []string) common.Role {
	return common.Role{
		Name:       name,
		Clusters:   []string{"*"},
		Namespaces: namespaces,
		Resources:  resources,
		Verbs:      verbs,
	}
}

func adminUser(username string) model.User {
	return model.User{Username: username, Roles: []common.Role{{
		Name:      model.DefaultAdminRole.Name,
		Clusters:  []string{"*"},
		Resources: []string{"*"},
		Verbs:     []string{"*"},
	}}}
}

func TestCreateNamespaceRequiresAdministrator(t *testing.T) {
	ordinary := []struct {
		name  string
		roles []common.Role
	}{
		{
			name: "显式点名 namespaces 的受限角色",
			roles: []common.Role{
				namespaceCreateTestRole("dev-ns-admin", []string{"dev"}, []string{"namespaces"}, []string{"create", "get", "delete"}),
			},
		},
		{
			name:  "裸 * 通配角色",
			roles: []common.Role{namespaceCreateTestRole("wild-dev", []string{"dev"}, []string{"*"}, []string{"*"})},
		},
		{
			name:  "不受命名空间约束且点名 namespaces 的角色",
			roles: []common.Role{namespaceCreateTestRole("wide", []string{"*"}, []string{"namespaces"}, []string{"create"})},
		},
		{
			name:  "完全没有角色",
			roles: nil,
		},
	}
	for _, tc := range ordinary {
		if CanAccess(model.User{Username: "u", Roles: tc.roles},
			"namespaces", "create", "c1", common.AllNamespaces) {
			t.Errorf("%s 不应能创建命名空间", tc.name)
		}
	}

	// 管理员可以（直接持有 admin 角色）。
	if !CanAccess(adminUser("admin"), "namespaces", "create", "c1", common.AllNamespaces) {
		t.Error("管理员应能创建命名空间")
	}
}

// 除创建之外的操作口径不变：仍拿真实命名空间名匹配角色的命名空间列表。
func TestNamespaceOperationsBeyondCreateAreUnchanged(t *testing.T) {
	restricted := model.User{Username: "restricted", Roles: []common.Role{
		namespaceCreateTestRole("dev-ns-admin", []string{"dev"}, []string{"namespaces"}, []string{"create", "get", "delete"}),
	}}
	if !CanAccess(restricted, "namespaces", "delete", "c1", "dev") {
		t.Error("应能删除列表内的命名空间")
	}
	if CanAccess(restricted, "namespaces", "delete", "c1", "prod") {
		t.Error("不应删除列表外的命名空间")
	}
	if CanAccess(restricted, "namespaces", "get", "c1", common.AllNamespaces) {
		t.Error("列出全部命名空间仍需 _all/* 授权")
	}
	if CanAccess(restricted, "pods", "get", "c1", "dev") {
		t.Error("不应顺带授予其它资源")
	}
}

func TestCreateNamespaceAdministratorViaGlobalBindingGroup(t *testing.T) {
	bindingGroupRWLock.Lock()
	bindingGroupsCache = &bindingGroupCache{
		byNamespace: map[string]uint{},
		projects:    map[uint]string{7: "c1"},
		namespaces:  map[uint][]string{},
		globals:     map[uint]bool{7: true},
		members: map[uint][]bindingGroupMemberEntry{7: {{
			subjectType: model.SubjectTypeUser,
			subject:     "gadmin",
			role:        common.Role{Name: model.DefaultAdminRole.Name, Clusters: []string{"*"}, Resources: []string{"*"}, Verbs: []string{"*"}},
		}}},
	}
	bindingGroupRWLock.Unlock()
	t.Cleanup(func() {
		bindingGroupRWLock.Lock()
		bindingGroupsCache = nil
		bindingGroupRWLock.Unlock()
	})

	// 经全局权限绑定组持有管理员角色的账号同样算管理员。
	if !CanAccess(model.User{Username: "gadmin"}, "namespaces", "create", "c1", common.AllNamespaces) {
		t.Error("经全局绑定组持有 admin 的账号应能创建命名空间")
	}
	// 同组里换成非管理员角色就不行。
	bindingGroupRWLock.Lock()
	bindingGroupsCache.members[7][0].role = namespaceCreateTestRole("grp-ns", nil, []string{"namespaces"}, []string{"create"})
	bindingGroupRWLock.Unlock()
	if CanAccess(model.User{Username: "gadmin"}, "namespaces", "create", "c1", common.AllNamespaces) {
		t.Error("绑定组里的普通角色不应能创建命名空间")
	}
}

func TestCreateNamespaceNotGrantedViaBindingGroup(t *testing.T) {
	bindingGroupRWLock.Lock()
	bindingGroupsCache = &bindingGroupCache{
		byNamespace: map[string]uint{"c1/dev": 7},
		projects:    map[uint]string{7: "c1"},
		namespaces:  map[uint][]string{7: {"dev"}},
		globals:     map[uint]bool{7: false},
		members: map[uint][]bindingGroupMemberEntry{7: {{
			subjectType: model.SubjectTypeUser,
			subject:     "member",
			role:        namespaceCreateTestRole("grp-ns", nil, []string{"namespaces", "pods"}, []string{"create", "get"}),
		}}},
	}
	bindingGroupRWLock.Unlock()
	t.Cleanup(func() {
		bindingGroupRWLock.Lock()
		bindingGroupsCache = nil
		bindingGroupRWLock.Unlock()
	})

	// 无论角色怎么写、组内有没有命名空间，绑定组都不再下发「创建命名空间」。
	if CanAccess(model.User{Username: "member"}, "namespaces", "create", "c1", common.AllNamespaces) {
		t.Error("绑定组成员不应能创建命名空间")
	}
	// 组内其它授权不受影响。
	if !CanAccess(model.User{Username: "member"}, "namespaces", "get", "c1", "dev") {
		t.Error("绑定组成员的组内查看授权应保持不变")
	}
}

// 空组（还没有任何命名空间）不再有任何例外：指名资源的角色在空组里什么都授不了，
// 因此一条都不下发。以前为了「空组成员能建出第一个命名空间」而专门下发的
// namespaces 授权已经随创建口径一起取消。
func TestNamespaceScopedBindingGroupRolesSkipsEmptyGroups(t *testing.T) {
	setGroups := func(members []bindingGroupMemberEntry) {
		bindingGroupRWLock.Lock()
		bindingGroupsCache = &bindingGroupCache{
			byNamespace: map[string]uint{},
			projects:    map[uint]string{7: "c1"},
			namespaces:  map[uint][]string{},
			globals:     map[uint]bool{7: false},
			members:     map[uint][]bindingGroupMemberEntry{7: members},
		}
		bindingGroupRWLock.Unlock()
	}
	t.Cleanup(func() {
		bindingGroupRWLock.Lock()
		bindingGroupsCache = nil
		bindingGroupRWLock.Unlock()
	})

	for _, tc := range []struct {
		name string
		role common.Role
	}{
		{"点名 namespaces 且带 create", namespaceCreateTestRole("create-role", nil, []string{"namespaces", "pods"}, []string{"create", "get"})},
		{"只给 pods", namespaceCreateTestRole("pods-role", nil, []string{"pods"}, []string{"get"})},
		{"点名 namespaces 但没有 create", namespaceCreateTestRole("ns-read", nil, []string{"namespaces"}, []string{"get"})},
	} {
		setGroups([]bindingGroupMemberEntry{{
			subjectType: model.SubjectTypeUser,
			subject:     "member",
			role:        tc.role,
		}})
		if roles := NamespaceScopedBindingGroupRoles(model.User{Username: "member"}); len(roles) != 0 {
			t.Errorf("空组（%s）不应下发任何角色，得到 %d 条", tc.name, len(roles))
		}
	}
}
