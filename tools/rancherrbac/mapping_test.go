package main

import (
	"sort"
	"strings"
	"testing"

	"github.com/zxh326/kite/pkg/common"
)

func grantSet(grants []common.ResourceGrant) map[string][]string {
	out := make(map[string][]string, len(grants))
	for _, grant := range grants {
		verbs := append([]string(nil), grant.Verbs...)
		sort.Strings(verbs)
		out[grant.Resource] = verbs
	}
	return out
}

func verbsOf(t *testing.T, grants []common.ResourceGrant, resource string) []string {
	t.Helper()
	for _, grant := range grants {
		if grant.Resource == resource {
			verbs := append([]string(nil), grant.Verbs...)
			sort.Strings(verbs)
			return verbs
		}
	}
	return nil
}

// 项目上下文的资源通配必须展开：鸢联 AeroLink 权限绑定组里 `*` 的语义是「整个集群的一切资源」，
// 照搬会项目级只读放大成集群级只读（越权）。
func TestMapRoleTemplateExpandsProjectWildcard(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "project-owner",
		Context: "project",
		Rules: []rancherRule{{
			APIGroups: []string{"*"},
			Resources: []string{"*"},
			Verbs:     []string{"*"},
		}},
	}, "project", mappingOptions{})

	grants := grantSet(mapping.Grants)
	if _, ok := grants["*"]; ok {
		t.Fatalf("项目上下文的角色不应出现资源通配 *：%v", mapping.Grants)
	}
	for _, resource := range []string{"pods", "deployments", "configmaps", "services"} {
		if _, ok := grants[resource]; !ok {
			t.Fatalf("缺少命名空间级资源 %s：%v", resource, mapping.Grants)
		}
	}
	for _, clusterScoped := range []string{"nodes", "namespaces", "persistentvolumes", "customresourcedefinitions"} {
		if _, ok := grants[clusterScoped]; ok {
			t.Fatalf("集群级资源 %s 不应该出现在绑定组角色里：%v", clusterScoped, mapping.Grants)
		}
	}
	podVerbs := grants["pods"]
	for _, verb := range []string{"get", "create", "update", "delete", "log", "exec", "view-file", "download-file", "upload-file"} {
		if !containsString(podVerbs, verb) {
			t.Fatalf("pods 缺少操作 %s：%v", verb, podVerbs)
		}
	}
	if len(grants["deployments"]) != 4 {
		t.Fatalf("非 Pod 资源只应有 get/create/update/delete：%v", grants["deployments"])
	}
}

// 集群上下文的资源通配保持原样：那本来就是集群级授权。
func TestMapRoleTemplateKeepsClusterWildcard(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "cluster-owner",
		Context: "cluster",
		Rules: []rancherRule{{
			APIGroups: []string{"*"},
			Resources: []string{"*"},
			Verbs:     []string{"*"},
		}},
	}, "cluster", mappingOptions{})

	grants := grantSet(mapping.Grants)
	verbs, ok := grants["*"]
	if !ok {
		t.Fatalf("集群上下文应保留资源通配 *：%v", mapping.Grants)
	}
	for _, verb := range []string{"get", "create", "update", "delete", "log", "exec"} {
		if !containsString(verbs, verb) {
			t.Fatalf("* 缺少操作 %s：%v", verb, verbs)
		}
	}
}

func TestMapRoleTemplateMapsVerbs(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "project-view",
		Context: "project",
		Rules: []rancherRule{{
			APIGroups: []string{""},
			Resources: []string{"configmaps"},
			Verbs:     []string{"get", "list", "watch", "patch", "deletecollection"},
		}},
	}, "project", mappingOptions{})

	verbs := verbsOf(t, mapping.Grants, "configmaps")
	want := []string{"delete", "get", "update"}
	if strings.Join(verbs, ",") != strings.Join(want, ",") {
		t.Fatalf("configmaps 操作 = %v，期望 %v", verbs, want)
	}
}

// 只读授权补容器日志：鸢联 AeroLink 的内置只读管理员也是 get + log。
func TestMapRoleTemplateReadOnlyAddsPodLogs(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "project-view",
		Context: "project",
		Rules: []rancherRule{
			{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get"}},
			{APIGroups: []string{""}, Resources: []string{"pods/log"}, Verbs: []string{"get"}},
			{APIGroups: []string{""}, Resources: []string{"pods/exec"}, Verbs: []string{"create"}},
			{APIGroups: []string{""}, Resources: []string{"pods/status"}, Verbs: []string{"get"}},
		},
	}, "project", mappingOptions{})

	want := []string{"exec", "get", "log"}
	if got := verbsOf(t, mapping.Grants, "pods"); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("pods 操作 = %v，期望 %v", got, want)
	}
	if got := verbsOf(t, mapping.Grants, "pods"); containsString(got, "create") || containsString(got, "update") {
		t.Fatalf("pods 不应因为 pods/exec 拿到 create/update：%v", got)
	}
	if !containsString(mapping.Notes, "跳过子资源规则 pods/status") {
		t.Fatalf("未记录被跳过的子资源：%v", mapping.Notes)
	}
}

func TestMapRoleTemplatePodExecMapsToExecVerb(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "pods-exec",
		Context: "project",
		Rules: []rancherRule{{
			APIGroups: []string{""},
			Resources: []string{"pods/exec"},
			Verbs:     []string{"create"},
		}},
	}, "project", mappingOptions{})

	want := []string{"exec"}
	if got := verbsOf(t, mapping.Grants, "pods"); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("pods 操作 = %v，期望 %v", got, want)
	}
}

// 限定对象名的规则默认跳过：鸢联 AeroLink 无法表达，放宽等于提权。
func TestMapRoleTemplateSkipsResourceNamesUnlessAllowed(t *testing.T) {
	index := newResourceIndex()
	template := rancherRoleTemplate{
		ID:      "named-only",
		Context: "project",
		Rules: []rancherRule{{
			APIGroups:     []string{""},
			Resources:     []string{"configmaps"},
			Verbs:         []string{"get"},
			ResourceNames: []string{"app-config"},
		}},
	}

	skipped := index.mapRoleTemplate(template, "project", mappingOptions{})
	if len(skipped.Grants) != 0 {
		t.Fatalf("默认应跳过限定对象名的规则：%v", skipped.Grants)
	}
	if len(skipped.Notes) == 0 {
		t.Fatal("跳过规则时应当留下说明")
	}

	widened := index.mapRoleTemplate(template, "project", mappingOptions{AllowResourceNameWidening: true})
	if got := verbsOf(t, widened.Grants, "configmaps"); strings.Join(got, ",") != "get" {
		t.Fatalf("放宽后应有 configmaps 的 get：%v", widened.Grants)
	}
}

// 鸢联 AeroLink 未收录的资源与 Rancher 专有 API 组只记录、不授权。
func TestMapRoleTemplateDropsUnknownResources(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "mixed",
		Context: "project",
		Rules: []rancherRule{
			{APIGroups: []string{""}, Resources: []string{"podsecuritypolicies", "nonexistentthings"}, Verbs: []string{"get"}},
			{APIGroups: []string{"management.cattle.io"}, Resources: []string{"*"}, Verbs: []string{"*"}},
			{NonResourceURLs: []string{"/healthz"}},
		},
	}, "project", mappingOptions{})

	if len(mapping.Grants) != 0 {
		t.Fatalf("不该产生授权：%v", mapping.Grants)
	}
	messages := strings.Join(mapping.Notes, "\n")
	for _, expected := range []string{"podsecuritypolicies", "management.cattle.io", "非资源 URL"} {
		if !strings.Contains(messages, expected) {
			t.Fatalf("说明里缺少 %q：\n%s", expected, messages)
		}
	}
}

// apiGroups 非通配时，只展开该 API 组下的命名空间级资源。
func TestMapRoleTemplateExpandsOnlyMatchingGroups(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "core-only",
		Context: "project",
		Rules: []rancherRule{{
			APIGroups: []string{""},
			Resources: []string{"*"},
			Verbs:     []string{"get"},
		}},
	}, "project", mappingOptions{})

	grants := grantSet(mapping.Grants)
	if _, ok := grants["pods"]; !ok {
		t.Fatalf("core 组应包含 pods：%v", mapping.Grants)
	}
	if _, ok := grants["deployments"]; ok {
		t.Fatalf("apps 组的 deployments 不该被 core-only 规则覆盖：%v", mapping.Grants)
	}
}

// 点名列出的集群级资源只记录，不写进角色（权限绑定组授不出去）。
func TestMapRoleTemplateRecordsClusterScopedResources(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "node-reader",
		Context: "project",
		Rules: []rancherRule{{
			APIGroups: []string{""},
			Resources: []string{"nodes"},
			Verbs:     []string{"get"},
		}},
	}, "project", mappingOptions{})

	if len(mapping.Grants) != 0 {
		t.Fatalf("集群级资源不该进角色：%v", mapping.Grants)
	}
	if !strings.Contains(strings.Join(mapping.Notes, "\n"), "集群级资源") {
		t.Fatalf("应记录集群级资源不可授予：%v", mapping.Notes)
	}
}

// 真实数据里的坑：集群上下文的规则里 `resources: ["*"]` 只覆盖它声明的那个 API 组
// （rke-machine-config.cattle.io 之类）。照搬成鸢联 AeroLink 的 `*` 会变成一个 Rancher 专有的
// 只读规则把整个集群的读权限授出去。
func TestMapRoleTemplateScopedWildcardStaysScoped(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "custom-cluster-reader",
		Context: "cluster",
		Rules: []rancherRule{
			{APIGroups: []string{"rke-machine-config.cattle.io"}, Resources: []string{"*"}, Verbs: []string{"get", "watch"}},
			{APIGroups: []string{"*"}, Resources: []string{"*"}, Verbs: []string{"get"}},
		},
	}, "cluster", mappingOptions{})

	grants := grantSet(mapping.Grants)
	verbs, ok := grants["*"]
	if !ok {
		t.Fatalf("apiGroups 通配的规则应当保留资源通配：%v", mapping.Grants)
	}
	// 只有通配规则的 get 能进 `*`；rke-machine-config 那条的 watch 不能被带进来。
	if strings.Join(verbs, ",") != "get" {
		t.Fatalf("* 上的操作 = %v，期望只有 get", verbs)
	}
}

// 只声明具体 API 组的资源通配，且该组鸢联 AeroLink 没有对应资源 → 什么也不授。
func TestMapRoleTemplateScopedWildcardUnknownGroupGrantsNothing(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "machine-config-reader",
		Context: "cluster",
		Rules: []rancherRule{
			{APIGroups: []string{"rke-machine-config.cattle.io"}, Resources: []string{"*"}, Verbs: []string{"get", "watch"}},
		},
	}, "cluster", mappingOptions{})

	if len(mapping.Grants) != 0 {
		t.Fatalf("Rancher 专有 API 组的通配不应产生任何授权：%v", mapping.Grants)
	}
	if !strings.Contains(strings.Join(mapping.Notes, "\n"), "Rancher 专有 API 组") {
		t.Fatalf("应记录跳过原因：%v", mapping.Notes)
	}
}

// metrics.k8s.io 的 pods 在鸢联 AeroLink 里叫 podmetrics：要按「API 组 + 资源名」映射。
func TestMapRoleTemplateMapsMetricsAlias(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "metrics-view",
		Context: "project",
		Rules: []rancherRule{
			{APIGroups: []string{"metrics.k8s.io"}, Resources: []string{"pods"}, Verbs: []string{"get", "list"}},
			{APIGroups: []string{"metrics.k8s.io"}, Resources: []string{"nodes"}, Verbs: []string{"get"}},
		},
	}, "project", mappingOptions{})

	if got := verbsOf(t, mapping.Grants, "podmetrics"); strings.Join(got, ",") != "get" {
		t.Fatalf("podmetrics 应有 get：%v", mapping.Grants)
	}
	// core 组的 pods 不能被 metrics 组的那条规则带出来。
	if got := verbsOf(t, mapping.Grants, "pods"); len(got) != 0 {
		t.Fatalf("不该给 pods 授权：%v", got)
	}
}

// Rancher 在内置项目角色之外还会绑一个 Kubernetes 内置角色（admin / edit / view），
// 那才是工作负载权限的来源；映射必须把它补上。
func TestMapRoleTemplateAddsKubernetesBuiltinForProjectRoles(t *testing.T) {
	index := newResourceIndex()
	mapWith := func(templateID string) map[string][]string {
		t.Helper()
		mapping := index.mapRoleTemplate(rancherRoleTemplate{
			ID:      templateID,
			Context: "project",
			Rules: []rancherRule{{
				APIGroups: []string{""}, Resources: []string{"persistentvolumeclaims"}, Verbs: []string{"*"},
			}},
		}, "project", mappingOptions{})
		return grantSet(mapping.Grants)
	}

	// project-owner → admin：命名空间里的一切，含 secrets / roles / rolebindings
	owner := mapWith("project-owner")
	for _, resource := range []string{"pods", "deployments", "secrets", "roles", "rolebindings", "services"} {
		if !containsString(owner[resource], "delete") {
			t.Fatalf("project-owner（admin）应当能改 %s：%v", resource, owner[resource])
		}
	}
	for _, verb := range []string{"log", "exec", "download-file"} {
		if !containsString(owner["pods"], verb) {
			t.Fatalf("project-owner 的 pods 应有 %s：%v", verb, owner["pods"])
		}
	}

	// project-member → edit：能改 secrets，但不能改 roles / rolebindings
	member := mapWith("project-member")
	if !containsString(member["secrets"], "update") {
		t.Fatalf("project-member（edit）应当能改 secrets：%v", member["secrets"])
	}
	if _, ok := member["roles"]; ok {
		t.Fatalf("project-member（edit）不应包含 roles：%v", member["roles"])
	}
	if _, ok := member["rolebindings"]; ok {
		t.Fatalf("project-member（edit）不应包含 rolebindings：%v", member["rolebindings"])
	}

	// read-only → view：只读，且不含 secrets
	reader := mapWith("read-only")
	if _, ok := reader["secrets"]; ok {
		t.Fatalf("read-only（view）不应包含 secrets：%v", reader["secrets"])
	}
	if got := reader["deployments"]; strings.Join(got, ",") != "get" {
		t.Fatalf("read-only 对 deployments 应该只读：%v", got)
	}
	if !containsString(reader["pods"], "log") {
		t.Fatalf("read-only 应能看容器日志：%v", reader["pods"])
	}
}

// cluster-member 在下游集群里绑的是内置 view（ClusterRoleBinding 名 <user>-view）：
// 集群级只读、不含 secrets。鸢联 AeroLink 里只能靠资源通配 * + 否定模式表达。
func TestMapRoleTemplateClusterMemberGetsClusterWideView(t *testing.T) {
	index := newResourceIndex()
	mapping := index.mapRoleTemplate(rancherRoleTemplate{
		ID:      "cluster-member",
		Context: "cluster",
		Rules: []rancherRule{
			{APIGroups: []string{"management.cattle.io"}, Resources: []string{"clusters"}, Verbs: []string{"get"}},
		},
	}, "cluster", mappingOptions{})

	grants := grantSet(mapping.Grants)
	verbs, ok := grants["*"]
	if !ok {
		t.Fatalf("cluster-member 应当拿到集群级只读：%v", mapping.Grants)
	}
	if strings.Join(verbs, ",") != "get,log" {
		t.Fatalf("* 上的操作 = %v，期望 get,log", verbs)
	}
	if _, ok := grants["!secrets"]; !ok {
		t.Fatalf("应当用否定模式排除 secrets：%v", mapping.Grants)
	}
}

func TestAeroLinkRoleNameUsesProjectNaming(t *testing.T) {
	// 默认不加前缀：角色名就是 Rancher 上的角色模板名（界面里一眼能对上）。
	if got := aerolinkRoleName("", "project-owner"); got != "project-owner" {
		t.Fatalf("角色名 = %q", got)
	}
	// 需要避让时可以加前缀。
	if got := aerolinkRoleName("rk-", "project-owner"); got != "rk-project-owner" {
		t.Fatalf("带前缀的角色名 = %q", got)
	}
	long := aerolinkRoleName("", strings.Repeat("x", 200))
	if len([]rune(long)) > 100 {
		t.Fatalf("角色名过长：%d", len([]rune(long)))
	}
}

func TestGroupNameUsesProjectNameAndAvoidsCollision(t *testing.T) {
	used := map[string]struct{}{}
	project := rancherProject{ID: "c-1:p-1", Name: "Default"}
	first, description := groupName(project, "c-1:p-1", "c-1", used, "")
	// 默认直接用 Rancher 上的项目名，不加任何前缀。
	if first != "Default" {
		t.Fatalf("组名 = %q，期望直接用项目名", first)
	}
	if !strings.Contains(description, migrationMarker) || !strings.Contains(description, "c-1:p-1") {
		t.Fatalf("描述里应保留溯源信息（迁移标记 + 项目 ID）：%q", description)
	}

	// 同集群内同名项目：用项目 ID 的尾段（p-xxxxx）区分。
	second, _ := groupName(rancherProject{ID: "c-1:p-2", Name: "Default"}, "c-1:p-2", "c-1", used, "")
	if second == first || !strings.Contains(second, "p-2") {
		t.Fatalf("重名项目应错开：%q / %q", first, second)
	}

	// 带前缀时（-prefix）前缀生效。
	prefixed, _ := groupName(rancherProject{ID: "c-1:p-3", Name: "技术预研"}, "c-1:p-3", "c-1", map[string]struct{}{}, "rk-")
	if prefixed != "rk-技术预研" {
		t.Fatalf("带前缀的组名 = %q", prefixed)
	}
}

func TestDeriveGroupNameFromPrincipal(t *testing.T) {
	cases := []struct {
		principal string
		want      string
		ok        bool
	}{
		{"openldap_group://cn=devs,ou=groups,dc=example,dc=com", "devs", true},
		{"activedirectory_group://CN=Ops Team,OU=Groups,DC=corp,DC=lan", "Ops Team", true},
		{"oidc_group://developers", "developers", true},
		{"local://g-abcde", "", false},
		{"garbage", "", false},
	}
	for _, testCase := range cases {
		got, ok := deriveGroupNameFromPrincipal(testCase.principal)
		if ok != testCase.ok || (ok && got != testCase.want) {
			t.Fatalf("deriveGroupNameFromPrincipal(%q) = (%q, %v)，期望 (%q, %v)",
				testCase.principal, got, ok, testCase.want, testCase.ok)
		}
	}
}

func TestSubjectResolverResolvesUsersAndGroups(t *testing.T) {
	principals := principalsFromItems(
		[]jsonObject{
			{"id": "u-1", "username": "alice", "principalIds": []any{"local://u-1"}},
			{"id": "u-2", "username": "bob", "principalIds": []any{"openldap_user://cn=bob,ou=people,dc=example,dc=com"}},
		},
		[]jsonObject{
			{"id": "g-1", "name": "devs", "principalIds": []any{"local://g-1"}},
		},
	)
	resolver := &subjectResolver{
		principals: principals,
		userMap:    map[string]string{"bob": "robert"},
		groupMap:   map[string]string{},
	}

	// 本地用户：靠 principalId 反查用户名。
	binding, ok, _ := resolver.binding("project", "c-1", "c-1:p-1", "project-owner", jsonObject{"userPrincipalId": "local://u-1"})
	if !ok || binding.Subject != "alice" || binding.SubjectType != "user" {
		t.Fatalf("本地用户解析失败：%#v ok=%v", binding, ok)
	}

	// 目录用户：principalId 能查到用户，再按 -user-map 改名。
	binding, ok, _ = resolver.binding("project", "c-1", "c-1:p-1", "project-member",
		jsonObject{"userPrincipalId": "openldap_user://cn=bob,ou=people,dc=example,dc=com"})
	if !ok || binding.Subject != "robert" {
		t.Fatalf("目录用户映射失败：%#v ok=%v", binding, ok)
	}

	// 本地用户组：走 /v3/groups 的组名。
	binding, ok, _ = resolver.binding("project", "c-1", "c-1:p-1", "project-view", jsonObject{"groupPrincipalId": "local://g-1"})
	if !ok || binding.SubjectType != "group" || binding.Subject != "devs" {
		t.Fatalf("用户组解析失败：%#v ok=%v", binding, ok)
	}

	// 外部目录组：从 principalId 推导，并留下提示。
	binding, ok, note := resolver.binding("cluster", "c-1", "", "cluster-member",
		jsonObject{"groupPrincipalId": "openldap_group://cn=ops,ou=groups,dc=example,dc=com"})
	if !ok || binding.Subject != "ops" || binding.Scope != "cluster" {
		t.Fatalf("外部组解析失败：%#v ok=%v", binding, ok)
	}
	if !strings.Contains(note, "--group-map") {
		t.Fatalf("外部组推导应提示可用 --group-map 覆盖：%q", note)
	}

	// 查不到的本地用户：跳过并说明，不能猜用户名。
	if _, ok, note := resolver.binding("project", "c-1", "c-1:p-1", "project-owner",
		jsonObject{"userPrincipalId": "local://u-deleted"}); ok || !strings.Contains(note, "无法解析") {
		t.Fatalf("已删除用户应被跳过并说明：ok=%v note=%q", ok, note)
	}
}
