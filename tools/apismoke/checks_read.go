package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// readOnlyChecks 覆盖各功能面的读路径。只读、可重复跑，所以默认全开。
func (r *runner) readOnlyChecks() {
	fmt.Println("--- 设置类 ---")
	for _, path := range []string{
		"/api/v1/admin/general-setting/",
		"/api/v1/admin/security-setting/",
		"/api/v1/admin/security-setting/locked-ips",
		"/api/v1/admin/notification-setting/",
		"/api/v1/admin/audit-setting/",
		"/api/v1/admin/ldap-setting/",
		"/api/v1/admin/oauth-providers/",
	} {
		r.expectStatus("读取 "+path, "GET", path, nil, 200)
	}

	fmt.Println("--- 审计与日志（含导出）---")
	r.expectStatus("审计日志分页", "GET", "/api/v1/admin/audit-logs?page=1&pageSize=5", nil, 200)
	r.expectStatus("审计日志检索", "GET", "/api/v1/admin/audit-logs?page=1&pageSize=5&search=a", nil, 200)
	r.expectStatus("审计日志导出 CSV", "GET", "/api/v1/admin/audit-logs/export", nil, 200)
	r.expectStatus("登录日志分页", "GET", "/api/v1/admin/login-logs?page=1&pageSize=5", nil, 200)
	r.expectStatus("登录日志导出 CSV", "GET", "/api/v1/admin/login-logs/export", nil, 200)
	r.expectStatus("改密日志分页", "GET", "/api/v1/admin/password-change-logs?page=1&pageSize=5", nil, 200)
	r.expectStatus("改密日志导出 CSV", "GET", "/api/v1/admin/password-change-logs/export", nil, 200)

	fmt.Println("--- 用户/角色/权限 ---")
	for _, path := range []string{
		"/api/v1/admin/users/?page=1&pageSize=5",
		"/api/v1/admin/roles/",
		"/api/v1/admin/role-conflicts",
		"/api/v1/admin/binding-groups/",
		"/api/v1/admin/groups",
		"/api/v1/admin/group-members",
		"/api/v1/admin/apikeys/",
	} {
		r.expectStatus("读取 "+path, "GET", path, nil, 200)
	}
	r.expectStatus("用户检索", "GET", "/api/v1/admin/users/?page=1&pageSize=5&search=a", nil, 200)

	fmt.Println("--- 通知/模板/Helm ---")
	for _, path := range []string{
		"/api/v1/admin/notification-templates/",
		"/api/v1/admin/notification-subscriptions/",
		"/api/v1/templates",
		"/api/v1/charts/repositories",
		"/api/v1/notifications",
		"/api/v1/notifications/unread-count",
	} {
		r.expectStatus("读取 "+path, "GET", path, nil, 200)
	}

	fmt.Println("--- 集群与资源（只读）---")
	r.expectStatus("集群列表", "GET", "/api/v1/admin/clusters/", nil, 200)
	r.expectStatus("命名空间列表", "GET", r.clusterPath("/namespaces/_all"), nil, 200)
	r.expectStatus("Helm 发布列表", "GET", r.clusterPath("/helmrelease"), nil, 200)
	r.expectStatus("全局搜索", "GET", r.clusterPath("/search?q=a&limit=10"), nil, 200)
	r.expectStatus("节点列表", "GET", r.clusterPath("/nodes/_all"), nil, 200)

	ns := r.opts.namespace
	for _, resource := range []string{"pods", "deployments", "configmaps", "secrets", "services", "events"} {
		r.expectStatus("集群范围内列出 "+resource, "GET", r.clusterPath("/"+resource+"/_all"), nil, 200)
		r.expectStatus("命名空间内列出 "+resource, "GET", r.clusterPath("/"+resource+"/"+ns), nil, 200)
	}
	r.expectStatus("Pod 列表带 search", "GET", r.clusterPath("/pods/"+ns+"?search=a"), nil, 200)

	// 找一个 Deployment 走详情/describe/历史/关联——读路径里最容易踩到数据库的一层。
	if name := r.firstObjectName("/deployments/"+ns, ""); name != "" {
		base := "/deployments/" + ns + "/" + name
		r.expectStatus("Deployment 详情", "GET", r.clusterPath(base), nil, 200)
		r.expectStatus("Deployment describe", "GET", r.clusterPath(base+"/describe"), nil, 200)
		r.expectStatus("Deployment 历史", "GET", r.clusterPath(base+"/history"), nil, 200)
		r.expectStatus("Deployment 关联资源", "GET", r.clusterPath(base+"/related"), nil, 200)
	}

	r.fileBrowseCheck(ns)
}

// fileBrowseCheck 用第一个 Running 的 Pod 试一次容器文件浏览。
// 精简镜像（distroless）里没有 ls，服务端会明确回 pod_files_unsupported——
// 那是预期内的，记为跳过而不是失败。
func (r *runner) fileBrowseCheck(ns string) {
	_, raw, err := r.client.request("GET", r.clusterPath("/pods/"+ns), nil)
	if err != nil {
		r.check("容器文件浏览", false, err.Error())
		return
	}
	items, err := listItems(raw)
	if err != nil {
		r.check("容器文件浏览", false, err.Error())
		return
	}
	pod, container := "", ""
	for _, item := range items {
		if strings.ToLower(nestedString(item, "status", "phase")) != "running" {
			continue
		}
		containers, _ := item["spec"].(map[string]any)["containers"].([]any)
		if len(containers) == 0 {
			continue
		}
		first, _ := containers[0].(map[string]any)
		pod, container = objectName(item), fieldString(first, "name")
		break
	}
	if pod == "" || container == "" {
		r.check("容器文件浏览（跳过：命名空间内没有 Running 的 Pod）", true, "")
		return
	}
	path := fmt.Sprintf("%s/pods/%s/%s/files?path=%s&container=%s",
		r.clusterPath(""), ns, pod, url.QueryEscape("/"), url.QueryEscape(container))
	status, raw, err := r.client.request("GET", path, nil)
	if err != nil {
		r.check("容器文件浏览", false, err.Error())
		return
	}
	if status == 400 && strings.Contains(string(raw), "pod_files_unsupported") {
		r.check("容器文件浏览（跳过：容器是精简镜像，没有 ls）", true, "")
		return
	}
	r.check("容器文件浏览", status == 200, fmt.Sprintf("status=%d body=%s", status, truncate(string(raw), 120)))
}

// firstObjectName 取列表里第一个对象的名字，取不到就返回空串（调用方据此跳过）。
func (r *runner) firstObjectName(path, _ string) string {
	_, raw, err := r.client.request("GET", r.clusterPath(path), nil)
	if err != nil {
		return ""
	}
	items, err := listItems(raw)
	if err != nil {
		return ""
	}
	for _, item := range items {
		if name := objectName(item); name != "" {
			return name
		}
	}
	return ""
}

// decodeObject 把响应解成一个 map，用于取单个字段做断言。
func decodeObject(raw []byte) map[string]any {
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil
	}
	return decoded
}
