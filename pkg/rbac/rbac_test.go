package rbac

import (
	"testing"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

func TestCanAccess(t *testing.T) {
	originalConfig := RBACConfig
	t.Cleanup(func() {
		RBACConfig = originalConfig
	})

	// 定义测试用的角色
	adminRole := common.Role{
		Name:        "admin",
		Description: "Administrator with full access",
		Clusters:    []string{"*"},
		Resources:   []string{"*"},
		Namespaces:  []string{"*"},
		Verbs:       []string{"*"},
	}

	viewerRole := common.Role{
		Name:        "viewer",
		Description: "Read-only access to all resources",
		Clusters:    []string{"*"},
		Resources:   []string{"*"},
		Namespaces:  []string{"*"},
		Verbs:       []string{"get"},
	}

	devRole := common.Role{
		Name:        "developer",
		Description: "Developer access to specific resources",
		Clusters:    []string{"dev-cluster"},
		Resources:   []string{"pods", "deployments"},
		Namespaces:  []string{"dev", "test"},
		Verbs:       []string{"get", "create", "update", "delete"},
	}

	regexpDevRole := common.Role{
		Name:        "developer-regexp",
		Description: "Developer access to specific resources by regexp",
		Clusters:    []string{"dev.*"},
		Resources:   []string{"pods", "deployments"},
		Namespaces:  []string{"dev.*", "test.*"},
		Verbs:       []string{"get", "create", "update", "delete"},
	}

	prodViewRole := common.Role{
		Name:        "prod-viewer",
		Description: "Read-only access to production",
		Clusters:    []string{"prod-cluster"},
		Resources:   []string{"pods", "services"},
		Namespaces:  []string{"prod"},
		Verbs:       []string{"get"},
	}

	notKubeSystemRole := common.Role{
		Name:        "not-kube-system",
		Description: "Access to all namespaces except kube-system",
		Clusters:    []string{"*"},
		Resources:   []string{"*"},
		Namespaces:  []string{"!kube-system", "*"},
		Verbs:       []string{"*"},
	}

	tests := []struct {
		name       string
		roles      []common.Role
		mappings   []common.RoleMapping
		user       string
		oidcGroups []string
		resource   string
		verb       string
		cluster    string
		namespace  string
		expected   bool
	}{
		{
			name:  "user with no permissions",
			roles: []common.Role{adminRole, viewerRole},
			mappings: []common.RoleMapping{
				{Name: "admin", Users: []string{"admin-user"}},
				{Name: "viewer", Users: []string{"viewer-user"}},
			},
			user:       "unprivileged-user",
			oidcGroups: []string{},
			resource:   "pods",
			verb:       "get",
			cluster:    "dev-cluster",
			namespace:  "default",
			expected:   false,
		},
		{
			name:  "admin user can access anything",
			roles: []common.Role{adminRole},
			mappings: []common.RoleMapping{
				{Name: "admin", Users: []string{"admin-user"}},
			},
			user:       "admin-user",
			oidcGroups: []string{},
			resource:   "any-resource",
			verb:       "any-verb",
			cluster:    "any-cluster",
			namespace:  "any-namespace",
			expected:   true,
		},
		{
			name:  "viewer can only read",
			roles: []common.Role{viewerRole},
			mappings: []common.RoleMapping{
				{Name: "viewer", Users: []string{"viewer-user"}},
			},
			user:       "viewer-user",
			oidcGroups: []string{},
			resource:   "pods",
			verb:       "get",
			cluster:    "any-cluster",
			namespace:  "any-namespace",
			expected:   true,
		},
		{
			name:  "viewer cannot write",
			roles: []common.Role{viewerRole},
			mappings: []common.RoleMapping{
				{Name: "viewer", Users: []string{"viewer-user"}},
			},
			user:       "viewer-user",
			oidcGroups: []string{},
			resource:   "pods",
			verb:       "create",
			cluster:    "any-cluster",
			namespace:  "any-namespace",
			expected:   false,
		},
		{
			name:  "developer in correct cluster/namespace/resource",
			roles: []common.Role{devRole},
			mappings: []common.RoleMapping{
				{Name: "developer", Users: []string{"dev-user"}},
			},
			user:       "dev-user",
			oidcGroups: []string{},
			resource:   "deployments",
			verb:       "update",
			cluster:    "dev-cluster",
			namespace:  "dev",
			expected:   true,
		},
		{
			name:  "developer in wrong cluster",
			roles: []common.Role{devRole},
			mappings: []common.RoleMapping{
				{Name: "developer", Users: []string{"dev-user"}},
			},
			user:       "dev-user",
			oidcGroups: []string{},
			resource:   "deployments",
			verb:       "update",
			cluster:    "prod-cluster",
			namespace:  "dev",
			expected:   false,
		},
		{
			name:  "developer in correct cluster/namespace/resource by regexp",
			roles: []common.Role{regexpDevRole},
			mappings: []common.RoleMapping{
				{Name: "developer-regexp", Users: []string{"dev-user"}},
			},
			user:       "dev-user",
			oidcGroups: []string{},
			resource:   "deployments",
			verb:       "update",
			cluster:    "dev-cluster",
			namespace:  "dev",
			expected:   true,
		},
		{
			name:  "developer in wrong cluster by regexp",
			roles: []common.Role{regexpDevRole},
			mappings: []common.RoleMapping{
				{Name: "developer-regexp", Users: []string{"dev-user"}},
			},
			user:       "dev-user",
			oidcGroups: []string{},
			resource:   "deployments",
			verb:       "update",
			cluster:    "prod-cluster",
			namespace:  "dev",
			expected:   false,
		},
		{
			name:  "user with multiple roles",
			roles: []common.Role{devRole, prodViewRole},
			mappings: []common.RoleMapping{
				{Name: "developer", Users: []string{"multi-role-user"}},
				{Name: "prod-viewer", Users: []string{"multi-role-user"}},
			},
			user:       "multi-role-user",
			oidcGroups: []string{},
			resource:   "pods",
			verb:       "get",
			cluster:    "prod-cluster",
			namespace:  "prod",
			expected:   true,
		},
		{
			name: "permission dimensions are not combined across roles",
			roles: []common.Role{
				{
					Name:       "wrong-resource",
					Clusters:   []string{"prod-cluster"},
					Resources:  []string{"deployments"},
					Namespaces: []string{"prod"},
					Verbs:      []string{"get"},
				},
				{
					Name:       "wrong-scope",
					Clusters:   []string{"dev-cluster"},
					Resources:  []string{"pods"},
					Namespaces: []string{"dev"},
					Verbs:      []string{"update"},
				},
			},
			mappings: []common.RoleMapping{
				{Name: "wrong-resource", Users: []string{"split-role-user"}},
				{Name: "wrong-scope", Users: []string{"split-role-user"}},
			},
			user:      "split-role-user",
			resource:  "pods",
			verb:      "get",
			cluster:   "prod-cluster",
			namespace: "prod",
			expected:  false,
		},
		{
			name:  "user with OIDC group permissions",
			roles: []common.Role{viewerRole},
			mappings: []common.RoleMapping{
				{Name: "viewer", OIDCGroups: []string{"viewers-group"}},
			},
			user:       "group-member",
			oidcGroups: []string{"viewers-group"},
			resource:   "pods",
			verb:       "get",
			cluster:    "any-cluster",
			namespace:  "any-namespace",
			expected:   true,
		},
		{
			name:  "wildcard in user list",
			roles: []common.Role{viewerRole},
			mappings: []common.RoleMapping{
				{Name: "viewer", Users: []string{"*"}},
			},
			user:       "any-user",
			oidcGroups: []string{},
			resource:   "pods",
			verb:       "get",
			cluster:    "any-cluster",
			namespace:  "any-namespace",
			expected:   true,
		},
		{
			name:  "allow all-namespace but not kube-system: access",
			roles: []common.Role{notKubeSystemRole},
			mappings: []common.RoleMapping{
				{Name: "not-kube-system", Users: []string{"*"}},
			},
			user:       "any-user",
			oidcGroups: []string{},
			resource:   "pods",
			verb:       "get",
			cluster:    "any-cluster",
			namespace:  "any-namespace",
			expected:   true,
		},
		{
			// 存量兼容：显式配置 namespaces（含反选）的角色仍受其约束；
			// 新建角色不再提供该字段，范围由权限绑定组圈定。
			name:  "allow all-namespace but not kube-system: not access",
			roles: []common.Role{notKubeSystemRole},
			mappings: []common.RoleMapping{
				{Name: "not-kube-system", Users: []string{"*"}},
			},
			user:       "any-user",
			oidcGroups: []string{},
			resource:   "pods",
			verb:       "get",
			cluster:    "any-cluster",
			namespace:  "kube-system",
			expected:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			RBACConfig = &common.RolesConfig{
				Roles:       tc.roles,
				RoleMapping: tc.mappings,
			}
			result := CanAccess(model.User{Username: tc.user, OIDCGroups: tc.oidcGroups}, tc.resource, tc.verb, tc.cluster, tc.namespace)

			if result != tc.expected {
				t.Errorf("Expected CanAccess to return %v but got %v", tc.expected, result)
			}
		})
	}
}

// TestHasResourcePermission 覆盖 RBAC 中间件用来判断跨命名空间 LIST 是否放行的
// 那个与命名空间无关的关卡。
// 当用户在集群中持有任何授予该资源该 verb 的角色时它必须为 true
// （与命名空间无关），否则为 false。
func TestHasResourcePermission(t *testing.T) {
	originalConfig := RBACConfig
	t.Cleanup(func() {
		RBACConfig = originalConfig
	})

	// 复现 issue #610 的场景：两个限定命名空间范围的角色，
	// 各自只授予单个命名空间。两个角色都不带 "_all" / "*"。
	facilitiesRole := common.Role{
		Name: "facilities", Clusters: []string{"*"},
		Resources: []string{"deployments"}, Namespaces: []string{"charon-facilities-qd"},
		Verbs: []string{"get"},
	}
	sluiceRole := common.Role{
		Name: "sluice", Clusters: []string{"*"},
		Resources: []string{"deployments"}, Namespaces: []string{"charon-sluice"},
		Verbs: []string{"get"},
	}
	// 一个授予 deployments 的 create/update、但不授予 get 的角色。
	writerRole := common.Role{
		Name: "writer", Clusters: []string{"*"},
		Resources: []string{"deployments"}, Namespaces: []string{"team-a"},
		Verbs: []string{"create", "update"},
	}

	tests := []struct {
		name     string
		roles    []common.Role
		mappings []common.RoleMapping
		user     string
		resource string
		verb     string
		cluster  string
		expected bool
	}{
		{
			name:  "issue #610: multi-namespace user has get permission on deployments",
			roles: []common.Role{facilitiesRole, sluiceRole},
			mappings: []common.RoleMapping{
				{Name: "facilities", Users: []string{"xuke"}},
				{Name: "sluice", Users: []string{"xuke"}},
			},
			user: "xuke", resource: "deployments", verb: "get", cluster: "any-cluster",
			expected: true,
		},
		{
			name:     "writer without get verb has no get permission",
			roles:    []common.Role{writerRole},
			mappings: []common.RoleMapping{{Name: "writer", Users: []string{"dev"}}},
			user:     "dev", resource: "deployments", verb: "get", cluster: "any-cluster",
			expected: false,
		},
		{
			name:     "writer has update permission (namespace-agnostic)",
			roles:    []common.Role{writerRole},
			mappings: []common.RoleMapping{{Name: "writer", Users: []string{"dev"}}},
			user:     "dev", resource: "deployments", verb: "update", cluster: "any-cluster",
			expected: true,
		},
		{
			name:     "wrong resource: no permission",
			roles:    []common.Role{facilitiesRole},
			mappings: []common.RoleMapping{{Name: "facilities", Users: []string{"xuke"}}},
			user:     "xuke", resource: "pods", verb: "get", cluster: "any-cluster",
			expected: false,
		},
		{
			name:     "wrong cluster: no permission",
			roles:    []common.Role{{Name: "prod-reader", Clusters: []string{"prod"}, Resources: []string{"deployments"}, Verbs: []string{"get"}}},
			mappings: []common.RoleMapping{{Name: "prod-reader", Users: []string{"dev"}}},
			user:     "dev", resource: "deployments", verb: "get", cluster: "dev",
			expected: false,
		},
		{
			name: "permission dimensions are not combined across roles",
			roles: []common.Role{
				{Name: "prod-deployment-reader", Clusters: []string{"prod"}, Resources: []string{"deployments"}, Verbs: []string{"get"}},
				{Name: "dev-pod-reader", Clusters: []string{"dev"}, Resources: []string{"pods"}, Verbs: []string{"get"}},
			},
			mappings: []common.RoleMapping{
				{Name: "prod-deployment-reader", Users: []string{"dev"}},
				{Name: "dev-pod-reader", Users: []string{"dev"}},
			},
			user: "dev", resource: "pods", verb: "get", cluster: "prod",
			expected: false,
		},
		{
			name:     "no roles at all",
			roles:    []common.Role{facilitiesRole},
			mappings: []common.RoleMapping{{Name: "facilities", Users: []string{"xuke"}}},
			user:     "stranger", resource: "deployments", verb: "get", cluster: "any-cluster",
			expected: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			RBACConfig = &common.RolesConfig{
				Roles:       tc.roles,
				RoleMapping: tc.mappings,
			}
			got := HasResourcePermission(model.User{Username: tc.user}, tc.resource, tc.verb, tc.cluster)
			if got != tc.expected {
				t.Errorf("HasResourcePermission = %v, want %v", got, tc.expected)
			}
		})
	}
}

// TestClusterScopedWildcardRequiresExplicitGrant 锁定这样一条规则：
// 限定命名空间的角色不能通过通配资源授权触及集群级资源。
// "命名空间 dev 中的所有资源" 不得授予对集群中每一个 node 的
// 读（或写）权限。
func TestNamespaceRestricted(t *testing.T) {
	tests := []struct {
		name       string
		namespaces []string
		expected   bool
	}{
		{"empty list is not restricted", nil, false},
		{"wildcard is not restricted", []string{"*"}, false},
		{"internal all-namespaces marker is not restricted", []string{common.AllNamespaces}, false},
		{"negation plus wildcard is not restricted", []string{"!kube-system", "*"}, false},
		{"a single namespace is restricted", []string{"dev"}, true},
		{"several namespaces are restricted", []string{"dev", "test"}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := namespaceRestricted(tc.namespaces); got != tc.expected {
				t.Errorf("namespaceRestricted(%v) = %v, want %v", tc.namespaces, got, tc.expected)
			}
		})
	}
}

func TestMatchExplicit(t *testing.T) {
	tests := []struct {
		name     string
		list     []string
		val      string
		expected bool
	}{
		{"wildcard alone does not match", []string{"*"}, "nodes", false},
		{"explicit entry matches", []string{"nodes"}, "nodes", true},
		{"explicit entry mixed with wildcard matches", []string{"*", "nodes"}, "nodes", true},
		{"unrelated entries do not match", []string{"*", "pods"}, "nodes", false},
		{"negation still wins", []string{"*", "!nodes"}, "nodes", false},
		{"no wildcard keeps plain matching", []string{"nodes"}, "nodes", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchExplicit(tc.list, tc.val); got != tc.expected {
				t.Errorf("matchExplicit(%v, %s) = %v, want %v", tc.list, tc.val, got, tc.expected)
			}
		})
	}
}

func TestClusterScopedWildcardRequiresExplicitGrant(t *testing.T) {
	// 角色不再有命名空间范围后，旧的"ns 限定角色的通配符不能扩大到集群级
	// 资源"防护随之消失：角色规则对所有命名空间与集群级资源一致生效。
	// 命名空间级别的限制改由权限绑定组承担，绑定组的授权范围按角色里的
	// 规则形态区分：
	//   - 资源通配 * 的授权（k8s:*:get 等）写的是"集群里的一切资源"，范围是
	//     整个集群，集群级资源与 _all 请求一并放行；
	//   - 指名资源的授权（例如只给 pods）只在组内命名空间生效，不放行集群级资源。
	originalConfig := RBACConfig
	originalProjects := bindingGroupsCache
	t.Cleanup(func() {
		RBACConfig = originalConfig
		bindingGroupsCache = originalProjects
	})

	wildcardRole := common.Role{
		Name:      "wildcard",
		Clusters:  []string{"*"},
		Resources: []string{"*"},
		Verbs:     []string{"*"},
	}
	RBACConfig = &common.RolesConfig{
		Roles:       []common.Role{wildcardRole},
		RoleMapping: []common.RoleMapping{{Name: "wildcard", Users: []string{"*"}}},
	}
	user := model.User{Username: "any-user"}

	cases := []struct {
		name      string
		resource  string
		verb      string
		namespace string
		expected  bool
	}{
		{"wildcard grants node reads", "nodes", "get", common.AllNamespaces, true},
		{"wildcard grants node writes", "nodes", "delete", common.AllNamespaces, true},
		{"wildcard grants pv reads", "persistentvolumes", "get", common.AllNamespaces, true},
		{"wildcard grants namespaced pods", "pods", "get", "dev", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bindingGroupsCache = &bindingGroupCache{
				byNamespace: map[string]uint{},
				projects:    map[uint]string{},
				members:     map[uint][]bindingGroupMemberEntry{},
			}
			if got := CanAccess(user, tc.resource, tc.verb, "any-cluster", tc.namespace); got != tc.expected {
				t.Fatalf("CanAccess(%s, %s, ns=%s) = %v, want %v", tc.resource, tc.verb, tc.namespace, got, tc.expected)
			}
		})
	}

	// 权限绑定组路径：资源通配授权覆盖整个集群，指名资源的授权仍只覆盖组内命名空间。
	t.Run("binding group follows the shape of the granted rule", func(t *testing.T) {
		namedRole := common.Role{
			Name:      "pod-reader",
			Clusters:  []string{"*"},
			Resources: []string{"pods"},
			Verbs:     []string{"get"},
		}
		RBACConfig = &common.RolesConfig{Roles: []common.Role{}, RoleMapping: []common.RoleMapping{}}
		bindingGroupsCache = &bindingGroupCache{
			byNamespace: map[string]uint{"c1/dev": 1},
			projects:    map[uint]string{1: "c1"},
			members: map[uint][]bindingGroupMemberEntry{
				1: {
					{subjectType: "user", subject: "any-user", role: wildcardRole},
					{subjectType: "user", subject: "named-user", role: namedRole},
				},
			},
		}
		if got := canAccessViaBindingGroup(user, "pods", "get", "c1", "dev"); !got {
			t.Fatal("expected binding group to grant namespaced pod reads")
		}
		if got := canAccessViaBindingGroup(user, "nodes", "get", "c1", common.AllNamespaces); !got {
			t.Fatal("expected a wildcard grant to reach cluster-scoped resources")
		}
		if got := canAccessViaBindingGroup(user, "pods", "get", "c1", "other"); !got {
			t.Fatal("expected a wildcard grant to reach namespaces outside the group")
		}
		if got := canAccessViaBindingGroup(user, "nodes", "get", "c2", common.AllNamespaces); got {
			t.Fatal("expected a wildcard grant to stay inside its cluster")
		}
		named := model.User{Username: "named-user"}
		if got := canAccessViaBindingGroup(named, "pods", "get", "c1", "dev"); !got {
			t.Fatal("expected a named-resource grant to work inside the group")
		}
		if got := canAccessViaBindingGroup(named, "nodes", "get", "c1", common.AllNamespaces); got {
			t.Fatal("expected a named-resource grant to never grant cluster-scoped resources")
		}
		// 命名空间可见性要跟着同样的范围走：否则后端放行、选择器里却看不到该命名空间。
		if got := CanAccessNamespace(user, "c1", "other"); !got {
			t.Fatal("expected a wildcard grant to reveal every namespace of its cluster")
		}
		if got := CanAccessNamespace(named, "c1", "other"); got {
			t.Fatal("expected a named-resource grant to keep the namespace list scoped")
		}
		if got := canAccessNamespaceViaBindingGroup(named, "c1", "other"); got {
			t.Fatal("expected a namespace outside the group to stay hidden from a named-resource grant")
		}
		if got := canAccessNamespaceViaBindingGroup(user, "c1", "dev"); !got {
			t.Fatal("expected member to see binding group namespace")
		}
	})
}
