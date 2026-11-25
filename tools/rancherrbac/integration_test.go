package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gzwxh/aerolink/pkg/common"
)

// 这组用例用两个桩服务把整条链路跑一遍：Rancher 侧的字段名、鸢联 AeroLink 侧的接口路径与
// 请求体、鉴权头、以及「先建角色再写绑定组」的顺序。真实环境不好频繁演练迁移，
// 这些契约就靠这里守住。

type recordedRequest struct {
	method string
	path   string
	auth   string
	body   map[string]any
}

func (r recordedRequest) grant(resource string) map[string]any {
	grants, ok := r.body["grants"].([]any)
	if !ok {
		return nil
	}
	for _, raw := range grants {
		grant, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if grant["resource"] == resource {
			return grant
		}
	}
	return nil
}

func (r recordedRequest) verbCount(resource string) int {
	grant := r.grant(resource)
	if grant == nil {
		return 0
	}
	verbs, _ := grant["verbs"].([]any)
	return len(verbs)
}

// stubRancher 返回一个最小的 Rancher 桩：一集群、一项目、两命名空间、两种角色模板、
// 一条项目绑定、一条集群绑定。
func stubRancher(t *testing.T, requests *[]recordedRequest) *httptest.Server {
	t.Helper()
	collections := map[string]string{
		"/v3/clusters": `[{"id": "c-m-abc", "displayName": "prod"}]`,
		"/v3/projects": `[{"id": "c-m-abc:p-111", "name": "p-111", "clusterId": "c-m-abc",
			"metadata": {"annotations": {"field.cattle.io/displayName": "默认"}}}]`,
		"/v1/namespaces": `[
			{"id": "c-m-abc/default", "metadata": {"name": "default",
			 "annotations": {"field.cattle.io/projectId": "c-m-abc:p-111"}}},
			{"id": "c-m-abc/dev", "metadata": {"name": "dev",
			 "annotations": {"field.cattle.io/projectId": "c-m-abc:p-111"}}}]`,
		"/v3/roleTemplates": `[
			{"id": "project-owner", "context": "project", "rules": [
				{"apiGroups": ["*"], "resources": ["*"], "verbs": ["*"]}]},
			{"id": "cluster-member", "context": "cluster", "rules": [
				{"apiGroups": ["*"], "resources": ["*"], "verbs": ["get", "list", "watch"]}]}]`,
		"/v3/users": `[
			{"id": "u-1", "username": "alice", "principalIds": ["local://u-1"]},
			{"id": "u-2", "username": "bob", "principalIds": ["local://u-2"]}]`,
		"/v3/groups": `[{"id": "g-1", "name": "devs", "principalIds": ["local://g-1"]}]`,
		"/v3/projectRoleTemplateBindings": `[
			{"id": "prtb-1", "projectId": "c-m-abc:p-111", "roleTemplateId": "project-owner",
			 "userPrincipalId": "local://u-1"}]`,
		"/v3/clusterRoleTemplateBindings": `[
			{"id": "crtb-1", "clusterId": "c-m-abc", "roleTemplateId": "cluster-member",
			 "groupPrincipalId": "local://g-1"}]`,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		if r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			if len(raw) > 0 {
				_ = json.Unmarshal(raw, &body)
			}
		}
		*requests = append(*requests, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			auth:   r.Header.Get("Authorization"),
			body:   body,
		})

		data, ok := collections[r.URL.Path]
		if !ok {
			t.Errorf("Rancher 桩收到未预期的请求：%s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type": "collection", "pagination": {"limit": 1000}, "data": ` + data + `}`))
	}))
	t.Cleanup(server.Close)
	return server
}

// stubAeroLink 返回一个最小的鸢联 AeroLink 桩，并把收到的请求记下来供断言。
func stubAeroLink(t *testing.T, requests *[]recordedRequest) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		if r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			if len(raw) > 0 {
				_ = json.Unmarshal(raw, &body)
			}
		}
		*requests = append(*requests, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			auth:   r.Header.Get("Authorization"),
			body:   body,
		})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/clusters/":
			_, _ = w.Write([]byte(`[{"id": 1, "name": "prod"}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/roles/":
			_, _ = w.Write([]byte(`{"roles": []}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/admin/roles/":
			_, _ = w.Write([]byte(`{"role": {"id": 42, "name": "created"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/binding-groups/":
			_, _ = w.Write([]byte(`{"bindingGroups": []}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/admin/binding-groups/":
			_, _ = w.Write([]byte(`{"bindingGroup": {"id": 7, "cluster": "prod", "name": "默认"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/binding-groups/7/members":
			_, _ = w.Write([]byte(`{"members": []}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/users/":
			_, _ = w.Write([]byte(`{"users": [{"username": "alice"}], "total": 1}`))
		case (r.Method == http.MethodPut || r.Method == http.MethodDelete):
			_, _ = w.Write([]byte(`{"success": true}`))
		default:
			t.Errorf("鸢联 AeroLink 桩收到未预期的请求：%s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestMigrationEndToEndAgainstStubs(t *testing.T) {
	var rancherRequests, aerolinkRequests []recordedRequest
	rancherServer := stubRancher(t, &rancherRequests)
	aerolinkServer := stubAeroLink(t, &aerolinkRequests)

	opts := options{
		rancherURL:       rancherServer.URL,
		rancherToken:     "token-abc:def",
		aerolinkURL:      aerolinkServer.URL,
		aerolinkToken:    "kite1-secret",
		namespacesSource: sourceAuto,
		timeout:          10 * time.Second,
		clusterMaps:      kvFlag{values: map[string]string{}},
		userMaps:         kvFlag{values: map[string]string{}},
		groupMaps:        kvFlag{values: map[string]string{}},
	}

	rancher := newRancherClient(opts.rancherURL, opts.rancherToken, false, opts.timeout, false, "")
	aerolink := newAeroLinkClient(opts.aerolinkURL, opts.aerolinkToken, false, opts.timeout, false)

	aerolinkClusters, err := aerolink.clusters()
	if err != nil {
		t.Fatalf("读取鸢联 AeroLink 集群失败：%v", err)
	}
	data, err := loadRancherData(rancher, opts)
	if err != nil {
		t.Fatalf("读取 Rancher 失败：%v", err)
	}
	plan := buildPlan(data, aerolinkClusters, opts)

	if len(plan.Roles) != 2 || len(plan.Groups) != 1 {
		t.Fatalf("计划 = %#v", plan)
	}
	if err := applyPlan(aerolink, plan, opts); err != nil {
		t.Fatalf("写入失败：%v", err)
	}

	assertRancherRequestsAreReadOnly(t, rancherRequests)
	assertAeroLinkRoleRequests(t, aerolinkRequests)
	assertAeroLinkBindingGroupRequests(t, aerolinkRequests)
}

// Rancher 侧：全程带 Bearer 认证，且只读。
func assertRancherRequestsAreReadOnly(t *testing.T, requests []recordedRequest) {
	t.Helper()
	if len(requests) == 0 {
		t.Fatal("没有向 Rancher 发出任何请求")
	}
	for _, request := range requests {
		if request.method != http.MethodGet {
			t.Fatalf("迁移不该写 Rancher：%s %s", request.method, request.path)
		}
		if request.auth != "Bearer token-abc:def" {
			t.Fatalf("Rancher 认证头 = %q", request.auth)
		}
	}
}

// 鸢联 AeroLink 侧：认证头是原样的 API key；项目角色的资源通配必须已展开。
func assertAeroLinkRoleRequests(t *testing.T, requests []recordedRequest) {
	t.Helper()
	byName := map[string]recordedRequest{}
	for _, request := range requests {
		if request.auth != "kite1-secret" {
			t.Fatalf("鸢联 AeroLink 认证头 = %q", request.auth)
		}
		if request.method == http.MethodPost && request.path == "/api/v1/admin/roles/" {
			name, _ := request.body["name"].(string)
			byName[name] = request
		}
	}
	if len(byName) != 2 {
		t.Fatalf("应创建 2 个角色，实际 %d 个：%#v", len(byName), byName)
	}
	owner, ok := byName["project-owner"]
	if !ok {
		t.Fatalf("缺少项目角色：%#v", byName)
	}
	if owner.grant("*") != nil {
		t.Fatalf("项目角色不该带资源通配：%#v", owner.body)
	}
	if owner.verbCount("pods") != 9 {
		t.Fatalf("pods 的操作数 = %d：%#v", owner.verbCount("pods"), owner.grant("pods"))
	}
	if member, ok := byName["cluster-member"]; !ok || member.grant("*") == nil {
		t.Fatalf("集群角色应保留资源通配：%#v", byName)
	}
}

// 鸢联 AeroLink 侧：命名空间与成员按计划写入，且用创建角色返回的 ID 建立关联。
func assertAeroLinkBindingGroupRequests(t *testing.T, requests []recordedRequest) {
	t.Helper()
	var namespaceRequest, memberRequest *recordedRequest
	for i := range requests {
		request := &requests[i]
		switch {
		case request.method == http.MethodPut && request.path == "/api/v1/admin/binding-groups/7/namespaces":
			namespaceRequest = request
		case request.method == http.MethodPut && request.path == "/api/v1/admin/binding-groups/7/members":
			memberRequest = request
		}
	}

	if namespaceRequest == nil {
		t.Fatal("没有写命名空间")
	}
	namespaces, _ := namespaceRequest.body["namespaces"].([]any)
	if len(namespaces) != 2 || namespaces[0] != "default" || namespaces[1] != "dev" {
		t.Fatalf("命名空间 = %#v", namespaceRequest.body)
	}

	if memberRequest == nil {
		t.Fatal("没有写成员")
	}
	members, _ := memberRequest.body["members"].([]any)
	if len(members) != 2 {
		t.Fatalf("成员 = %#v", memberRequest.body)
	}
	bySubject := map[string]map[string]any{}
	for _, raw := range members {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		subject, _ := entry["subject"].(string)
		bySubject[subject] = entry
	}
	alice := bySubject["alice"]
	if alice == nil || alice["subjectType"] != "user" {
		t.Fatalf("项目成员 = %#v", bySubject)
	}
	if ids, _ := alice["roleIds"].([]any); len(ids) != 1 || ids[0] != float64(42) {
		t.Fatalf("角色 ID 应用创建返回的 42：%#v", alice)
	}
	// 集群级用户组被分摊进项目组。
	if devs := bySubject["devs"]; devs == nil || devs["subjectType"] != "group" {
		t.Fatalf("集群成员应被分摊进项目组 = %#v", bySubject)
	}
}

// 幂等性：同一份计划跑第二次应当全部是「已是最新 / 无变化」，不再重复写入。
func TestApplyPlanIsIdempotent(t *testing.T) {
	type memberState struct {
		SubjectType string `json:"subjectType"`
		Subject     string `json:"subject"`
		Namespace   string `json:"namespace"`
		RoleID      uint   `json:"roleId"`
	}
	type roleState struct {
		ID     uint                   `json:"id"`
		Name   string                 `json:"name"`
		Grants []common.ResourceGrant `json:"grants"`
	}
	type groupState struct {
		ID         uint                   `json:"id"`
		Cluster    string                 `json:"cluster"`
		Name       string                 `json:"name"`
		Namespaces []aerolinkNamespaceRef `json:"namespaces"`
	}

	var requests []recordedRequest
	roles := map[uint]*roleState{}
	groups := map[uint]*groupState{}
	members := map[uint][]memberState{}
	nextRoleID, nextGroupID := uint(1), uint(1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
		}
		requests = append(requests, recordedRequest{method: r.Method, path: r.URL.Path, body: body})
		w.Header().Set("Content-Type", "application/json")

		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/roles/":
			list := make([]*roleState, 0, len(roles))
			for _, role := range roles {
				list = append(list, role)
			}
			writeJSON(t, w, map[string]any{"roles": list})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/admin/roles/":
			name, _ := body["name"].(string)
			role := &roleState{ID: nextRoleID, Name: name, Grants: decodeGrants(body["grants"])}
			roles[role.ID] = role
			nextRoleID++
			writeJSON(t, w, map[string]any{"role": role})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/binding-groups/":
			list := make([]*groupState, 0, len(groups))
			for _, group := range groups {
				list = append(list, group)
			}
			writeJSON(t, w, map[string]any{"bindingGroups": list})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/admin/binding-groups/":
			group := &groupState{ID: nextGroupID, Cluster: body["cluster"].(string), Name: body["name"].(string)}
			groups[group.ID] = group
			nextGroupID++
			writeJSON(t, w, map[string]any{"bindingGroup": group})
		case strings.HasSuffix(r.URL.Path, "/namespaces"):
			id := pathID(t, r.URL.Path)
			group := groups[id]
			group.Namespaces = nil
			for _, raw := range body["namespaces"].([]any) {
				group.Namespaces = append(group.Namespaces, aerolinkNamespaceRef{Namespace: raw.(string)})
			}
			writeJSON(t, w, map[string]any{"success": true})
		case strings.HasSuffix(r.URL.Path, "/members") && r.Method == http.MethodGet:
			id := pathID(t, r.URL.Path)
			writeJSON(t, w, map[string]any{"members": members[id]})
		case strings.HasSuffix(r.URL.Path, "/members") && r.Method == http.MethodPut:
			id := pathID(t, r.URL.Path)
			members[id] = nil
			for _, raw := range body["members"].([]any) {
				entry := raw.(map[string]any)
				for _, roleID := range entry["roleIds"].([]any) {
					members[id] = append(members[id], memberState{
						SubjectType: entry["subjectType"].(string),
						Subject:     entry["subject"].(string),
						Namespace:   entry["namespace"].(string),
						RoleID:      uint(roleID.(float64)),
					})
				}
			}
			writeJSON(t, w, map[string]any{"success": true})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/users/":
			writeJSON(t, w, map[string]any{"users": []map[string]string{{"username": "alice"}}, "total": 1})
		default:
			t.Errorf("未预期的请求：%s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	plan := &migrationPlan{
		Roles: []roleMapping{{
			Name:   "project-owner",
			Grants: []common.ResourceGrant{{Resource: "pods", Verbs: []string{"get", "log"}}},
		}},
		Groups: []groupPlan{{
			AeroLinkCluster: "prod",
			Name:            "默认",
			Namespaces:      []string{"default", "dev"},
			Members: []memberPlan{
				{SubjectType: "user", Subject: "alice", Roles: []string{"project-owner"}},
				{SubjectType: "group", Subject: "devs", Roles: []string{"project-owner"}},
			},
		}},
	}
	aerolink := newAeroLinkClient(server.URL, "kite1-secret", false, 10*time.Second, false)

	if err := applyPlan(aerolink, plan, options{}); err != nil {
		t.Fatalf("第一次写入失败：%v", err)
	}
	writes := 0
	for _, request := range requests {
		if request.method != http.MethodGet {
			writes++
		}
	}
	if writes == 0 {
		t.Fatal("第一次应当有写入")
	}

	requests = nil
	if err := applyPlan(aerolink, plan, options{}); err != nil {
		t.Fatalf("第二次写入失败：%v", err)
	}
	for _, request := range requests {
		if request.method != http.MethodGet {
			t.Fatalf("第二次不该再写入：%s %s", request.method, request.path)
		}
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, payload any) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("编码响应失败：%v", err)
	}
	_, _ = w.Write(encoded)
}

func decodeGrants(raw any) []common.ResourceGrant {
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var grants []common.ResourceGrant
	if err := json.Unmarshal(encoded, &grants); err != nil {
		return nil
	}
	return grants
}

// pathID 从 /api/v1/admin/binding-groups/<id>/... 里取出 id。
func pathID(t *testing.T, path string) uint {
	t.Helper()
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i, part := range parts {
		if part == "binding-groups" && i+1 < len(parts) {
			var id uint
			if _, err := fmt.Sscanf(parts[i+1], "%d", &id); err != nil {
				t.Fatalf("无法从路径取出绑定组 ID：%s", path)
			}
			return id
		}
	}
	t.Fatalf("路径里没有绑定组 ID：%s", path)
	return 0
}

func TestApplyPlanSkipsUnchangedRole(t *testing.T) {
	var requests []recordedRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
		}
		requests = append(requests, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			auth:   r.Header.Get("Authorization"),
			body:   body,
		})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/roles/":
			_, _ = w.Write([]byte(`{"roles": [{"id": 9, "name": "project-owner",
				"description": "由授权迁移导入：角色模板 project-owner（project 上下文）",
				"grants": [{"resource": "pods", "verbs": ["log", "get"]}]}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/binding-groups/":
			_, _ = w.Write([]byte(`{"bindingGroups": []}`))
		default:
			_, _ = w.Write([]byte(`{"success": true}`))
		}
	}))
	t.Cleanup(server.Close)

	plan := &migrationPlan{Roles: []roleMapping{{
		Name:        "project-owner",
		Description: "由授权迁移导入：角色模板 project-owner（project 上下文）",
		Grants:      []common.ResourceGrant{{Resource: "pods", Verbs: []string{"get", "log"}}},
	}}}
	aerolink := newAeroLinkClient(server.URL, "kite1-secret", false, 10*time.Second, false)
	if err := applyPlan(aerolink, plan, options{}); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	for _, request := range requests {
		if request.method != http.MethodGet {
			t.Fatalf("规则一致时不该写入：%s %s", request.method, request.path)
		}
	}
}

// 同名但不是本工具建的（描述里没有迁移标记）时只报告、不覆盖：名称默认就是 Rancher 上的
// 项目名 / 角色模板名，很容易与管理员手工建的对象撞名。
func TestApplyPlanDoesNotOverwriteForeignRole(t *testing.T) {
	var requests []recordedRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		requests = append(requests, recordedRequest{method: r.Method, path: r.URL.Path, body: map[string]any{"raw": string(raw)}})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/roles/":
			_, _ = w.Write([]byte(`{"roles": [{"id": 9, "name": "project-owner",
				"description": "运维手工建的角色", "grants": [{"resource": "pods", "verbs": ["get"]}]}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/binding-groups/":
			_, _ = w.Write([]byte(`{"bindingGroups": []}`))
		default:
			_, _ = w.Write([]byte(`{"success": true}`))
		}
	}))
	t.Cleanup(server.Close)

	plan := &migrationPlan{Roles: []roleMapping{{
		Name:        "project-owner",
		Description: "由授权迁移导入：角色模板 project-owner（project 上下文）",
		Grants:      []common.ResourceGrant{{Resource: "pods", Verbs: []string{"get", "delete"}}},
	}}}
	aerolink := newAeroLinkClient(server.URL, "kite1-secret", false, 10*time.Second, false)
	if err := applyPlan(aerolink, plan, options{}); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	for _, request := range requests {
		if request.method != http.MethodGet {
			t.Fatalf("撞名的手工角色不该被改写：%s %s", request.method, request.path)
		}
	}
}

// 未映射的集群不该产生任何鸢联 AeroLink 写入，也不该访问它的授权数据。
func TestApplyPlanNoopOnEmptyPlan(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("空计划不该发起写入：%s %s", r.Method, r.URL.Path)
	}))
	t.Cleanup(server.Close)

	aerolink := newAeroLinkClient(server.URL, "kite1-secret", false, 10*time.Second, false)
	if err := applyPlan(aerolink, &migrationPlan{}, options{}); err != nil {
		t.Fatalf("空计划应当直接返回：%v", err)
	}
}

// -cleanup 删的对象必须限定在「本工具建的」范围内：名称默认就是项目名 / 角色模板名，
// 管理员很容易建出同名的角色与绑定组，靠描述里的迁移标记区分，不能误删。
func TestCleanupPlanSkipsForeignObjects(t *testing.T) {
	var deleted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/roles/":
			_, _ = w.Write([]byte(`{"roles": [
				{"id": 1, "name": "project-owner", "description": "由授权迁移导入：角色模板 project-owner（project 上下文）"},
				{"id": 2, "name": "read-only", "description": "运维手工建的角色"},
				{"id": 3, "name": "cluster-member", "description": "由授权迁移导入：角色模板 cluster-member（cluster 上下文）", "isSystem": true}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/admin/binding-groups/":
			_, _ = w.Write([]byte(`{"bindingGroups": [
				{"id": 11, "cluster": "prod", "name": "默认", "description": "由授权迁移导入：集群 c-1 / 项目 c-1:p-1"},
				{"id": 12, "cluster": "prod", "name": "手工组", "description": "运维手工建的组"},
				{"id": 13, "cluster": "prod", "name": "默认", "description": "运维手工建的组"}]}`))
		case r.Method == http.MethodDelete:
			deleted = append(deleted, r.URL.Path)
			_, _ = w.Write([]byte(`{"success": true}`))
		default:
			t.Errorf("清理时收到未预期的请求：%s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)

	plan := &migrationPlan{
		Roles: []roleMapping{
			{Name: "project-owner", Description: "由授权迁移导入：角色模板 project-owner（project 上下文）"},
			{Name: "read-only", Description: "由授权迁移导入：角色模板 read-only（project 上下文）"},
			{Name: "cluster-member", Description: "由授权迁移导入：角色模板 cluster-member（cluster 上下文）"},
		},
		Groups: []groupPlan{{
			AeroLinkCluster: "prod",
			Name:            "默认",
			Description:     "由授权迁移导入：集群 c-1 / 项目 c-1:p-1",
		}},
	}

	aerolink := newAeroLinkClient(server.URL, "kite1-secret", false, 10*time.Second, false)
	// 没有 -yes 时必须拒绘，一笔不写。
	if err := cleanupPlan(aerolink, plan, options{}); err == nil {
		t.Fatal("缺少 -yes 时应当拒绝执行")
	}
	if len(deleted) != 0 {
		t.Fatalf("拒绝执行时不该发删除请求：%v", deleted)
	}

	if err := cleanupPlan(aerolink, plan, options{yes: true}); err != nil {
		t.Fatalf("清理失败：%v", err)
	}
	removed := map[string]bool{}
	for _, path := range deleted {
		removed[path] = true
	}
	// 带迁移标记的角色 / 绑定组被删。
	for _, path := range []string{"/api/v1/admin/roles/1", "/api/v1/admin/binding-groups/11"} {
		if !removed[path] {
			t.Fatalf("带迁移标记的对象应当被删除，%s 没删：%v", path, deleted)
		}
	}
	// 同名但描述是手工的不动；内置角色不动；计划外的对象不动。
	for _, path := range []string{"/api/v1/admin/roles/2", "/api/v1/admin/roles/3",
		"/api/v1/admin/binding-groups/12", "/api/v1/admin/binding-groups/13"} {
		if removed[path] {
			t.Fatalf("同名的手工对象 / 内置角色 / 计划外的对象不该被删：%s", path)
		}
	}
}

func TestFromDirReadsDumpedCollections(t *testing.T) {
	var requests []recordedRequest
	server := stubRancher(t, &requests)
	dir := t.TempDir()

	// 1) 走 HTTP 抓一次，顺便按 -dump-dir 落盘。
	online := options{
		rancherURL:       server.URL,
		rancherToken:     "token-abc:def",
		dumpDir:          dir,
		namespacesSource: sourceAuto,
		timeout:          10 * time.Second,
		clusterMaps:      kvFlag{values: map[string]string{}},
		userMaps:         kvFlag{values: map[string]string{}},
		groupMaps:        kvFlag{values: map[string]string{}},
	}
	onlineData, err := loadRancherData(newRancherClient(server.URL, "token-abc:def", false, 10*time.Second, false, dir), online)
	if err != nil {
		t.Fatalf("在线读取失败：%v", err)
	}

	// 2) 离线客户端读同一目录：不应再访问网络，结果应与在线一致。
	offline := online
	offline.fromDir = dir
	offline.rancherURL = ""
	offline.rancherToken = ""
	offline.dumpDir = ""
	offlineData, err := loadRancherData(newRancherFileClient(dir, ""), offline)
	if err != nil {
		t.Fatalf("离线读取失败：%v", err)
	}

	if len(offlineData.clusters) != len(onlineData.clusters) ||
		len(offlineData.projects) != len(onlineData.projects) ||
		len(offlineData.namespaces) != len(onlineData.namespaces) ||
		len(offlineData.bindings) != len(onlineData.bindings) {
		t.Fatalf("离线结果与在线不一致：\n在线：集群 %d / 项目 %d / 命名空间 %d / 绑定 %d\n离线：集群 %d / 项目 %d / 命名空间 %d / 绑定 %d",
			len(onlineData.clusters), len(onlineData.projects), len(onlineData.namespaces), len(onlineData.bindings),
			len(offlineData.clusters), len(offlineData.projects), len(offlineData.namespaces), len(offlineData.bindings))
	}
	if offlineData.namespaces[0] != onlineData.namespaces[0] {
		t.Fatalf("命名空间不一致：%#v vs %#v", offlineData.namespaces[0], onlineData.namespaces[0])
	}
}

// 导出文件缺失时要直接说清楚该准备哪些文件。
func TestFromDirReportsMissingFiles(t *testing.T) {
	dir := t.TempDir()
	_, err := loadRancherData(newRancherFileClient(dir, ""), options{fromDir: dir})
	if err == nil {
		t.Fatal("缺少文件时应当报错")
	}
	for _, want := range []string{"v3_clusters.json", "v1_namespaces.json", "v3_projectRoleTemplateBindings.json"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误信息里应列出 %s：%v", want, err)
		}
	}
}

// 导出的文件既可以是 Rancher 的原始响应（带 data），也可以直接是数组。
func TestRancherListFromDirAcceptsBothShapes(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, collectionFileName("/v3/clusters")),
		[]byte(`{"data": [{"id": "c-1", "displayName": "dev"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, collectionFileName("/v3/users")),
		[]byte(`[{"id": "u-1", "username": "alice", "principalIds": ["local://u-1"]}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	client := newRancherFileClient(dir, "")

	clusters, err := client.clusters()
	if err != nil || len(clusters) != 1 || clusters[0].DisplayName != "dev" {
		t.Fatalf("带 data 的响应解析失败：%#v err=%v", clusters, err)
	}
	principals, err := client.principals()
	if err != nil {
		t.Fatalf("数组形式解析失败：%v", err)
	}
	if principals.userByPrincipal["local://u-1"] != "alice" {
		t.Fatalf("用户 principal 索引 = %#v", principals.userByPrincipal)
	}
}

// 查看器折叠后的文本要明确指出来，否则用户只会看到一个莫名的 JSON 解析错误。
func TestRancherListFromDirDetectsCollapsedViewerOutput(t *testing.T) {
	dir := t.TempDir()
	collapsed := `{
"type": "collection",
"pagination": { "limit": 1000, "total": 4 },
"data": [ 4 items
{
"apiVersion": { "group": "meta.cattle.io" },
"links": { "self": "…/v3/clusters.json" }
}
}`
	if err := os.WriteFile(filepath.Join(dir, collectionFileName("/v3/clusters")), []byte(collapsed), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := newRancherFileClient(dir, "").clusters()
	if err == nil {
		t.Fatal("折叠文本应当报错")
	}
	if !strings.Contains(err.Error(), "折叠") {
		t.Fatalf("错误信息里应指出这是折叠后的文本：%v", err)
	}
}

func TestCollectionFileName(t *testing.T) {
	if got := collectionFileName("/v3/clusters"); got != "v3_clusters.json" {
		t.Fatalf("collectionFileName = %q", got)
	}
	if got := collectionFileName("/v1/namespaces"); got != "v1_namespaces.json" {
		t.Fatalf("collectionFileName = %q", got)
	}
}

func TestAeroLinkAuthErrorExplainsReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error": "Invalid API key"}`))
	}))
	t.Cleanup(server.Close)

	aerolink := newAeroLinkClient(server.URL, "kite1-wrong", false, 10*time.Second, false)
	_, err := aerolink.clusters()
	if err == nil {
		t.Fatal("应当返回鉴权错误")
	}
	message := explainAuthError(err).Error()
	if !strings.Contains(message, "AeroLink API key 无效") {
		t.Fatalf("错误信息缺少可操作提示：%s", message)
	}
}
