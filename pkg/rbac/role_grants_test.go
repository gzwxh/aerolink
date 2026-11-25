package rbac

import (
	"testing"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
)

// 新版角色按资源保存操作集合：同一个角色里不同资源可以拥有不同操作，
// 不会再出现「给节点开了终端，Pod 也一起有了 exec」的连带。
func TestRoleAllowsPerResourceGrants(t *testing.T) {
	role := common.Role{
		Name: "split-grants",
		Grants: []common.ResourceGrant{
			{Resource: "nodes", Verbs: []string{"get", "exec"}},
			{Resource: "pods", Verbs: []string{"get"}},
		},
	}

	cases := []struct {
		resource string
		verb     string
		expected bool
	}{
		{"nodes", "get", true},
		{"nodes", "exec", true},
		{"nodes", "delete", false},
		{"pods", "get", true},
		// 关键回归：pods 没有 exec，不能因为 nodes 有就放行。
		{"pods", "exec", false},
		// 未授权的资源一律拒绝。
		{"secrets", "get", false},
	}

	for _, tc := range cases {
		if got := roleAllows(role, tc.resource, tc.verb); got != tc.expected {
			t.Fatalf("roleAllows(%s, %s) = %v, want %v", tc.resource, tc.verb, got, tc.expected)
		}
	}
}

// 存量角色（没有 grants）继续按「资源 × 操作」的笛卡尔积判定，升级后行为不变。
func TestRoleAllowsLegacyCrossProduct(t *testing.T) {
	role := common.Role{
		Name:      "legacy",
		Resources: []string{"pods", "nodes"},
		Verbs:     []string{"get", "exec"},
	}

	for _, resource := range []string{"pods", "nodes"} {
		for _, verb := range []string{"get", "exec"} {
			if !roleAllows(role, resource, verb) {
				t.Fatalf("legacy role should allow %s/%s", resource, verb)
			}
		}
		if roleAllows(role, "secrets", "get") {
			t.Fatal("legacy role must not allow resources outside its list")
		}
	}
}

// 通配授权在 grants 形式下同样生效（* 资源 / * 操作）。
func TestRoleAllowsWildcardGrants(t *testing.T) {
	role := common.Role{
		Name:   "wildcard",
		Grants: []common.ResourceGrant{{Resource: "*", Verbs: []string{"get"}}},
	}
	if !roleAllows(role, "secrets", "get") {
		t.Fatal("wildcard resource grant should cover any resource")
	}
	if roleAllows(role, "secrets", "delete") {
		t.Fatal("wildcard resource grant must still check the verb")
	}
}

// 系统设置权限拆成「查看（get）」与「管理（update）」：只看设置的角色
// 能通过读取校验，但不能通过管理校验。
func TestCanViewSystemSettingsSplit(t *testing.T) {
	viewer := common.Role{
		Name:   "settings-viewer",
		Grants: []common.ResourceGrant{{Resource: common.SystemSettingsResource, Verbs: []string{"get"}}},
	}
	manager := common.Role{
		Name:   "settings-manager",
		Grants: []common.ResourceGrant{{Resource: common.SystemSettingsResource, Verbs: []string{"get", "update"}}},
	}

	original := RBACConfig
	t.Cleanup(func() { RBACConfig = original })

	check := func(role common.Role) (view, manage bool) {
		user := model.User{
			Username: "alice",
			Roles:    []common.Role{role},
		}
		return CanViewSystemSettings(user),
			CanManageSystemSettings(user, string(common.SystemSettingsVerb))
	}

	if view, manage := check(viewer); !view || manage {
		t.Fatalf("settings viewer: view=%v manage=%v, want view only", view, manage)
	}
	if view, manage := check(manager); !view || !manage {
		t.Fatalf("settings manager: view=%v manage=%v, want both", view, manage)
	}
}
