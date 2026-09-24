package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// 本文件只负责「把 Rancher 那边的授权数据读出来并归一化」。
//
// Rancher 的授权模型：
//   - 集群内的命名空间归属于**项目**（project），项目归属于集群；
//   - ProjectRoleTemplateBinding（PRTB）把主体（用户 / 用户组）与角色模板绑到项目；
//   - ClusterRoleTemplateBinding（CRTB）把主体与角色模板绑到集群；
//   - 角色模板（roleTemplate）才是真正的 RBAC 规则（apiGroups × resources × verbs）。
//
// 因此「某人在某命名空间有什么权限」= 该命名空间所属项目的 PRTB + 所属集群的 CRTB。
// 归一化后的数据供 main.go 拼装成鸢联 AeroLink 的权限绑定组。
//
// 字段名在 Norman（/v3）与 Steve（/v1）之间并不一致，且随版本漂移，所以这里的读取
// 一律走「多个候选键 + 缺失时记录说明」，而不是绑定结构体：读不全时宁可少迁一块、
// 并在报告里说清楚，也不要猜。

const rancherPageSize = 1000

type rancherCluster struct {
	ID          string
	DisplayName string
}

type rancherProject struct {
	ID          string // c-xxxxx:p-xxxxx
	ClusterID   string
	Name        string // p-xxxxx
	DisplayName string
}

type rancherNamespace struct {
	ClusterID string
	ProjectID string
	Name      string
}

// rancherBinding 是一条 PRTB / CRTB 归一化后的结果。
type rancherBinding struct {
	Scope          string // "project" | "cluster"
	ClusterID      string
	ProjectID      string
	RoleTemplateID string
	SubjectType    string // "user" | "group"
	Subject        string // 鸢联 AeroLink 侧主体名
	Principal      string
	RancherSubject string
	Notes          []string
}

// principalIndex 是 Rancher 里「principalId → 用户名 / 组名」的索引。
// Rancher 把本地账号、AD / LDAP / OIDC 账号都登记在 /v3/users 与 /v3/groups 里，
// principalIds 就是 PRTB / CRTB 里存的那个标识。
type principalIndex struct {
	userByPrincipal  map[string]string
	userByID         map[string]string
	groupByPrincipal map[string]string
	groupByID        map[string]string
}

type rancherClient struct {
	*httpClient
	// fromDir 非空时不再访问 Rancher，改为从该目录读取预先导出的集合 JSON
	// （见 -from-dir）：Rancher 不可达、密钥拿不到时也能完成迁移与评审。
	fromDir string
}

func newRancherClient(base, token string, insecure bool, timeout time.Duration, verbose bool, dumpDir string) *rancherClient {
	headers := map[string]string{"Authorization": "Bearer " + token}
	return &rancherClient{
		httpClient: newHTTPClient(base, headers, insecure, timeout, verbose, dumpDir),
	}
}

// newRancherFileClient 构造一个只读本地文件的客户端（-from-dir）。
func newRancherFileClient(fromDir, dumpDir string) *rancherClient {
	return &rancherClient{
		httpClient: newHTTPClient("", nil, false, time.Minute, false, dumpDir),
		fromDir:    fromDir,
	}
}

// list 拉取一个 Rancher 集合：默认走 HTTP 并自动翻页（Norman 用 marker 翻页、
// Steve 用 pagination.next 链接，两者都兼容），-from-dir 时改读本地文件。
func (c *rancherClient) list(collection string) ([]jsonObject, error) {
	if c.fromDir != "" {
		return c.listFromDir(collection)
	}
	items := make([]jsonObject, 0)
	next := fmt.Sprintf("%s?limit=%d", collection, rancherPageSize)
	for page := 0; page < 100; page++ {
		var doc struct {
			Data       []jsonObject `json:"data"`
			Pagination struct {
				Next string `json:"next"`
			} `json:"pagination"`
		}
		if err := c.getJSON(next, &doc); err != nil {
			return nil, err
		}
		items = append(items, doc.Data...)
		if doc.Pagination.Next != "" {
			next = doc.Pagination.Next
			continue
		}
		if len(doc.Data) < rancherPageSize {
			break
		}
		last := doc.Data[len(doc.Data)-1].str("id")
		if last == "" {
			break
		}
		next = fmt.Sprintf("%s?limit=%d&marker=%s", collection, rancherPageSize, url.QueryEscape(last))
	}
	_ = c.saveDump(collection, items)
	return items, nil
}

// listFromDir 从 -from-dir 目录里读一个集合。
// 文件名与 -dump-dir 写出的一致（"/v3/clusters" → "v3_clusters.json"），
// 内容可以是 Rancher 的原始响应（带 data）， 也可以直接是数组。
func (c *rancherClient) listFromDir(collection string) ([]jsonObject, error) {
	path := filepath.Join(c.fromDir, collectionFileName(collection))
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败：%w", path, err)
	}
	var doc struct {
		Data []jsonObject `json:"data"`
	}
	if err := json.Unmarshal(raw, &doc); err == nil && doc.Data != nil {
		return doc.Data, nil
	}
	var items []jsonObject
	if err := json.Unmarshal(raw, &items); err != nil {
		if collapsedJSONPattern.Match(raw) {
			return nil, fmt.Errorf("解析 %s 失败：%w。\n这份文件看起来是浏览器 / JSON 查看器**折叠后**的文本（数组被写成“N items”、长字符串用 … 省略）。"+
				"请改成原始响应：用 curl 拉，或在无插件的浏览器里打开 view-source:<接口 URL> 另存", path, err)
		}
		return nil, fmt.Errorf("解析 %s 失败：%w（期望 Rancher 的集合响应，或一个对象数组）", path, err)
	}
	return items, nil
}

// collapsedJSONPattern 匹配「JSON 查看器折叠后」的痕迹（例如 `"data": [ 4 items`），
// 这类文本把数组与长字符串都省掉了，不能再当成数据源。
var collapsedJSONPattern = regexp.MustCompile(`\[\s*\d+\s+items?\b`)

// collectionFileName 把接口路径变成导出的文件名，与 -dump-dir 保持一致。
func collectionFileName(collection string) string {
	return strings.Trim(strings.ReplaceAll(collection, "/", "_"), "_") + ".json"
}

// requiredCollections 列出 -from-dir 模式下必须准备的文件，缺失时报给用户。
// /v3/groups 不在其中：Rancher 可能一个用户组都没有（现场就是 0），导出时容易漏。
var requiredCollections = []string{
	"/v3/clusters",
	"/v3/projects",
	"/v1/namespaces",
	"/v3/roleTemplates",
	"/v3/users",
	"/v3/projectRoleTemplateBindings",
	"/v3/clusterRoleTemplateBindings",
}

// saveDump 把拉到的集合落到 dump 目录，便于事后核对字段（-dump-dir）；
// 同样的文件可以直接回灌给 -from-dir。空集合也要写（写成 []），
// 否则回灌时会缺文件。
func (c *rancherClient) saveDump(collection string, data []jsonObject) error {
	if c.dumpDir == "" {
		return nil
	}
	if data == nil {
		data = []jsonObject{}
	}
	encoded, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(c.dumpDir, 0o750); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(c.dumpDir, collectionFileName(collection)), encoded, 0o600)
}

func (c *rancherClient) clusters() ([]rancherCluster, error) {
	items, err := c.list("/v3/clusters")
	if err != nil {
		return nil, err
	}
	return clustersFromItems(items), nil
}

func clustersFromItems(items []jsonObject) []rancherCluster {
	out := make([]rancherCluster, 0, len(items))
	for _, item := range items {
		id := item.str("id")
		if id == "" {
			continue
		}
		// Norman 的集群对象把友好名放在 name（displayName 常为 null），
		// 集群 ID 则形如 c-xxxxx。
		display := firstNonEmpty(
			item.str("displayName"),
			item.obj("metadata").obj("annotations").str("field.cattle.io/displayName"),
			item.str("name"),
			item.obj("metadata").str("name"),
			id,
		)
		out = append(out, rancherCluster{ID: id, DisplayName: display})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (c *rancherClient) projects() ([]rancherProject, error) {
	items, err := c.list("/v3/projects")
	if err != nil {
		return nil, err
	}
	return projectsFromItems(items), nil
}

func projectsFromItems(items []jsonObject) []rancherProject {
	out := make([]rancherProject, 0, len(items))
	for _, item := range items {
		id := item.str("id")
		if id == "" {
			continue
		}
		clusterID := item.str("clusterId")
		if clusterID == "" {
			if cluster, _, ok := strings.Cut(id, ":"); ok {
				clusterID = cluster
			}
		}
		// 项目名同样优先取 Norman 的 name（现场数据里放的就是友好名）。
		display := firstNonEmpty(
			item.obj("metadata").obj("annotations").str("field.cattle.io/displayName"),
			item.str("displayName"),
			item.str("name"),
		)
		out = append(out, rancherProject{
			ID:          id,
			ClusterID:   clusterID,
			Name:        item.str("name"),
			DisplayName: display,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// namespaces 读取全部命名空间及其所属项目 / 集群。
// source 为 auto / v1 / v3：auto 先试 Steve（/v1，跨集群聚合，字段最全的是注解），
// 字段读不全时再用 Norman（/v3）补齐。
// clusters 用于补齐聚合接口覆盖不到的集群（见 namespacesFromCluster）。
func (c *rancherClient) namespaces(source string, clusters []rancherCluster) ([]rancherNamespace, []string, error) {
	var (
		namespaces []rancherNamespace
		notes      []string
		err        error
	)
	switch source {
	case sourceV1:
		namespaces, notes, err = c.namespacesFromSteve()
	case sourceV3:
		namespaces, err = c.namespacesFromNorman()
	default:
		namespaces, notes, err = c.autoNamespaces()
	}
	if err != nil {
		return nil, notes, err
	}
	return c.addNamespacesOfUncoveredClusters(namespaces, notes, clusters)
}

// autoNamespaces 是 auto 口径：先用 Steve，读不全再用 Norman 补。
func (c *rancherClient) autoNamespaces() ([]rancherNamespace, []string, error) {
	steve, steveNotes, steveErr := c.namespacesFromSteve()
	if steveErr != nil {
		notes := append([]string{}, steveNotes...)
		notes = append(notes, fmt.Sprintf("Steve /v1/namespaces 不可用（%v），改用 Norman /v3/namespaces", steveErr))
		norman, normanErr := c.namespacesFromNorman()
		if normanErr != nil {
			return nil, notes, fmt.Errorf("读取命名空间失败：/v1/namespaces: %w；/v3/namespaces: %w", steveErr, normanErr)
		}
		return norman, notes, nil
	}
	if len(steve) > 0 && countIncompleteNamespaces(steve) == 0 {
		return steve, steveNotes, nil
	}

	norman, normanErr := c.namespacesFromNorman()
	notes := append([]string{}, steveNotes...)
	if normanErr == nil {
		merged := mergeNamespaces(norman, steve)
		if incomplete := countIncompleteNamespaces(merged); incomplete > 0 {
			notes = append(notes, fmt.Sprintf("%d 个命名空间读不到所属项目 / 集群，这些命名空间的授权不会被迁移", incomplete))
		}
		return merged, notes, nil
	}
	// Norman 也不可用：退回 Steve 的结果，字段缺口已在 notes 里写明。
	notes = append(notes, fmt.Sprintf("Norman /v3/namespaces 不可用（%v），只使用 Steve 的结果", normanErr))
	return steve, notes, nil
}

// perClusterNamespacePath 是按集群取命名空间的 Steve 路径（%s 是集群 ID）。
// 现场实测：聚合接口只返回 local 集群的命名空间，这条路径才拿得到其它集群的。
const perClusterNamespacePath = "/k8s/clusters/%s/v1/namespaces"

// addNamespacesOfUncoveredClusters 给「聚合结果里一个命名空间都没有」的集群按集群补取。
//
// /v1/namespaces 与 /v3/namespaces 都只覆盖 local 集群（实测返回 504 条，恰好等于
// /k8s/clusters/local/v1/namespaces），其它集群的命名空间只出现在按集群的 Steve 路径上。
// 少了这一步，非 local 集群会呈现成「它的项目一个命名空间都没有」，那里的授权会整批漏迁。
//
// 判据取「一条都没有」而不是「比预期少」：聚合接口对某个集群要么全给要么全不给，
// 这条判据够用，也避免对每个集群都多发一次请求。读不到的集群如实写进提示，不静默跳过。
func (c *rancherClient) addNamespacesOfUncoveredClusters(namespaces []rancherNamespace, notes []string,
	clusters []rancherCluster) ([]rancherNamespace, []string, error) {
	covered := make(map[string]struct{}, len(clusters))
	for _, namespace := range namespaces {
		// 只把**带项目归属**的命名空间算作「该集群已覆盖」。
		//
		// Steve 的聚合 /v1/namespaces 会为每个集群额外返回一条「集群命名空间」对象
		// （id 就是集群 ID，如 c-m-abc123）。它没有 field.cattle.io/projectId，
		// 也不代表这个集群的命名空间已经被读到；若仅凭 ClusterID 非空就判定覆盖，
		// 所有集群都会被误判成已覆盖、跳过这里的补读，最终每个项目都显示成
		// 「没有命名空间」——一条授权都迁不过去（真机踩过）。
		if namespace.ClusterID != "" && namespace.ProjectID != "" {
			covered[namespace.ClusterID] = struct{}{}
		}
	}

	supplemented := make([]string, 0, len(clusters))
	for _, cluster := range clusters {
		if _, ok := covered[cluster.ID]; ok {
			continue
		}
		extra, err := c.namespacesFromCluster(cluster.ID)
		if err != nil {
			notes = append(notes, fmt.Sprintf(
				"集群 %s（%s）的命名空间读取失败（%v）：该集群的项目会显示成「没有命名空间」，它的授权不会被迁移",
				cluster.ID, cluster.DisplayName, err))
			continue
		}
		if len(extra) == 0 {
			continue
		}
		namespaces = append(namespaces, extra...)
		supplemented = append(supplemented, fmt.Sprintf("%s（%s，%d 个）", cluster.ID, cluster.DisplayName, len(extra)))
	}
	if len(supplemented) > 0 {
		notes = append(notes, fmt.Sprintf(
			"聚合接口只覆盖 local 集群，以下集群的命名空间改从 /k8s/clusters/<集群>/v1/namespaces 读取：%s",
			strings.Join(supplemented, "、")))
	}
	return namespaces, notes, nil
}

// namespacesFromCluster 读某个集群的命名空间。
// 这批响应里的 id 不带集群前缀、也可能没有项目注解，因此集群归属直接取请求里的集群，
// 不再从对象里推；没有注解的命名空间仍然缺项目（不会被迁移，与聚合口径一致）。
func (c *rancherClient) namespacesFromCluster(clusterID string) ([]rancherNamespace, error) {
	items, err := c.list(fmt.Sprintf(perClusterNamespacePath, clusterID))
	if err != nil {
		return nil, err
	}
	namespaces, _, err := namespacesFromSteveItems(items)
	if err != nil {
		return nil, err
	}
	for index := range namespaces {
		namespaces[index].ClusterID = clusterID
		// 标签路径只拿到项目名（p-xxxx），补成 PRTB 里用的完整项目 ID。
		namespaces[index].ProjectID = qualifyProjectID(clusterID, namespaces[index].ProjectID)
	}
	return namespaces, nil
}

// namespacesFromSteve 读 Steve 的 /v1/namespaces。
func (c *rancherClient) namespacesFromSteve() ([]rancherNamespace, []string, error) {
	items, err := c.list("/v1/namespaces")
	if err != nil {
		return nil, nil, err
	}
	return namespacesFromSteveItems(items)
}

// namespacesFromSteveItems 把 Steve 的命名空间对象归一化。
// 归属信息在元数据里：注解 field.cattle.io/projectId 是 "c-xxxx:p-xxxx"（就是 Norman 的
// 项目 ID），标签同名但只有项目名（p-xxxx）；集群还可以从 Steve 的 id
// （"c-xxxx/命名空间名"）推出来。归一化后 ProjectID 统一是 "集群:项目名"，
// 因为 PRTB 里的 projectId 就是这个写法。
func namespacesFromSteveItems(items []jsonObject) ([]rancherNamespace, []string, error) {
	out := make([]rancherNamespace, 0, len(items))
	for _, item := range items {
		metadata := item.obj("metadata")
		name := metadata.str("name")
		if name == "" {
			name = item.str("name")
		}
		if name == "" {
			continue
		}
		annotations := metadata.obj("annotations")
		labels := metadata.obj("labels")
		ref := annotations.str("field.cattle.io/projectId")
		if ref == "" {
			ref = labels.str("field.cattle.io/projectId")
		}
		if ref == "" {
			ref = item.str("projectId")
		}
		if ref == "" {
			ref = item.obj("spec").str("projectId")
		}
		clusterID := ""
		projectName := ""
		if cluster, project, ok := strings.Cut(ref, ":"); ok {
			clusterID, projectName = cluster, project
		} else {
			projectName = ref
		}
		if clusterID == "" {
			clusterID = item.str("clusterId")
		}
		if clusterID == "" {
			clusterID = labels.str("management.cattle.io/cluster-id")
		}
		if clusterID == "" {
			if prefix, _, ok := strings.Cut(item.str("id"), "/"); ok && strings.HasPrefix(prefix, "c-") {
				clusterID = prefix
			}
		}
		out = append(out, rancherNamespace{
			ClusterID: clusterID,
			ProjectID: qualifyProjectID(clusterID, projectName),
			Name:      name,
		})
	}
	notes := make([]string, 0)
	if len(items) > 0 && countIncompleteNamespaces(out) > 0 {
		notes = append(notes, "Steve 命名空间里缺少项目归属，回退到 Norman /v3/namespaces 补齐")
	}
	return out, notes, nil
}

// namespacesFromNorman 读 Norman 的 /v3/namespaces。
func (c *rancherClient) namespacesFromNorman() ([]rancherNamespace, error) {
	items, err := c.list("/v3/namespaces")
	if err != nil {
		return nil, err
	}
	return namespacesFromNormanItems(items), nil
}

// namespacesFromNormanItems 把 Norman 的命名空间对象归一化：字段是平铺的
// clusterId / projectId。
func namespacesFromNormanItems(items []jsonObject) []rancherNamespace {
	out := make([]rancherNamespace, 0, len(items))
	for _, item := range items {
		name := item.str("name")
		if name == "" {
			continue
		}
		clusterID := item.str("clusterId")
		projectName := item.str("projectId")
		if projectName != "" {
			if cluster, project, ok := strings.Cut(projectName, ":"); ok {
				projectName = project
				if clusterID == "" {
					clusterID = cluster
				}
			}
		}
		out = append(out, rancherNamespace{
			ClusterID: clusterID,
			ProjectID: qualifyProjectID(clusterID, projectName),
			Name:      name,
		})
	}
	return out
}

// qualifyProjectID 把项目名补成 Norman 的项目 ID（"集群:项目名"），
// 因为 PRTB 里的 projectId 用的就是这个写法。
func qualifyProjectID(clusterID, projectName string) string {
	if projectName == "" {
		return ""
	}
	if strings.Contains(projectName, ":") || clusterID == "" {
		return projectName
	}
	return clusterID + ":" + projectName
}

// mergeNamespaces 以 Norman 的结果为底，用 Steve 的结果补齐缺失字段与独有条目。
// Steve 的命名空间可能读不到集群（此时按名字配对），因此除了 (集群, 名字)，
// 还保留一份按名字查找的索引兜底。
func mergeNamespaces(norman, steve []rancherNamespace) []rancherNamespace {
	byKey := make(map[string]rancherNamespace, len(norman)+len(steve))
	byName := make(map[string]string, len(norman)+len(steve))
	order := make([]string, 0, len(norman)+len(steve))

	merge := func(ns rancherNamespace) {
		key := namespaceKey(ns)
		if ns.ClusterID == "" {
			if existingKey, ok := byName[ns.Name]; ok {
				key = existingKey
			}
		}
		if existing, ok := byKey[key]; ok {
			if existing.ClusterID == "" {
				existing.ClusterID = ns.ClusterID
			}
			if existing.ProjectID == "" {
				existing.ProjectID = ns.ProjectID
			}
			byKey[key] = existing
			return
		}
		byKey[key] = ns
		order = append(order, key)
		if _, ok := byName[ns.Name]; !ok {
			byName[ns.Name] = key
		}
	}

	for _, ns := range norman {
		merge(ns)
	}
	for _, ns := range steve {
		merge(ns)
	}

	out := make([]rancherNamespace, 0, len(order))
	for _, key := range order {
		out = append(out, byKey[key])
	}
	return out
}

func namespaceKey(ns rancherNamespace) string {
	if ns.ClusterID == "" {
		return "?" + ns.Name
	}
	return ns.ClusterID + "/" + ns.Name
}

func countIncompleteNamespaces(namespaces []rancherNamespace) int {
	count := 0
	for _, ns := range namespaces {
		if ns.ClusterID == "" || ns.ProjectID == "" {
			count++
		}
	}
	return count
}

func (c *rancherClient) roleTemplates() (map[string]rancherRoleTemplate, error) {
	items, err := c.list("/v3/roleTemplates")
	if err != nil {
		return nil, err
	}
	return roleTemplatesFromItems(items), nil
}

func roleTemplatesFromItems(items []jsonObject) map[string]rancherRoleTemplate {
	out := make(map[string]rancherRoleTemplate, len(items))
	for _, item := range items {
		id := item.str("id")
		if id == "" {
			continue
		}
		template := rancherRoleTemplate{
			ID:          id,
			DisplayName: item.str("displayName"),
			Context:     item.str("context"),
		}
		rules, ok := item["rules"].([]any)
		if !ok {
			out[id] = template
			continue
		}
		for _, raw := range rules {
			rule, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			obj := jsonObject(rule)
			template.Rules = append(template.Rules, rancherRule{
				APIGroups:       obj.strings("apiGroups"),
				Resources:       obj.strings("resources"),
				Verbs:           obj.strings("verbs"),
				ResourceNames:   obj.strings("resourceNames"),
				NonResourceURLs: obj.strings("nonResourceURLs"),
			})
		}
		out[id] = template
	}
	return out
}

func (c *rancherClient) principals() (*principalIndex, error) {
	users, err := c.list("/v3/users")
	if err != nil {
		return nil, err
	}
	groups, _ := c.list("/v3/groups")
	return principalsFromItems(users, groups), nil
}

func principalsFromItems(users, groups []jsonObject) *principalIndex {
	index := &principalIndex{
		userByPrincipal:  map[string]string{},
		userByID:         map[string]string{},
		groupByPrincipal: map[string]string{},
		groupByID:        map[string]string{},
	}
	for _, user := range users {
		username := user.str("username")
		if username == "" {
			continue
		}
		if id := user.str("id"); id != "" {
			index.userByID[id] = username
		}
		for _, principal := range user.strings("principalIds") {
			index.userByPrincipal[principal] = username
		}
	}
	for _, group := range groups {
		name := group.str("name")
		if name == "" {
			continue
		}
		if id := group.str("id"); id != "" {
			index.groupByID[id] = name
		}
		for _, principal := range group.strings("principalIds") {
			index.groupByPrincipal[principal] = name
		}
	}
	return index
}

// bindings 读出全部 PRTB / CRTB 并归一化成主体（用户 / 用户组）。
// projects 用于把项目绑定落到它所属的集群上。
func (c *rancherClient) bindings(projects map[string]rancherProject, resolver *subjectResolver) ([]rancherBinding, []string, error) {
	prtbs, err := c.list("/v3/projectRoleTemplateBindings")
	if err != nil {
		return nil, nil, err
	}
	crtbs, err := c.list("/v3/clusterRoleTemplateBindings")
	if err != nil {
		return nil, nil, err
	}
	return bindingsFromItems(prtbs, crtbs, projects, resolver)
}

func bindingsFromItems(prtbs, crtbs []jsonObject, projects map[string]rancherProject, resolver *subjectResolver) ([]rancherBinding, []string, error) {
	out := make([]rancherBinding, 0, len(prtbs)+len(crtbs))
	notes := make([]string, 0)
	appendBinding := func(scope, clusterID, projectID, roleTemplateID string, item jsonObject) {
		binding, ok, note := resolver.binding(scope, clusterID, projectID, roleTemplateID, item)
		if note != "" {
			notes = append(notes, note)
		}
		if ok {
			out = append(out, binding)
		}
	}

	for _, item := range prtbs {
		projectID := item.str("projectId")
		roleTemplateID := item.str("roleTemplateId")
		if roleTemplateID == "" {
			continue
		}
		clusterID := ""
		if project, ok := projects[projectID]; ok {
			clusterID = project.ClusterID
		} else if cluster, _, ok := strings.Cut(projectID, ":"); ok {
			clusterID = cluster
		}
		appendBinding("project", clusterID, projectID, roleTemplateID, item)
	}
	for _, item := range crtbs {
		clusterID := item.str("clusterId")
		roleTemplateID := item.str("roleTemplateId")
		if clusterID == "" || roleTemplateID == "" {
			continue
		}
		appendBinding("cluster", clusterID, "", roleTemplateID, item)
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].ClusterID != out[j].ClusterID {
			return out[i].ClusterID < out[j].ClusterID
		}
		if out[i].ProjectID != out[j].ProjectID {
			return out[i].ProjectID < out[j].ProjectID
		}
		if out[i].Subject != out[j].Subject {
			return out[i].Subject < out[j].Subject
		}
		return out[i].RoleTemplateID < out[j].RoleTemplateID
	})
	return out, notes, nil
}

// subjectResolver 把 Rancher 的主体标识翻成鸢联 AeroLink 的主体名。
//
// 用户：以 Rancher 用户名为准（鸢联 AeroLink 与 Rancher 接同一个目录时用户名一致），
// principalId 只用于回查用户名；--user-map 可覆盖。
// 用户组：本地组走 /v3/groups 的组名；AD / LDAP / OIDC 组从 principalId 里取
// （DN 取第一段的值，例如 cn=devs,ou=groups,... → devs），--group-map 可覆盖。
type subjectResolver struct {
	principals *principalIndex
	userMap    map[string]string
	groupMap   map[string]string
}

func (r *subjectResolver) binding(scope, clusterID, projectID, roleTemplateID string, item jsonObject) (rancherBinding, bool, string) {
	userPrincipal := item.str("userPrincipalId")
	groupPrincipal := item.str("groupPrincipalId")
	userName := item.str("userName")
	groupName := item.str("groupName")

	switch {
	case userPrincipal != "" || item.str("userId") != "":
		principal := userPrincipal
		resolved, ok := r.resolveUser(principal, item.str("userId"), userName)
		if !ok {
			return rancherBinding{}, false, fmt.Sprintf("跳过无法解析的用户主体（principalId=%s），其 %s 上的角色 %s 未迁移",
				principal, scope, roleTemplateID)
		}
		return rancherBinding{
			Scope:          scope,
			ClusterID:      clusterID,
			ProjectID:      projectID,
			RoleTemplateID: roleTemplateID,
			SubjectType:    "user",
			Subject:        resolved,
			Principal:      principal,
			RancherSubject: firstNonEmpty(userName, principal),
		}, true, ""
	case groupPrincipal != "" || item.str("groupId") != "":
		principal := groupPrincipal
		resolved, ok, note := r.resolveGroup(principal, item.str("groupId"), groupName)
		binding := rancherBinding{
			Scope:          scope,
			ClusterID:      clusterID,
			ProjectID:      projectID,
			RoleTemplateID: roleTemplateID,
			SubjectType:    "group",
			Principal:      principal,
			RancherSubject: firstNonEmpty(groupName, principal),
		}
		if !ok {
			return rancherBinding{}, false, fmt.Sprintf("跳过无法解析的用户组主体（principalId=%s），其 %s 上的角色 %s 未迁移",
				principal, scope, roleTemplateID)
		}
		binding.Subject = resolved
		return binding, true, note
	default:
		return rancherBinding{}, false, ""
	}
}

func (r *subjectResolver) resolveUser(principal, userID, userName string) (string, bool) {
	if mapped, ok := r.userMap[userName]; ok && userName != "" {
		return mapped, true
	}
	if mapped, ok := r.userMap[principal]; ok && principal != "" {
		return mapped, true
	}
	if username, ok := r.principals.userByPrincipal[principal]; ok {
		return r.applyUserMap(username), true
	}
	if username, ok := r.principals.userByID[userID]; ok {
		return r.applyUserMap(username), true
	}
	// local://u-xxxx 是 Rancher 的本地账号，用户名只能从 /v3/users 查到；
	// 查不到说明该账号已被删除或从未登录（Rancher 自己也展示不出名字）。
	if strings.HasPrefix(principal, "local://") {
		return "", false
	}
	if userName != "" {
		return r.applyUserMap(userName), true
	}
	return "", false
}

func (r *subjectResolver) applyUserMap(username string) string {
	if mapped, ok := r.userMap[username]; ok {
		return mapped
	}
	return username
}

func (r *subjectResolver) resolveGroup(principal, groupID, groupName string) (string, bool, string) {
	if mapped, ok := r.groupMap[groupName]; ok && groupName != "" {
		return mapped, true, ""
	}
	if mapped, ok := r.groupMap[principal]; ok && principal != "" {
		return mapped, true, ""
	}
	if name, ok := r.principals.groupByPrincipal[principal]; ok {
		return r.applyGroupMap(name), true, ""
	}
	if name, ok := r.principals.groupByID[groupID]; ok {
		return r.applyGroupMap(name), true, ""
	}
	if strings.HasPrefix(principal, "local://") {
		// 本地组必须能从 /v3/groups 查到，否则可能已被删除。
		return "", false, ""
	}
	derived, ok := deriveGroupNameFromPrincipal(principal)
	if !ok {
		return "", false, ""
	}
	return r.applyGroupMap(derived), true, fmt.Sprintf(
		"用户组 %s 在 AeroLink 侧按 %q 处理（从 principalId 推导），如与控制台里的组名不一致请用 --group-map 指定",
		principal, derived)
}

func (r *subjectResolver) applyGroupMap(name string) string {
	if mapped, ok := r.groupMap[name]; ok {
		return mapped
	}
	return name
}

// deriveGroupNameFromPrincipal 从外部目录的 principalId 推导组名：
// cn=devs,ou=groups,dc=example,dc=com → devs；其余情况直接取 "://" 之后的部分。
// deriveGroupNameFromPrincipal 从外部目录的 principalId 推导组名：
// cn=devs,ou=groups,dc=example,dc=com → devs；其余外部组直接取 "://" 之后的部分。
// 本地组（local://g-xxxx）只能查 /v3/groups，因此这里返回 false。
func deriveGroupNameFromPrincipal(principal string) (string, bool) {
	scheme, rest, ok := strings.Cut(principal, "://")
	if !ok || scheme == "local" {
		return "", false
	}
	rest = strings.TrimSpace(rest)
	if rest == "" {
		return "", false
	}
	if strings.Contains(rest, "=") {
		first, _, _ := strings.Cut(rest, ",")
		if _, value, ok := strings.Cut(first, "="); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value), true
		}
	}
	return rest, true
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
