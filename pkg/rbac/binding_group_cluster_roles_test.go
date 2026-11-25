package rbac

import (
	"testing"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
)

// clusterRolesBindingGroupCache 模拟「按集群授出内置集群角色」的部署形态：
// 一个挂在 prod 集群上的普通权限绑定组，alice 拿到集群管理员、bob 拿到集群
// 只读管理员。组没有绑定任何命名空间——资源通配角色的集群级判定不依赖它。
func clusterRolesBindingGroupCache() *bindingGroupCache {
	return &bindingGroupCache{
		byNamespace: map[string]uint{},
		projects:    map[uint]string{10: "prod"},
		globals:     map[uint]bool{10: false},
		members: map[uint][]bindingGroupMemberEntry{
			10: {
				{subjectType: model.SubjectTypeUser, subject: groupUser, role: commonRole(model.DefaultClusterAdminRole)},
				{subjectType: model.SubjectTypeUser, subject: groupOther, role: commonRole(model.DefaultClusterViewerRole)},
			},
		},
	}
}

// 集群角色（cluster-admin / cluster-viewer）的生效范围必须是「被授权的那个集群」，
// 而不是所有 K8s 集群。描述文案与代码行为必须一致。
func TestClusterRolesAreScopedToTheGrantedCluster(t *testing.T) {
	setupBindingGroupCache(t, clusterRolesBindingGroupCache())

	alice := model.User{Username: groupUser}
	bob := model.User{Username: groupOther}

	// —— 集群管理员：prod 集群全域全权 ——
	// 组内绑定过的命名空间。
	if !CanAccess(alice, "pods", string(common.VerbGet), "prod", "app") {
		t.Fatal("cluster-admin must access pods in the granted cluster")
	}
	// 没绑定过的命名空间与删除动作：裸 * 规则覆盖整个集群。
	if !CanAccess(alice, "pods", string(common.VerbDelete), "prod", "kube-system") {
		t.Fatal("cluster-admin must cover every namespace of the granted cluster")
	}
	// 集群级资源（namespace 为空的 _all 请求）。
	if !CanAccess(alice, "nodes", string(common.VerbGet), "prod", "") {
		t.Fatal("cluster-admin must cover cluster-scoped resources")
	}
	// 集群管理员含 secrets。
	if !CanAccess(alice, "secrets", string(common.VerbGet), "prod", "app") {
		t.Fatal("cluster-admin must manage secrets in the granted cluster")
	}

	// —— 换一个集群立即失效：角色授权只在授出的集群内生效 ——
	if CanAccess(alice, "pods", string(common.VerbGet), "dev", "app") {
		t.Fatal("cluster-admin must not leak into another cluster")
	}

	// —— 集群管理员不含控制台设置 ——
	if CanAccess(alice, common.SystemSettingsResource, string(common.VerbGet), "prod", "") {
		t.Fatal("cluster-admin must not access console settings")
	}

	// —— 集群只读管理员：只读、排除 secrets、同样只在 prod 生效 ——
	if !CanAccess(bob, "pods", string(common.VerbGet), "prod", "app") {
		t.Fatal("cluster-viewer must read pods in the granted cluster")
	}
	if !CanAccess(bob, "pods", string(common.VerbLog), "prod", "other") {
		t.Fatal("cluster-viewer must read pod logs in the granted cluster")
	}
	if CanAccess(bob, "secrets", string(common.VerbGet), "prod", "app") {
		t.Fatal("cluster-viewer must not read secrets")
	}
	if CanAccess(bob, "pods", string(common.VerbDelete), "prod", "app") {
		t.Fatal("cluster-viewer must not delete resources")
	}
	if CanAccess(bob, "pods", string(common.VerbGet), "dev", "app") {
		t.Fatal("cluster-viewer must not leak into another cluster")
	}

	// —— 命名空间可见性跟随同一集群边界 ——
	if !canAccessNamespaceViaBindingGroup(bob, "prod", "kube-system") {
		t.Fatal("cluster-viewer must see every namespace of the granted cluster")
	}
	if canAccessNamespaceViaBindingGroup(bob, "dev", "app") {
		t.Fatal("cluster-viewer must not see namespaces of another cluster")
	}
}
