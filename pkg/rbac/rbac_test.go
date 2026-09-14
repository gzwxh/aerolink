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

	// Define test roles
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

// TestHasResourcePermission covers the namespace-agnostic gate used by the
// RBAC middleware to decide whether a cross-namespace LIST may pass through.
// It must be true when the user holds any role granting the verb on the
// resource in the cluster (namespace irrelevant), and false otherwise.
func TestHasResourcePermission(t *testing.T) {
	originalConfig := RBACConfig
	t.Cleanup(func() {
		RBACConfig = originalConfig
	})

	// Mirrors the issue #610 scenario: two namespace-scoped roles, each
	// granting a single namespace. Neither role carries "_all" / "*".
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
	// A role that grants create/update but not get on deployments.
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

// TestClusterScopedWildcardRequiresExplicitGrant locks in the rule that a
// namespace-restricted role cannot reach cluster-scoped resources through a
// wildcard resource grant. "All resources in namespace dev" must not grant
// read (or write) access to every node in the cluster.
func TestClusterScopedWildcardRequiresExplicitGrant(t *testing.T) {
	originalConfig := RBACConfig
	t.Cleanup(func() {
		RBACConfig = originalConfig
	})

	namespaceScopedWildcard := common.Role{
		Name:       "ns-scoped-wildcard",
		Clusters:   []string{"*"},
		Namespaces: []string{"dev"},
		Resources:  []string{"*"},
		Verbs:      []string{"*"},
	}
	namespaceScopedExplicitNodes := common.Role{
		Name:       "ns-scoped-explicit-nodes",
		Clusters:   []string{"*"},
		Namespaces: []string{"dev"},
		Resources:  []string{"nodes"},
		Verbs:      []string{"get"},
	}
	clusterWideWildcard := common.Role{
		Name:       "cluster-wide-wildcard",
		Clusters:   []string{"*"},
		Namespaces: []string{"*"},
		Resources:  []string{"*"},
		Verbs:      []string{"get"},
	}
	allButKubeSystem := common.Role{
		Name:       "all-but-kube-system",
		Clusters:   []string{"*"},
		Namespaces: []string{"!kube-system", "*"},
		Resources:  []string{"*"},
		Verbs:      []string{"get"},
	}

	tests := []struct {
		name      string
		role      common.Role
		resource  string
		verb      string
		namespace string
		expected  bool
	}{
		{
			name: "wildcard does not grant node reads to a namespace-scoped role",
			role: namespaceScopedWildcard, resource: "nodes", verb: "get",
			namespace: common.AllNamespaces, expected: false,
		},
		{
			name: "wildcard does not grant node writes to a namespace-scoped role",
			role: namespaceScopedWildcard, resource: "nodes", verb: "delete",
			namespace: common.AllNamespaces, expected: false,
		},
		{
			name: "wildcard does not grant other cluster-scoped resources either",
			role: namespaceScopedWildcard, resource: "persistentvolumes", verb: "get",
			namespace: common.AllNamespaces, expected: false,
		},
		{
			name: "wildcard still grants namespaced resources in the granted namespace",
			role: namespaceScopedWildcard, resource: "pods", verb: "get",
			namespace: "dev", expected: true,
		},
		{
			name: "explicit cluster-scoped grant still works for a namespace-scoped role",
			role: namespaceScopedExplicitNodes, resource: "nodes", verb: "get",
			namespace: common.AllNamespaces, expected: true,
		},
		{
			name: "explicit grant is still limited to the granted verbs",
			role: namespaceScopedExplicitNodes, resource: "nodes", verb: "delete",
			namespace: common.AllNamespaces, expected: false,
		},
		{
			name: "cluster-wide roles keep wildcard access to cluster-scoped resources",
			role: clusterWideWildcard, resource: "nodes", verb: "get",
			namespace: common.AllNamespaces, expected: true,
		},
		{
			name: "a namespace list carrying the wildcard is not restricted",
			role: allButKubeSystem, resource: "nodes", verb: "get",
			namespace: common.AllNamespaces, expected: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			RBACConfig = &common.RolesConfig{
				Roles:       []common.Role{tc.role},
				RoleMapping: []common.RoleMapping{{Name: tc.role.Name, Users: []string{"tester"}}},
			}
			got := CanAccess(model.User{Username: "tester"}, tc.resource, tc.verb, "cluster-a", tc.namespace)
			if got != tc.expected {
				t.Errorf("CanAccess(%s, %s, ns=%s) = %v, want %v",
					tc.resource, tc.verb, tc.namespace, got, tc.expected)
			}
		})
	}
}

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
