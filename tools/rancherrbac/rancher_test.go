package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func objects(t *testing.T, raw string) []jsonObject {
	t.Helper()
	var out []jsonObject
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析测试数据失败：%v", err)
	}
	return out
}

// Steve 的命名空间用注解 field.cattle.io/projectId 记 "集群:项目"。
func TestNamespacesFromSteveItemsUsesProjectAnnotation(t *testing.T) {
	items := objects(t, `[
	  {
	    "id": "c-m-abc/dev",
	    "metadata": {
	      "name": "dev",
	      "labels": {"field.cattle.io/projectId": "p-111"},
	      "annotations": {"field.cattle.io/projectId": "c-m-abc:p-111"}
	    }
	  },
	  {
	    "id": "c-m-abc/default",
	    "metadata": {
	      "name": "default",
	      "labels": {"field.cattle.io/projectId": "p-222"}
	    }
	  }
	]`)

	namespaces, notes, err := namespacesFromSteveItems(items)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(namespaces) != 2 {
		t.Fatalf("命名空间数量 = %d", len(namespaces))
	}
	// 注解里的项目引用就是 Norman 的项目 ID，原样保留。
	if namespaces[0].ClusterID != "c-m-abc" || namespaces[0].ProjectID != "c-m-abc:p-111" || namespaces[0].Name != "dev" {
		t.Fatalf("第一个命名空间 = %#v", namespaces[0])
	}
	// 没有注解时用标签拿项目名，配上从 Steve id 前缀推出的集群。
	if namespaces[1].ClusterID != "c-m-abc" || namespaces[1].ProjectID != "c-m-abc:p-222" {
		t.Fatalf("第二个命名空间 = %#v", namespaces[1])
	}
	if len(notes) != 0 {
		t.Fatalf("两个命名空间都读全了，不该有回退提示：%v", notes)
	}
}

func TestNamespacesFromSteveItemsNotesIncomplete(t *testing.T) {
	items := objects(t, `[{"metadata": {"name": "orphan"}}]`)
	namespaces, notes, err := namespacesFromSteveItems(items)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if namespaces[0].ProjectID != "" {
		t.Fatalf("孤立命名空间不该有项目：%#v", namespaces[0])
	}
	if len(notes) == 0 {
		t.Fatal("读不全时应当提示回退到 Norman")
	}
}

func TestNamespacesFromNormanItems(t *testing.T) {
	items := objects(t, `[
	  {"id": "p-111:dev", "name": "dev", "clusterId": "c-m-abc", "projectId": "c-m-abc:p-111"},
	  {"id": "p-111:test", "name": "test", "projectId": "c-m-abc:p-111"}
	]`)
	namespaces := namespacesFromNormanItems(items)
	if len(namespaces) != 2 {
		t.Fatalf("命名空间数量 = %d", len(namespaces))
	}
	for _, ns := range namespaces {
		if ns.ClusterID != "c-m-abc" || ns.ProjectID != "c-m-abc:p-111" {
			t.Fatalf("归一化结果 = %#v", ns)
		}
	}
}

// 聚合接口只返回 local 集群的命名空间时（实测 /v1/namespaces 就是这样），
// 必须按集群把其余集群补上：否则它们会呈现成「项目一个命名空间都没有」，整批授权漏迁。
func TestNamespacesSupplementsClustersMissingFromAggregate(t *testing.T) {
	requests := make([]string, 0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/namespaces":
			_, _ = w.Write([]byte(`{"data": [{"metadata": {"name": "default",
				"annotations": {"field.cattle.io/projectId": "local:p-111"}}}]}`))
		case "/v3/namespaces":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message": "failed to find schema namespaces"}`))
		case "/k8s/clusters/c-m-abc/v1/namespaces":
			_, _ = w.Write([]byte(`{"data": [
				{"metadata": {"name": "apisix", "annotations": {"field.cattle.io/projectId": "c-m-abc:p-55"}}},
				{"metadata": {"name": "no-project"}}]}`))
		default:
			t.Errorf("未预期的请求：%s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	clusters := []rancherCluster{
		{ID: "local", DisplayName: "dev"},
		{ID: "c-m-abc", DisplayName: "bigdata-center"},
	}
	client := newRancherClient(server.URL, "token-abc:def", false, 10*time.Second, false, "")
	namespaces, notes, err := client.namespaces(sourceAuto, clusters)
	if err != nil {
		t.Fatalf("读取命名空间失败：%v", err)
	}

	got := map[string]rancherNamespace{}
	for _, namespace := range namespaces {
		got[namespace.ClusterID+"/"+namespace.Name] = namespace
	}
	if len(got) != 3 {
		t.Fatalf("命名空间 = %d 个：%v", len(got), got)
	}
	// 补取的这批 id 不带集群前缀，集群归属只能来自请求本身；项目仍按注解里的完整 ID。
	if ns := got["c-m-abc/apisix"]; ns.ProjectID != "c-m-abc:p-55" {
		t.Fatalf("按集群补取的命名空间 = %#v", ns)
	}
	if ns := got["c-m-abc/no-project"]; ns.ClusterID != "c-m-abc" || ns.ProjectID != "" {
		t.Fatalf("没有项目注解的命名空间 = %#v", ns)
	}
	// 已被聚合接口覆盖的集群不该再请求一次。
	if strings.Contains(strings.Join(requests, "\n"), "/k8s/clusters/local/v1/namespaces") {
		t.Fatalf("local 已被聚合结果覆盖，不该再按集群请求：%v", requests)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "c-m-abc") {
		t.Fatalf("应说明这批数据是按集群补取的：%v", notes)
	}
}

// 按集群读不到时要如实写进提示（该集群的授权不会迁移），而不是让它看起来只是「没有命名空间」；
// 也不能因为一个集群读不到就让整次读取失败。
func TestNamespacesNotesClusterReadFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/namespaces":
			_, _ = w.Write([]byte(`{"data": [{"metadata": {"name": "default",
				"annotations": {"field.cattle.io/projectId": "local:p-111"}}}]}`))
		case "/v3/namespaces":
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message": "forbidden"}`))
		}
	}))
	defer server.Close()

	clusters := []rancherCluster{
		{ID: "local", DisplayName: "dev"},
		{ID: "c-m-abc", DisplayName: "bigdata-center"},
	}
	client := newRancherClient(server.URL, "token-abc:def", false, 10*time.Second, false, "")
	namespaces, notes, err := client.namespaces(sourceAuto, clusters)
	if err != nil {
		t.Fatalf("单个集群读不到不该让整次读取失败：%v", err)
	}
	if len(namespaces) != 1 {
		t.Fatalf("命名空间 = %#v", namespaces)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "c-m-abc") {
		t.Fatalf("应提示该集群读不到、授权不会迁移：%v", notes)
	}
}

// 项目名可能只给了 p-xxxx（范例：Norman 里同样如此），要补上集群前缀。
func TestQualifyProjectID(t *testing.T) {
	cases := []struct {
		cluster  string
		project  string
		expected string
	}{
		{"c-1", "p-1", "c-1:p-1"},
		{"c-1", "c-1:p-1", "c-1:p-1"},
		{"", "p-1", "p-1"},
		{"c-1", "", ""},
	}
	for _, testCase := range cases {
		if got := qualifyProjectID(testCase.cluster, testCase.project); got != testCase.expected {
			t.Fatalf("qualifyProjectID(%q, %q) = %q，期望 %q", testCase.cluster, testCase.project, got, testCase.expected)
		}
	}
}

func TestMergeNamespacesFillsMissingFields(t *testing.T) {
	norman := []rancherNamespace{{ClusterID: "c-1", ProjectID: "c-1:p-1", Name: "dev"}}
	steve := []rancherNamespace{
		{Name: "dev"},
		{ClusterID: "c-1", ProjectID: "c-1:p-2", Name: "extra"},
	}

	merged := mergeNamespaces(norman, steve)
	if len(merged) != 2 {
		t.Fatalf("合并结果 = %#v", merged)
	}
	if merged[0].ProjectID != "c-1:p-1" {
		t.Fatalf("同名条目应保留 Norman 的归属：%#v", merged[0])
	}
	if merged[1].ProjectID != "c-1:p-2" {
		t.Fatalf("Steve 独有的条目应当保留：%#v", merged[1])
	}
}

func TestClustersAndProjectsNormalization(t *testing.T) {
	clusters := clustersFromItems(objects(t, `[
	  {"id": "c-m-abc", "displayName": "prod"},
	  {"id": "c-m-def", "metadata": {"annotations": {"field.cattle.io/displayName": "测试环境"}}},
	  {"id": "c-m-ghi"},
	  {"id": "local", "name": "dev", "displayName": null}
	]`))
	// 输出按集群 ID 排序，因此按 ID 取用而不是按下标。
	displayByID := map[string]string{}
	for _, cluster := range clusters {
		displayByID[cluster.ID] = cluster.DisplayName
	}
	// Norman 把友好名放在 name（displayName 为 null），集群 ID 才是 c-xxxxx。
	if displayByID["c-m-abc"] != "prod" || displayByID["c-m-def"] != "测试环境" ||
		displayByID["c-m-ghi"] != "c-m-ghi" || displayByID["local"] != "dev" {
		t.Fatalf("集群归一化 = %#v", clusters)
	}

	projects := projectsFromItems(objects(t, `[
	  {"id": "c-m-abc:p-111", "name": "p-111", "clusterId": "c-m-abc",
	   "metadata": {"annotations": {"field.cattle.io/displayName": "默认"}}},
	  {"id": "c-m-def:p-222", "name": "p-222"}
	]`))
	byID := map[string]rancherProject{}
	for _, project := range projects {
		byID[project.ID] = project
	}
	if byID["c-m-abc:p-111"].ClusterID != "c-m-abc" || byID["c-m-abc:p-111"].DisplayName != "默认" {
		t.Fatalf("项目归一化 = %#v", projects)
	}
	// 没有 clusterId 时从项目 ID 的前缀取。
	if byID["c-m-def:p-222"].ClusterID != "c-m-def" {
		t.Fatalf("项目归一化 = %#v", projects)
	}
}

func TestRoleTemplatesFromItems(t *testing.T) {
	templates := roleTemplatesFromItems(objects(t, `[
	  {
	    "id": "project-owner",
	    "displayName": "Project Owner",
	    "context": "project",
	    "rules": [
	      {"apiGroups": ["*"], "resources": ["*"], "verbs": ["*"]},
	      {"apiGroups": [""], "resources": ["pods/log"], "verbs": ["get"]}
	    ]
	  },
	  {"id": "no-rules", "context": "cluster"}
	]`))

	owner, ok := templates["project-owner"]
	if !ok || len(owner.Rules) != 2 {
		t.Fatalf("角色模板 = %#v", owner)
	}
	if owner.Rules[1].Resources[0] != "pods/log" || owner.Rules[1].Verbs[0] != "get" {
		t.Fatalf("第二条规则 = %#v", owner.Rules[1])
	}
	if _, ok := templates["no-rules"]; !ok {
		t.Fatal("没有规则的模板也应当保留，用于在报告里说明")
	}
}

func TestBindingsFromItems(t *testing.T) {
	principals := principalsFromItems(
		objects(t, `[{"id": "u-1", "username": "alice", "principalIds": ["local://u-1"]}]`),
		objects(t, `[{"id": "g-1", "name": "devs", "principalIds": ["local://g-1"]}]`),
	)
	resolver := &subjectResolver{principals: principals, userMap: map[string]string{}, groupMap: map[string]string{}}
	projects := map[string]rancherProject{"c-m-abc:p-111": {ID: "c-m-abc:p-111", ClusterID: "c-m-abc", Name: "p-111"}}

	bindings, notes, err := bindingsFromItems(
		objects(t, `[
		  {"id": "prtb-1", "projectId": "c-m-abc:p-111", "roleTemplateId": "project-owner", "userPrincipalId": "local://u-1"},
		  {"id": "prtb-2", "projectId": "c-m-abc:p-111", "roleTemplateId": "project-view", "groupPrincipalId": "local://g-1"},
		  {"id": "prtb-3", "projectId": "c-m-abc:p-111", "roleTemplateId": "project-view", "userPrincipalId": "local://u-gone"}
		]`),
		objects(t, `[{"id": "crtb-1", "clusterId": "c-m-abc", "roleTemplateId": "cluster-member", "userPrincipalId": "local://u-1"}]`),
		projects, resolver,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(bindings) != 3 {
		t.Fatalf("绑定数量 = %d：%#v", len(bindings), bindings)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "无法解析的用户主体") {
		t.Fatalf("应提示已删除的用户：%v", notes)
	}

	var clusterBinding *rancherBinding
	for i := range bindings {
		if bindings[i].Scope == "cluster" {
			clusterBinding = &bindings[i]
		}
	}
	if clusterBinding == nil || clusterBinding.ClusterID != "c-m-abc" || clusterBinding.Subject != "alice" {
		t.Fatalf("集群级绑定 = %#v", clusterBinding)
	}
}

// 集成视角：一个项目 + 一条 PRTB + 一条 CRTB，应当拼出一个权限绑定组，
// 项目成员用自己的角色、集群成员被分摊进来，且成员不重复。
func TestBuildPlanComposesGroups(t *testing.T) {
	index := newResourceIndex()
	data := &rancherData{
		clusters: []rancherCluster{{ID: "c-m-abc", DisplayName: "prod"}},
		projects: map[string]rancherProject{
			"c-m-abc:p-111": {ID: "c-m-abc:p-111", ClusterID: "c-m-abc", Name: "p-111", DisplayName: "默认"},
		},
		namespaces: []rancherNamespace{
			{ClusterID: "c-m-abc", ProjectID: "c-m-abc:p-111", Name: "default"},
			{ClusterID: "c-m-abc", ProjectID: "c-m-abc:p-111", Name: "dev"},
		},
		templates: map[string]rancherRoleTemplate{
			"project-owner": {ID: "project-owner", Context: "project", Rules: []rancherRule{
				{APIGroups: []string{"*"}, Resources: []string{"*"}, Verbs: []string{"*"}},
			}},
			"cluster-member": {ID: "cluster-member", Context: "cluster", Rules: []rancherRule{
				{APIGroups: []string{"*"}, Resources: []string{"*"}, Verbs: []string{"get", "list", "watch"}},
			}},
		},
		bindings: []rancherBinding{
			{Scope: "project", ClusterID: "c-m-abc", ProjectID: "c-m-abc:p-111", RoleTemplateID: "project-owner",
				SubjectType: "user", Subject: "alice"},
			{Scope: "cluster", ClusterID: "c-m-abc", RoleTemplateID: "cluster-member",
				SubjectType: "group", Subject: "devs"},
		},
	}

	plan := buildPlan(data, []kiteCluster{{ID: 1, Name: "prod"}}, options{
		clusterMaps: kvFlag{values: map[string]string{}},
		userMaps:    kvFlag{values: map[string]string{}},
		groupMaps:   kvFlag{values: map[string]string{}},
	})
	if len(plan.Groups) != 1 {
		t.Fatalf("权限绑定组数量 = %d：%#v", len(plan.Groups), plan.Groups)
	}
	group := plan.Groups[0]
	if group.KiteCluster != "prod" || group.Name != "默认" {
		t.Fatalf("权限绑定组 = %#v", group)
	}
	if strings.Join(group.Namespaces, ",") != "default,dev" {
		t.Fatalf("命名空间 = %v", group.Namespaces)
	}
	if len(group.Members) != 2 {
		t.Fatalf("成员 = %#v", group.Members)
	}
	members := map[string]memberPlan{}
	for _, member := range group.Members {
		members[member.SubjectType+"/"+member.Subject] = member
	}
	alice, ok := members["user/alice"]
	if !ok || strings.Join(alice.Roles, ",") != "project-owner" {
		t.Fatalf("项目成员 = %#v", group.Members)
	}
	// 集群级成员（cluster-member）被分摊进项目组。
	devs, ok := members["group/devs"]
	if !ok || strings.Join(devs.Roles, ",") != "cluster-member" {
		t.Fatalf("集群成员应当被分摊进项目组 = %#v", group.Members)
	}

	// 角色规则：project-owner 展开成命名空间级资源，cluster-member 保留通配 *。
	roles := map[string]roleMapping{}
	for _, role := range plan.Roles {
		roles[role.Name] = role
	}
	if _, ok := grantSet(roles["project-owner"].Grants)["*"]; ok {
		t.Fatalf("项目角色不该带资源通配：%#v", roles["project-owner"].Grants)
	}
	if _, ok := grantSet(roles["cluster-member"].Grants)["*"]; !ok {
		t.Fatalf("集群角色应保留资源通配：%#v", roles["cluster-member"].Grants)
	}
	_ = index
}

// 有集群级绑定时，该集群里每个拥有命名空间的项目都要建组：否则集群级角色只会在
// 恰好有项目级成员的那些项目的命名空间里生效。
func TestBuildPlanCoversAllNamespacesWhenClusterBindingsExist(t *testing.T) {
	template := rancherRoleTemplate{ID: "nodes-view", Context: "cluster", Rules: []rancherRule{
		{APIGroups: []string{""}, Resources: []string{"configmaps"}, Verbs: []string{"get"}},
	}}
	data := &rancherData{
		clusters: []rancherCluster{{ID: "c-1", DisplayName: "prod"}},
		projects: map[string]rancherProject{
			"c-1:p-1": {ID: "c-1:p-1", ClusterID: "c-1", DisplayName: "有成员"},
			"c-1:p-2": {ID: "c-1:p-2", ClusterID: "c-1", DisplayName: "没成员"},
		},
		namespaces: []rancherNamespace{
			{ClusterID: "c-1", ProjectID: "c-1:p-1", Name: "a"},
			{ClusterID: "c-1", ProjectID: "c-1:p-2", Name: "b"},
		},
		templates: map[string]rancherRoleTemplate{"nodes-view": template},
		bindings: []rancherBinding{
			{Scope: "cluster", ClusterID: "c-1", RoleTemplateID: "nodes-view",
				SubjectType: "user", Subject: "alice"},
		},
	}

	plan := buildPlan(data, []kiteCluster{{ID: 1, Name: "prod"}}, options{
		clusterMaps: kvFlag{values: map[string]string{}},
		userMaps:    kvFlag{values: map[string]string{}},
		groupMaps:   kvFlag{values: map[string]string{}},
	})
	if len(plan.Groups) != 2 {
		t.Fatalf("两个项目都应建组（集群级绑定要能覆盖到全部命名空间）：%#v", plan.Groups)
	}
	for _, group := range plan.Groups {
		if len(group.Members) != 1 || group.Members[0].Subject != "alice" {
			t.Fatalf("每个组都应分摊到集群级成员：%#v", group)
		}
	}
}

// 未映射到的 Rancher 集群必须整体跳过，并留下可执行的说明。
func TestBuildPlanSkipsUnmappedCluster(t *testing.T) {
	data := &rancherData{
		clusters: []rancherCluster{{ID: "c-m-zzz", DisplayName: "staging"}},
		projects: map[string]rancherProject{
			"c-m-zzz:p-9": {ID: "c-m-zzz:p-9", ClusterID: "c-m-zzz", Name: "p-9"},
		},
		namespaces: []rancherNamespace{{ClusterID: "c-m-zzz", ProjectID: "c-m-zzz:p-9", Name: "dev"}},
		templates: map[string]rancherRoleTemplate{
			"project-owner": {ID: "project-owner", Context: "project", Rules: []rancherRule{
				{APIGroups: []string{"*"}, Resources: []string{"*"}, Verbs: []string{"*"}},
			}},
		},
		bindings: []rancherBinding{{
			Scope: "project", ClusterID: "c-m-zzz", ProjectID: "c-m-zzz:p-9",
			RoleTemplateID: "project-owner", SubjectType: "user", Subject: "alice",
		}},
	}

	plan := buildPlan(data, []kiteCluster{{ID: 1, Name: "prod"}}, options{
		clusterMaps: kvFlag{values: map[string]string{}},
		userMaps:    kvFlag{values: map[string]string{}},
		groupMaps:   kvFlag{values: map[string]string{}},
	})
	if len(plan.Groups) != 0 || len(plan.Roles) != 0 {
		t.Fatalf("未映射集群不应产生任何写入：%#v", plan)
	}
	if len(plan.Notes) == 0 || !strings.Contains(strings.Join(plan.Notes, "\n"), "未映射到 Kite 集群") {
		t.Fatalf("应说明未映射的集群：%v", plan.Notes)
	}
}

func TestMergeMembersUnionsExisting(t *testing.T) {
	existing := []kiteMember{
		{SubjectType: "user", Subject: "bob", Namespace: "", RoleID: 7},
	}
	group := groupPlan{
		Name: "默认",
		Members: []memberPlan{
			{SubjectType: "user", Subject: "alice", Roles: []string{"project-owner"}},
		},
	}
	known := map[string]struct{}{"alice": {}, "bob": {}}
	roleIDs := map[string]uint{"project-owner": 42}

	inputs, changed, missing := mergeMembers(existing, group, roleIDs, options{}, known, true)
	if !changed {
		t.Fatal("并集后应当有变化")
	}
	if len(inputs) != 2 {
		t.Fatalf("成员 = %#v", inputs)
	}
	if len(missing) != 0 {
		t.Fatalf("账号都存在，不该有提示：%v", missing)
	}

	// 再并一次（幂等）：内容不变就不该重复写入。
	again, changedAgain, _ := mergeMembers(existing, groupPlan{Members: []memberPlan{{
		SubjectType: "user", Subject: "bob", Roles: []string{"unknown-role"}},
	}}, map[string]uint{"unknown-role": 7}, options{}, known, true)
	if changedAgain {
		t.Fatalf("目标状态一致时不该重写：%#v", again)
	}

	// 未知账号要报告出来（绑定照写，登录后生效）。
	_, _, missing = mergeMembers(nil, groupPlan{Members: []memberPlan{
		{SubjectType: "user", Subject: "carol", Roles: []string{"project-owner"}},
	}}, roleIDs, options{}, known, true)
	if len(missing) != 1 || missing[0] != "carol" {
		t.Fatalf("应报告 Kite 里还不存在的账号：%v", missing)
	}
}

func TestResolveKiteCluster(t *testing.T) {
	kiteClusters := []kiteCluster{{ID: 1, Name: "prod"}, {ID: 2, Name: "dev"}}

	name, ok, _ := resolveKiteCluster(rancherCluster{ID: "c-m-abc", DisplayName: "prod"}, kiteClusters, map[string]string{})
	if !ok || name != "prod" {
		t.Fatalf("按名字匹配失败：%q ok=%v", name, ok)
	}

	name, ok, _ = resolveKiteCluster(rancherCluster{ID: "c-m-abc", DisplayName: "生产集群"}, kiteClusters,
		map[string]string{"c-m-abc": "dev"})
	if !ok || name != "dev" {
		t.Fatalf("显式映射应优先生效：%q ok=%v", name, ok)
	}

	if _, ok, reason := resolveKiteCluster(rancherCluster{ID: "c-m-abc", DisplayName: "生产集群"}, kiteClusters, map[string]string{}); ok || reason == "" {
		t.Fatalf("同名缺失时应给出可执行的说明：ok=%v reason=%q", ok, reason)
	}
	if _, ok, reason := resolveKiteCluster(rancherCluster{ID: "c-m-abc", DisplayName: "生产集群"}, kiteClusters,
		map[string]string{"c-m-abc": "ghost"}); ok || !strings.Contains(reason, "不存在") {
		t.Fatalf("映射到不存在的集群应报错：ok=%v reason=%q", ok, reason)
	}
}
