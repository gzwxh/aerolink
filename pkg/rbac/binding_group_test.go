package rbac

import (
	"testing"

	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
)

const (
	groupUser         = "alice"
	groupOther        = "bob"
	groupTeam         = "sre"
	groupWildcardUser = "dave"
)

// podReaderRole 是权限绑定组最典型的成员角色：只管 pods 的读。
func podReaderRole() common.Role {
	return common.Role{
		Name:      "pod-reader",
		Resources: []string{"pods"},
		Verbs:     []string{string(common.VerbGet)},
	}
}

// clusterReaderRole 是资源通配角色（权限 ID 是 k8s:*:get）：它写的是「集群里的一切
// 资源」，作用范围是整个集群，不受权限绑定组的命名空间列表收窄。
func clusterReaderRole() common.Role {
	return common.Role{
		Name:      "cluster-reader",
		Resources: []string{"*"},
		Verbs:     []string{string(common.VerbGet)},
	}
}

// setupBindingGroupCache 安装一份内存缓存，测试结束后恢复。
func setupBindingGroupCache(t *testing.T, cache *bindingGroupCache) {
	t.Helper()
	originalConfig := RBACConfig
	originalCache := bindingGroupsCache
	t.Cleanup(func() {
		RBACConfig = originalConfig
		bindingGroupsCache = originalCache
	})
	RBACConfig = &common.RolesConfig{Roles: []common.Role{}, RoleMapping: []common.RoleMapping{}}
	bindingGroupsCache = cache
}

// newBindingGroupCache 构造三组数据：
//   - c1/dev：alice（用户）+ sre（用户组）成员的组
//   - c1/prod：归属存在但没有成员
//   - c2/dev：bob 成员的组（同名命名空间，另一个集群）
func newBindingGroupCache() *bindingGroupCache {
	return &bindingGroupCache{
		byNamespace: map[string]uint{"c1/dev": 1, "c1/prod": 2, "c2/dev": 3},
		projects:    map[uint]string{1: "c1", 2: "c1", 3: "c2"},
		members: map[uint][]bindingGroupMemberEntry{
			1: {
				{subjectType: model.SubjectTypeUser, subject: groupUser, role: podReaderRole()},
				{subjectType: model.SubjectTypeGroup, subject: groupTeam, role: podReaderRole()},
			},
			2: {},
			3: {{subjectType: model.SubjectTypeUser, subject: groupOther, role: podReaderRole()}},
		},
	}
}

// wildcardBindingGroupCache 在 c1/dev 的组里追加一个资源通配角色的成员。
func wildcardBindingGroupCache() *bindingGroupCache {
	cache := newBindingGroupCache()
	cache.members[1] = append(cache.members[1], bindingGroupMemberEntry{
		subjectType: model.SubjectTypeUser,
		subject:     groupWildcardUser,
		role:        clusterReaderRole(),
	})
	return cache
}

// 职责分离的写入侧校验：编辑一个权限绑定组时，必须忽略该组**当前**授予该用户的
// 角色，否则「把组里的 admin 换成 auditor」会被误判成冲突。
func TestSeparationOfDutiesConflictOnGrantExcludesOwnGroupRoles(t *testing.T) {
	const groupID = 7
	// 全局作用域：只有全局组的角色会进入用户的管理面判定（章节资源是全局的），
	// 因此这个场景用 globals 标记该组。
	setupBindingGroupCache(t, &bindingGroupCache{
		byNamespace: map[string]uint{},
		projects:    map[uint]string{groupID: "c1"},
		globals:     map[uint]bool{groupID: true},
		members: map[uint][]bindingGroupMemberEntry{
			groupID: {
				{subjectType: model.SubjectTypeUser, subject: groupUser, role: common.Role{Name: model.DefaultAdminRole.Name}},
			},
		},
	})

	// alice 当前通过这个全局组持有 admin；把组改成给她 auditor 是合法变更。
	alice := model.User{Username: groupUser}
	if conflict, roles := SeparationOfDutiesConflictOnGrant(alice, groupID, model.DefaultAuditorRole.Name); conflict {
		t.Fatalf("rewriting the group's own grant must not conflict, got %v", roles)
	}

	// 但同一个组写成 admin + auditor 仍然冲突。
	if conflict, _ := SeparationOfDutiesConflictOnGrant(alice, groupID, model.DefaultAdminRole.Name, model.DefaultAuditorRole.Name); !conflict {
		t.Fatal("granting both roles in one group must conflict")
	}

	// 不排除组内角色时（直接分配），她已有的 admin 与新的 auditor 冲突。
	if conflict, _ := SeparationOfDutiesConflictWith(alice, model.DefaultAuditorRole.Name); !conflict {
		t.Fatal("the group-granted admin role must still conflict for direct assignments")
	}
}

// BindingGroupRoleNames 只返回目标组授予该用户的角色。
func TestBindingGroupRoleNamesScopesToTheGroup(t *testing.T) {
	setupBindingGroupCache(t, newBindingGroupCache())

	got := BindingGroupRoleNames(1, groupUser, nil)
	if len(got) != 1 || got[0] != "pod-reader" {
		t.Fatalf("BindingGroupRoleNames(1, alice) = %v, want [pod-reader]", got)
	}
	if names := BindingGroupRoleNames(2, groupUser, nil); len(names) != 0 {
		t.Fatalf("a group without members must yield no roles, got %v", names)
	}
	if names := BindingGroupRoleNames(1, groupOther, nil); len(names) != 0 {
		t.Fatalf("another user's roles must not leak, got %v", names)
	}
}

func TestCanAccessViaBindingGroup(t *testing.T) {
	wildcardCache := wildcardBindingGroupCache()
	cases := []struct {
		name      string
		user      model.User
		resource  string
		verb      string
		cluster   string
		namespace string
		cache     *bindingGroupCache // 为空时使用 newBindingGroupCache()
		expected  bool
	}{
		{
			name:      "成员命中绑定角色的资源与动作",
			user:      model.User{Username: groupUser},
			resource:  "pods",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: "dev",
			expected:  true,
		},
		{
			name:      "成员但动作不在角色内则拒绝",
			user:      model.User{Username: groupUser},
			resource:  "pods",
			verb:      string(common.VerbDelete),
			cluster:   "c1",
			namespace: "dev",
			expected:  false,
		},
		{
			name:      "非成员被拒绝",
			user:      model.User{Username: "eve"},
			resource:  "pods",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: "dev",
			expected:  false,
		},
		{
			name:      "归属组存在但无成员时拒绝",
			user:      model.User{Username: groupUser},
			resource:  "pods",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: "prod",
			expected:  false,
		},
		{
			name:      "通过用户组成员身份命中",
			user:      model.User{Username: "carol", OIDCGroups: []string{groupTeam}},
			resource:  "pods",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: "dev",
			expected:  true,
		},
		{
			name:      "跨集群隔离：同名命名空间不串集群",
			user:      model.User{Username: groupOther},
			resource:  "pods",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: "dev",
			expected:  false,
		},
		{
			name:      "目标集群内的成员正常放行",
			user:      model.User{Username: groupOther},
			resource:  "pods",
			verb:      string(common.VerbGet),
			cluster:   "c2",
			namespace: "dev",
			expected:  true,
		},
		{
			name:      "指名资源的授权不放行集群级资源（_all）",
			user:      model.User{Username: groupUser},
			resource:  "nodes",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: common.AllNamespaces,
			expected:  false,
		},
		{
			name:      "指名资源的授权在未指定命名空间时不放行",
			user:      model.User{Username: groupUser},
			resource:  "pods",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: "",
			expected:  false,
		},
		{
			name:      "资源通配授权放行集群级资源（_all）",
			user:      model.User{Username: groupWildcardUser},
			resource:  "nodes",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: common.AllNamespaces,
			cache:     wildcardCache,
			expected:  true,
		},
		{
			name:      "资源通配授权放行组外命名空间",
			user:      model.User{Username: groupWildcardUser},
			resource:  "pods",
			verb:      string(common.VerbGet),
			cluster:   "c1",
			namespace: "kube-system",
			cache:     wildcardCache,
			expected:  true,
		},
		{
			name:      "资源通配授权仍按动作收窄",
			user:      model.User{Username: groupWildcardUser},
			resource:  "pods",
			verb:      string(common.VerbDelete),
			cluster:   "c1",
			namespace: "dev",
			cache:     wildcardCache,
			expected:  false,
		},
		{
			name:      "资源通配授权不跨集群",
			user:      model.User{Username: groupWildcardUser},
			resource:  "nodes",
			verb:      string(common.VerbGet),
			cluster:   "c2",
			namespace: common.AllNamespaces,
			cache:     wildcardCache,
			expected:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cache := tc.cache
			if cache == nil {
				cache = newBindingGroupCache()
			}
			setupBindingGroupCache(t, cache)
			if got := CanAccess(tc.user, tc.resource, tc.verb, tc.cluster, tc.namespace); got != tc.expected {
				t.Fatalf("CanAccess(%s, %s, %s/%s) = %v, want %v",
					tc.resource, tc.verb, tc.cluster, tc.namespace, got, tc.expected)
			}
		})
	}
}

// 资源通配授权经权限绑定组下发到控制台时不能带命名空间列表：前端把空列表当「不约束」，
// 带了列表就会按组内命名空间把集群级资源与跨命名空间的入口重新隐藏，退化成
// 「后端放行、界面没有入口」。指名资源的角色照旧带上组内命名空间。
func TestNamespaceScopedBindingGroupRolesHandsOutWildcardGrantsUnscoped(t *testing.T) {
	cache := newBindingGroupCache()
	cache.namespaces = map[uint][]string{1: {"dev"}}
	cache.members[1] = append(cache.members[1], bindingGroupMemberEntry{
		subjectType: model.SubjectTypeUser,
		subject:     groupWildcardUser,
		role:        clusterReaderRole(),
	})
	setupBindingGroupCache(t, cache)

	roles := NamespaceScopedBindingGroupRoles(model.User{Username: groupWildcardUser})
	if len(roles) != 1 {
		t.Fatalf("NamespaceScopedBindingGroupRoles(dave) = %v, want one role", roles)
	}
	if len(roles[0].Namespaces) != 0 {
		t.Fatalf("expected a wildcard grant without a namespace list, got %v", roles[0].Namespaces)
	}
	if len(roles[0].Clusters) != 1 || roles[0].Clusters[0] != "c1" {
		t.Fatalf("expected the wildcard grant to stay inside its cluster, got %v", roles[0].Clusters)
	}

	roles = NamespaceScopedBindingGroupRoles(model.User{Username: groupUser})
	if len(roles) != 1 || len(roles[0].Namespaces) != 1 || roles[0].Namespaces[0] != "dev" {
		t.Fatalf("expected a named-resource grant to keep its namespace scope, got %v", roles)
	}
}

// 组内新增命名空间（含新建后加入）无需改动任何角色即自动生效。
func TestBindingGroupCoversNamespaceAddedLater(t *testing.T) {
	cache := newBindingGroupCache()
	setupBindingGroupCache(t, cache)

	user := model.User{Username: groupUser}
	if CanAccess(user, "pods", string(common.VerbGet), "c1", "brand-new") {
		t.Fatal("expected the new namespace to be unauthorized before it joins the group")
	}

	// 模拟命名空间创建后归属到组：缓存重新加载。
	cache.byNamespace["c1/brand-new"] = 1
	if !CanAccess(user, "pods", string(common.VerbGet), "c1", "brand-new") {
		t.Fatal("expected the namespace to be authorized once it joins the group")
	}
}

func TestCanAccessNamespaceViaBindingGroup(t *testing.T) {
	setupBindingGroupCache(t, newBindingGroupCache())
	user := model.User{Username: groupUser}

	cases := []struct {
		cluster   string
		namespace string
		expected  bool
	}{
		{"c1", "dev", true},
		{"c1", "prod", false},
		{"c2", "dev", false},
		{"c1", "other", false},
	}
	for _, tc := range cases {
		if got := CanAccessNamespace(user, tc.cluster, tc.namespace); got != tc.expected {
			t.Fatalf("CanAccessNamespace(%s, %s) = %v, want %v",
				tc.cluster, tc.namespace, got, tc.expected)
		}
	}
}

// 成员的角色绑定可以按命名空间收窄：范围为空覆盖组内全部命名空间，
// 范围非空只在该命名空间生效（新增成员只授权个别命名空间即基于此）。
func TestBindingGroupMemberNamespaceScope(t *testing.T) {
	setupBindingGroupCache(t, &bindingGroupCache{
		byNamespace: map[string]uint{"c1/dev": 1, "c1/prod": 1},
		projects:    map[uint]string{1: "c1"},
		globals:     map[uint]bool{},
		members: map[uint][]bindingGroupMemberEntry{
			1: {
				{subjectType: model.SubjectTypeUser, subject: groupUser, role: podReaderRole()},
				{subjectType: model.SubjectTypeUser, subject: groupOther, namespace: "prod", role: podReaderRole()},
			},
		},
	})

	scoped := model.User{Username: groupOther}
	if !CanAccess(scoped, "pods", string(common.VerbGet), "c1", "prod") {
		t.Fatal("expected a namespace-scoped member to be authorized inside its scope")
	}
	if CanAccess(scoped, "pods", string(common.VerbGet), "c1", "dev") {
		t.Fatal("expected a namespace-scoped member to be rejected outside its scope")
	}
	// 可见性同样跟随范围：只授权 prod 的成员不应看到组内其它命名空间。
	if !CanAccessNamespace(scoped, "c1", "prod") {
		t.Fatal("expected the namespace inside the scope to be visible")
	}
	if CanAccessNamespace(scoped, "c1", "dev") {
		t.Fatal("expected namespaces outside the scope to stay hidden")
	}
	// 跨命名空间列表门禁仍要放行，处理器再逐条按 CanAccess 过滤。
	if !HasResourcePermission(scoped, "pods", string(common.VerbGet), "c1") {
		t.Fatal("expected the list gate to stay open for a namespace-scoped member")
	}

	unscoped := model.User{Username: groupUser}
	for _, namespace := range []string{"dev", "prod"} {
		if !CanAccess(unscoped, "pods", string(common.VerbGet), "c1", namespace) {
			t.Fatalf("expected an unscoped binding to cover namespace %s of the group", namespace)
		}
	}
}

// 跨命名空间 LIST 的门禁同样认可权限绑定组，处理器随后逐条按 CanAccess 过滤。
func TestHasResourcePermissionViaBindingGroup(t *testing.T) {
	setupBindingGroupCache(t, newBindingGroupCache())

	user := model.User{Username: groupUser}
	if !HasResourcePermission(user, "pods", string(common.VerbGet), "c1") {
		t.Fatal("expected a binding group member to pass the cross-namespace list gate")
	}
	if HasResourcePermission(user, "pods", string(common.VerbGet), "c2") {
		t.Fatal("expected the list gate to stay closed in a cluster without a matching membership")
	}
	if HasResourcePermission(user, "pods", string(common.VerbDelete), "c1") {
		t.Fatal("expected the list gate to check the verb")
	}

	stranger := model.User{Username: "eve"}
	if HasResourcePermission(stranger, "pods", string(common.VerbGet), "c1") {
		t.Fatal("expected a non-member to be rejected")
	}
}

// 命名空间**列表**的门禁：只靠权限绑定组授权的用户必须有资格拿到列表
// （否则连命名空间选择器都用不了），真正的过滤交给列表 handler 逐条做。
func TestCanSeeNamespacesInCluster(t *testing.T) {
	cache := newBindingGroupCache()
	cache.globals = map[uint]bool{3: true}
	setupBindingGroupCache(t, cache)

	if !CanSeeNamespacesInCluster(model.User{Username: groupUser}, "c1") {
		t.Fatal("expected a binding group member to pass the namespace list gate")
	}
	if !CanSeeNamespacesInCluster(
		model.User{Username: "carol", OIDCGroups: []string{groupTeam}}, "c1",
	) {
		t.Fatal("expected a user-group member to pass the namespace list gate")
	}
	// 全局作用域的组：在任意集群都放行。
	if !CanSeeNamespacesInCluster(model.User{Username: groupOther}, "c1") {
		t.Fatal("expected a global-scope membership to pass the namespace list gate")
	}
	if CanSeeNamespacesInCluster(model.User{Username: "eve"}, "c1") {
		t.Fatal("expected a non-member to be rejected")
	}
}

func TestUserVisibleBindingGroups(t *testing.T) {
	setupBindingGroupCache(t, newBindingGroupCache())

	visible := UserVisibleBindingGroups(model.User{Username: groupUser})
	if len(visible) != 1 || visible[1] != "c1" {
		t.Fatalf("UserVisibleBindingGroups(alice) = %v, want map[1:c1]", visible)
	}
	visible = UserVisibleBindingGroups(model.User{Username: groupOther})
	if len(visible) != 1 || visible[3] != "c2" {
		t.Fatalf("UserVisibleBindingGroups(bob) = %v, want map[3:c2]", visible)
	}
}

// 锁定升级语义：数据库中带有显式命名空间列表的角色会保留该列表，
// 因此已有授权的范围不会变宽。变更之后创建的角色不携带命名空间列表，
// 并适用于其集群中的所有命名空间。
func TestNamespaceScopeCompatibility(t *testing.T) {
	legacy := common.Role{
		Name:       "legacy-ns-scoped",
		Clusters:   []string{"c1"},
		Namespaces: []string{"dev"},
		Resources:  []string{"pods"},
		Verbs:      []string{string(common.VerbGet)},
	}
	unscoped := common.Role{
		Name:      "new-style",
		Clusters:  []string{"c1"},
		Resources: []string{"pods"},
		Verbs:     []string{string(common.VerbGet)},
	}

	setupBindingGroupCache(t, &bindingGroupCache{
		byNamespace: map[string]uint{},
		projects:    map[uint]string{},
		members:     map[uint][]bindingGroupMemberEntry{},
	})
	RBACConfig = &common.RolesConfig{
		Roles: []common.Role{legacy, unscoped},
		RoleMapping: []common.RoleMapping{
			{Name: "legacy-ns-scoped", Users: []string{"carol"}},
			{Name: "new-style", Users: []string{"dave"}},
		},
	}

	carol := model.User{Username: "carol"}
	if !CanAccess(carol, "pods", string(common.VerbGet), "c1", "dev") {
		t.Fatal("expected the legacy role to keep working in its namespace")
	}
	if CanAccess(carol, "pods", string(common.VerbGet), "c1", "prod") {
		t.Fatal("expected the legacy namespace list to stay enforced")
	}

	dave := model.User{Username: "dave"}
	if !CanAccess(dave, "pods", string(common.VerbGet), "c1", "prod") {
		t.Fatal("expected a role without a namespace list to apply to every namespace")
	}
}
