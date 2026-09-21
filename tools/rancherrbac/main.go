// Command rancherrbac 把 Rancher 上「谁在哪些命名空间里有什么权限」搬成 Kite 的
// 权限绑定组，相当于替管理员把授权配置好。
//
// 入口脚本：scripts/migrate-rancher-rbac.sh
// 迁移口径与取舍：docs/dev/plans/2026-09-21-rancher-rbac-migration.md
//
// 默认是只读的 dry-run：打印计划，不写任何东西；确认无误后加 -apply 落库。
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/zxh326/kite/pkg/common"
)

const (
	sourceAuto = "auto"
	sourceV1   = "v1"
	sourceV3   = "v3"
)

type options struct {
	rancherURL      string
	rancherToken    string
	rancherInsecure bool
	kiteURL         string
	kiteToken       string
	kiteInsecure    bool

	apply              bool
	planOut            string
	dumpDir            string
	fromDir            string
	prefix             string
	namespacesSource   string
	skipClusterGrants  bool
	replaceMembers     bool
	replaceNamespaces  bool
	widenResourceNames bool
	clusterMaps        kvFlag
	userMaps           kvFlag
	groupMaps          kvFlag
	timeout            time.Duration
	verbose            bool
	cleanup            bool
	yes                bool

	// configPath 是实际生效的配置文件路径（空表示没用配置文件），仅用于在报告里说明取值来源。
	configPath string
	// initConfig 只是「生成配置模板」这个动作的目标路径，不参与迁移。
	initConfig  string
	showVersion bool
}

// buildVersion 由构建时 -ldflags -X 注入（见 scripts/build-rancherrbac.sh），源码里构建就是 dev。
var buildVersion = "dev"

func main() {
	opts, err := loadOptions(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		// -h / -help：用法已经打过了，正常退出。
		return
	}
	if err != nil {
		fail(err)
	}
	if opts.showVersion {
		fmt.Printf("%s %s\n", filepath.Base(os.Args[0]), buildVersion)
		return
	}
	if opts.initConfig != "" {
		if err := writeConfigTemplate(opts.initConfig); err != nil {
			fail(err)
		}
		return
	}
	if err := run(opts); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "\n❌ %v\n", err)
	os.Exit(1)
}

func envOr(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}

// kvFlag 是「键=值」形式的可重复参数。按第一个 "=" 切分：principalId 里的
// LDAP DN（cn=x,ou=y）本身带等号，不能按最后一个切。
type kvFlag struct {
	values map[string]string
}

func (f *kvFlag) String() string {
	if f == nil || len(f.values) == 0 {
		return ""
	}
	keys := make([]string, 0, len(f.values))
	for key := range f.values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+f.values[key])
	}
	return strings.Join(parts, ",")
}

func (f *kvFlag) Set(value string) error {
	key, val, ok := strings.Cut(value, "=")
	key = strings.TrimSpace(key)
	val = strings.TrimSpace(val)
	if !ok || key == "" || val == "" {
		return fmt.Errorf("应该是 键=值 形式：%q", value)
	}
	if f.values == nil {
		f.values = map[string]string{}
	}
	f.values[key] = val
	return nil
}

// ---------- 计划 ----------

type migrationPlan struct {
	ClusterMappings []clusterMapping `json:"clusterMappings"`
	Roles           []roleMapping    `json:"roles"`
	Groups          []groupPlan      `json:"groups"`
	Notes           []string         `json:"notes"`
}

type clusterMapping struct {
	RancherID   string `json:"rancherClusterId"`
	RancherName string `json:"rancherClusterName"`
	KiteCluster string `json:"kiteCluster,omitempty"`
}

type groupPlan struct {
	RancherClusterID string       `json:"rancherClusterId"`
	KiteCluster      string       `json:"kiteCluster"`
	ProjectID        string       `json:"rancherProjectId"`
	Name             string       `json:"name"`
	Description      string       `json:"description"`
	Namespaces       []string     `json:"namespaces"`
	Members          []memberPlan `json:"members"`
}

type memberPlan struct {
	SubjectType string   `json:"subjectType"`
	Subject     string   `json:"subject"`
	Roles       []string `json:"roles"`
	// Sources 记录该成员在 Rancher 侧的来源（集群绑定 / 项目绑定），仅用于报告。
	Sources []string `json:"sources,omitempty"`
}

// rancherData 是本次迁移用到的全部 Rancher 侧数据。
type rancherData struct {
	clusters   []rancherCluster
	projects   map[string]rancherProject
	namespaces []rancherNamespace
	templates  map[string]rancherRoleTemplate
	bindings   []rancherBinding
	notes      []string
}

// namespaceIndex 把命名空间按项目 / 集群归拢一次，拼装权限绑定组时反复要用。
type namespaceIndex struct {
	byProject map[string][]string
	byCluster map[string][]string
	clusterOf map[string]string
	// projectsByCluster 是该集群下「拥有至少一个命名空间」的项目，已排序。
	projectsByCluster map[string][]string
}

func newNamespaceIndex(namespaces []rancherNamespace) *namespaceIndex {
	index := &namespaceIndex{
		byProject:         map[string][]string{},
		byCluster:         map[string][]string{},
		clusterOf:         map[string]string{},
		projectsByCluster: map[string][]string{},
	}
	for _, ns := range namespaces {
		if ns.ClusterID == "" || ns.ProjectID == "" {
			continue
		}
		index.byProject[ns.ProjectID] = append(index.byProject[ns.ProjectID], ns.Name)
		index.byCluster[ns.ClusterID] = append(index.byCluster[ns.ClusterID], ns.Name)
		if _, seen := index.clusterOf[ns.ProjectID]; !seen {
			index.projectsByCluster[ns.ClusterID] = append(index.projectsByCluster[ns.ClusterID], ns.ProjectID)
		}
		index.clusterOf[ns.ProjectID] = ns.ClusterID
	}
	for project := range index.byProject {
		sort.Strings(index.byProject[project])
	}
	for cluster := range index.byCluster {
		sort.Strings(index.byCluster[cluster])
		sort.Strings(index.projectsByCluster[cluster])
	}
	return index
}

func (index *namespaceIndex) project(projectID string) []string {
	return index.byProject[projectID]
}

func (index *namespaceIndex) cluster(clusterID string) []string {
	return index.byCluster[clusterID]
}

func (index *namespaceIndex) clusterOfProject(projectID string) string {
	return index.clusterOf[projectID]
}

func (index *namespaceIndex) projectsOfCluster(clusterID string) []string {
	return index.projectsByCluster[clusterID]
}

func run(opts options) error {
	switch {
	case opts.kiteURL == "":
		return errors.New("缺少 Kite 地址：用 -kite-url、环境变量 KITE_URL 或配置文件 kite.url 指定")
	case opts.kiteToken == "":
		return errors.New("缺少 Kite API key：用 -kite-token、环境变量 KITE_TOKEN 或配置文件 kite.token 指定")
	case !strings.HasPrefix(opts.kiteToken, "kite"):
		return errors.New("API key 应当以 kite 开头：请填控制台创建时给出的完整值（形如 kite1-xxxxxxxx）")
	}
	// -cleanup 只动 Kite：给了 -prefix 就按前缀删，否则要先用计划算出到底该删哪些（见下）。
	if opts.cleanup && opts.prefix != "" {
		if opts.kiteURL == "" {
			return errors.New("缺少 Kite 地址：用 -kite-url、环境变量 KITE_URL 或配置文件 kite.url 指定")
		}
		if opts.kiteToken == "" {
			return errors.New("缺少 Kite API key：用 -kite-token、环境变量 KITE_TOKEN 或配置文件 kite.token 指定")
		}
		return cleanupByPrefix(newKiteClient(opts.kiteURL, opts.kiteToken, opts.kiteInsecure, opts.timeout, opts.verbose), opts)
	}
	if opts.fromDir == "" {
		switch {
		case opts.rancherURL == "":
			return errors.New("缺少 Rancher 地址：用 -rancher-url、环境变量 RANCHER_URL 或配置文件 rancher.url 指定（或改用 -from-dir 读导出的 JSON）")
		case opts.rancherToken == "":
			return errors.New("缺少 Rancher API 密钥：用 -rancher-token、环境变量 RANCHER_TOKEN 或配置文件 rancher.token 指定（或改用 -from-dir）")
		case !strings.Contains(opts.rancherToken, ":"):
			return errors.New("密钥应当是 token-xxxxx:yyyyy 形式（Rancher 的 Access Key:Secret Key）")
		}
	}

	rancher := newRancherClient(opts.rancherURL, opts.rancherToken, opts.rancherInsecure, opts.timeout, opts.verbose, opts.dumpDir)
	if opts.fromDir != "" {
		rancher = newRancherFileClient(opts.fromDir, opts.dumpDir)
	}
	kite := newKiteClient(opts.kiteURL, opts.kiteToken, opts.kiteInsecure, opts.timeout, opts.verbose)

	// Kite 侧先探一次：连通性与鉴权问题在这里就暴露，不要等到写了一半才发现。
	kiteClusters, err := kite.clusters()
	if err != nil {
		return fmt.Errorf("读取 Kite 集群列表失败（%s）：%w",
			kiteURLJoin(opts.kiteURL, "/api/v1/admin/clusters/"), explainAuthError(err))
	}

	if opts.configPath != "" {
		fmt.Printf("→ 配置文件：%s（命令行与环境变量优先于它）\n", opts.configPath)
	}
	if opts.fromDir != "" {
		fmt.Printf("→ 读取离线数据：%s（本次不访问 Rancher）\n", opts.fromDir)
	} else {
		fmt.Printf("→ 读取 Rancher：%s\n", opts.rancherURL)
	}
	data, err := loadRancherData(rancher, opts)
	if err != nil {
		return err
	}

	plan := buildPlan(data, kiteClusters, opts)

	// -cleanup（无前缀）靠计划定位要删的对象：名称默认就是项目名 / 模板名，
	// 无法靠名字区分是不是本工具建的，必须用描述里的迁移标记排除手工对象。
	if opts.cleanup {
		return cleanupPlan(kite, plan, opts)
	}

	printPlan(plan)

	if opts.planOut != "" {
		encoded, err := json.MarshalIndent(plan, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(opts.planOut, encoded, 0o600); err != nil {
			return fmt.Errorf("写出计划文件失败：%w", err)
		}
		fmt.Printf("\n计划已写入 %s\n", opts.planOut)
	}

	if !opts.apply {
		fmt.Println("\n当前是 dry-run（只读）。确认上面的计划无误后，加上 -apply 才会写入 Kite。")
		return nil
	}

	fmt.Println("\n→ 写入 Kite⋯")
	return applyPlan(kite, plan, opts)
}

func loadRancherData(client *rancherClient, opts options) (*rancherData, error) {
	if opts.fromDir != "" {
		missing := make([]string, 0)
		for _, collection := range requiredCollections {
			name := collectionFileName(collection)
			if _, err := os.Stat(filepath.Join(opts.fromDir, name)); err != nil {
				missing = append(missing, fmt.Sprintf("%s（%s）", name, collection))
			}
		}
		if len(missing) > 0 {
			return nil, fmt.Errorf("%s 里缺少这些文件：\n  - %s\n每个文件应当是 Rancher 对应接口的响应 JSON（带 data 数组），文件名如上",
				opts.fromDir, strings.Join(missing, "\n  - "))
		}
	}

	data := &rancherData{projects: map[string]rancherProject{}}

	clusters, err := client.clusters()
	if err != nil {
		return nil, fmt.Errorf("读取 Rancher 集群失败：%w", err)
	}
	data.clusters = clusters

	projects, err := client.projects()
	if err != nil {
		return nil, fmt.Errorf("读取 Rancher 项目失败：%w", err)
	}
	for _, project := range projects {
		data.projects[project.ID] = project
	}

	namespaces, notes, err := client.namespaces(opts.namespacesSource, clusters)
	if err != nil {
		return nil, fmt.Errorf("读取 Rancher 命名空间失败：%w", err)
	}
	data.namespaces = namespaces
	data.notes = append(data.notes, notes...)

	templates, err := client.roleTemplates()
	if err != nil {
		return nil, fmt.Errorf("读取 Rancher 角色模板失败：%w", err)
	}
	data.templates = templates

	principals, err := client.principals()
	if err != nil {
		return nil, fmt.Errorf("读取 Rancher 用户/用户组失败：%w", err)
	}

	bindings, bindingNotes, err := client.bindings(data.projects, &subjectResolver{
		principals: principals,
		userMap:    opts.userMaps.values,
		groupMap:   opts.groupMaps.values,
	})
	if err != nil {
		return nil, fmt.Errorf("读取 Rancher 授权绑定（PRTB / CRTB）失败：%w", err)
	}
	data.bindings = bindings
	data.notes = append(data.notes, bindingNotes...)

	fmt.Printf("  集群 %d 个，项目 %d 个，命名空间 %d 个，角色模板 %d 个，授权绑定 %d 条\n",
		len(data.clusters), len(data.projects), len(data.namespaces), len(data.templates), len(data.bindings))
	return data, nil
}

func buildPlan(data *rancherData, kiteClusters []kiteCluster, opts options) *migrationPlan {
	plan := &migrationPlan{Notes: append([]string{}, data.notes...)}
	namespaces := newNamespaceIndex(data.namespaces)

	clusterMap, mappings, mappingNotes := resolveClusterMappings(data.clusters, kiteClusters, opts)
	plan.ClusterMappings = mappings
	plan.Notes = append(plan.Notes, mappingNotes...)

	projectBindings, clusterBindings, usedTemplates, bindingNotes := collectBindings(data, clusterMap, namespaces, opts)
	plan.Notes = append(plan.Notes, bindingNotes...)

	roleByName, roleMappingNotes := mapRoles(data, usedTemplates, newResourceIndex(), opts)
	plan.Roles = sortedRoles(roleByName)
	plan.Notes = append(plan.Notes, roleMappingNotes...)

	groups, groupNotes := assembleGroups(data, clusterMap, namespaces, projectBindings, clusterBindings, roleByName, opts.prefix)
	plan.Groups = groups
	plan.Notes = append(plan.Notes, groupNotes...)

	plan.Notes = uniqueStrings(plan.Notes)
	return plan
}

// resolveClusterMappings 决定每个 Rancher 集群落到哪个 Kite 集群；映射不上的集群整体跳过。
func resolveClusterMappings(clusters []rancherCluster, kiteClusters []kiteCluster, opts options) (map[string]string, []clusterMapping, []string) {
	clusterMap := make(map[string]string, len(clusters))
	mappings := make([]clusterMapping, 0, len(clusters))
	notes := make([]string, 0)
	for _, cluster := range clusters {
		kiteName, ok, reason := resolveKiteCluster(cluster, kiteClusters, opts.clusterMaps.values)
		mappings = append(mappings, clusterMapping{
			RancherID:   cluster.ID,
			RancherName: cluster.DisplayName,
			KiteCluster: kiteName,
		})
		if !ok {
			notes = append(notes, fmt.Sprintf(
				"Rancher 集群 %s（%s）未映射到 Kite 集群，该集群下的授权未迁移：%s", cluster.ID, cluster.DisplayName, reason))
			continue
		}
		clusterMap[cluster.ID] = kiteName
	}
	return clusterMap, mappings, notes
}

// collectBindings 按「项目绑定 / 集群绑定」分类，并记录每个角色模板被用在哪种上下文。
func collectBindings(data *rancherData, clusterMap map[string]string, namespaces *namespaceIndex, opts options) (
	map[string][]rancherBinding, map[string][]rancherBinding, map[string]map[string]struct{}, []string) {
	projectBindings := map[string][]rancherBinding{}
	clusterBindings := map[string][]rancherBinding{}
	usedTemplates := map[string]map[string]struct{}{}
	notes := make([]string, 0)

	for _, binding := range data.bindings {
		if _, ok := clusterMap[binding.ClusterID]; !ok {
			continue
		}
		if binding.Scope == "project" {
			if len(namespaces.project(binding.ProjectID)) == 0 {
				notes = append(notes, fmt.Sprintf(
					"项目 %s 在 Rancher 里没有命名空间，%s %s 在该项目的角色 %s 未迁移（Kite 里没有可授权的范围）",
					binding.ProjectID, subjectLabel(binding.SubjectType), binding.Subject, binding.RoleTemplateID))
				continue
			}
			projectBindings[binding.ProjectID] = append(projectBindings[binding.ProjectID], binding)
		} else {
			if opts.skipClusterGrants {
				continue
			}
			clusterBindings[binding.ClusterID] = append(clusterBindings[binding.ClusterID], binding)
		}
		if usedTemplates[binding.RoleTemplateID] == nil {
			usedTemplates[binding.RoleTemplateID] = map[string]struct{}{}
		}
		usedTemplates[binding.RoleTemplateID][binding.Scope] = struct{}{}
	}
	return projectBindings, clusterBindings, usedTemplates, notes
}

// mapRoles 把用到的角色模板翻成 Kite 角色定义。
func mapRoles(data *rancherData, usedTemplates map[string]map[string]struct{}, index *resourceIndex, opts options) (map[string]roleMapping, []string) {
	roleByName := map[string]roleMapping{}
	notes := make([]string, 0)
	// 按模板 ID 排序遍历：map 的随机顺序会让两次运行的计划文本不一致，
	// 而计划是要人工 diff 核对的东西。
	templateIDs := make([]string, 0, len(usedTemplates))
	for templateID := range usedTemplates {
		templateIDs = append(templateIDs, templateID)
	}
	sort.Strings(templateIDs)
	for _, templateID := range templateIDs {
		scopes := usedTemplates[templateID]
		template, ok := data.templates[templateID]
		if !ok {
			notes = append(notes, fmt.Sprintf(
				"角色模板 %s 在 Rancher 里查不到（可能已删除），引用它的授权未迁移", templateID))
			continue
		}
		context, inferred := templateContext(template, scopes)
		if inferred {
			notes = append(notes, fmt.Sprintf(
				"角色模板 %s 没写上下文，按使用位置推断为 %s", templateID, context))
		}
		mapping := index.mapRoleTemplate(template, context, mappingOptions{
			AllowResourceNameWidening: opts.widenResourceNames,
			NamePrefix:                opts.prefix,
		})
		if len(mapping.Grants) == 0 {
			notes = append(notes, fmt.Sprintf(
				"角色模板 %s 的规则在 Kite 里没有可用映射（全是 Rancher 专有资源或非资源 URL），引用它的授权未迁移", templateID))
			continue
		}
		for _, note := range mapping.Notes {
			notes = append(notes, fmt.Sprintf("角色 %s：%s", mapping.Name, note))
		}
		roleByName[mapping.Name] = mapping
	}
	return roleByName, notes
}

func sortedRoles(roleByName map[string]roleMapping) []roleMapping {
	roles := make([]roleMapping, 0, len(roleByName))
	for _, mapping := range roleByName {
		roles = append(roles, mapping)
	}
	sort.Slice(roles, func(i, j int) bool { return roles[i].Name < roles[j].Name })
	return roles
}

// assembleGroups 组装权限绑定组：一个 Rancher 项目 = 一个 Kite 权限绑定组。
//
// 集群级绑定（CRTB）在 Kite 里没有对应的授权容器可用（绑定组按命名空间组织），
// 因此把它分摊到该集群的每个权限绑定组：成员命名空间范围为「整组」，正好覆盖该
// 集群的全部命名空间；资源通配 * 的角色还能覆盖集群级资源。
func assembleGroups(data *rancherData, clusterMap map[string]string, namespaces *namespaceIndex,
	projectBindings, clusterBindings map[string][]rancherBinding, roleByName map[string]roleMapping, prefix string) ([]groupPlan, []string) {
	notes := make([]string, 0)
	usedNames := map[string]map[string]struct{}{}
	groups := map[string]*groupPlan{}
	clusterGroups := map[string][]*groupPlan{}

	for projectID := range projectBindings {
		clusterID := namespaces.clusterOfProject(projectID)
		if project := data.projects[projectID]; project.ClusterID != "" {
			clusterID = project.ClusterID
		}
		if _, ok := clusterMap[clusterID]; !ok {
			continue
		}
		group := newGroupPlan(data, namespaces, clusterMap, usedNames, projectID, clusterID, prefix)
		groups[projectID] = group
		clusterGroups[clusterID] = append(clusterGroups[clusterID], group)
	}

	// 有集群级绑定的集群：该集群**每个拥有命名空间的项目**都要有组，否则集群级角色
	// 只会在「恰好有项目级成员」的那些项目的命名空间里生效，其余命名空间无人可进。
	// 资源通配 * 的角色不受影响（本来就是整个集群），但喺名资源的集群级角色会。
	for clusterID, bindings := range clusterBindings {
		if len(bindings) == 0 {
			continue
		}
		for _, projectID := range namespaces.projectsOfCluster(clusterID) {
			if _, ok := groups[projectID]; ok {
				continue
			}
			group := newGroupPlan(data, namespaces, clusterMap, usedNames, projectID, clusterID, prefix)
			groups[projectID] = group
			clusterGroups[clusterID] = append(clusterGroups[clusterID], group)
		}
	}

	for clusterID, bindings := range clusterBindings {
		kiteCluster := clusterMap[clusterID]
		targets := clusterGroups[clusterID]
		if len(targets) == 0 {
			if len(namespaces.cluster(clusterID)) == 0 {
				notes = append(notes, fmt.Sprintf(
					"Rancher 集群 %s 只有集群级授权、没有可归属的命名空间，其 %d 条授权未迁移",
					clusterID, len(bindings)))
				continue
			}
			// 该集群没有任何项目（因此没有项目组）：建一个只承载集群级授权的组。
			name := sanitizeName(fmt.Sprintf("%s%s-集群级", prefix, clusterID))
			group := &groupPlan{
				RancherClusterID: clusterID,
				KiteCluster:      kiteCluster,
				Name:             name,
				Description:      fmt.Sprintf("%s：集群 %s 的集群级授权", migrationMarker, clusterID),
				Namespaces:       append([]string(nil), namespaces.cluster(clusterID)...),
			}
			clusterGroups[clusterID] = append(clusterGroups[clusterID], group)
			targets = clusterGroups[clusterID]
			notes = append(notes, fmt.Sprintf(
				"Rancher 集群 %s 没有项目，集群级授权落在新建的「%s」组里", clusterID, name))
		}
		for _, group := range targets {
			for _, binding := range bindings {
				addMember(group, binding, roleByName, prefix)
			}
		}
	}

	for projectID, bindings := range projectBindings {
		group, ok := groups[projectID]
		if !ok {
			continue
		}
		for _, binding := range bindings {
			addMember(group, binding, roleByName, prefix)
		}
	}

	plans := make([]groupPlan, 0, len(groups))
	for _, groupList := range clusterGroups {
		for _, group := range groupList {
			finalizeMembers(group)
			plans = append(plans, *group)
		}
	}
	sort.Slice(plans, func(i, j int) bool {
		if plans[i].KiteCluster != plans[j].KiteCluster {
			return plans[i].KiteCluster < plans[j].KiteCluster
		}
		return plans[i].Name < plans[j].Name
	})
	return plans, notes
}

// newGroupPlan 为某个 Rancher 项目生成一个 Kite 权限绑定组（名称 / 描述 / 命名空间）。
func newGroupPlan(data *rancherData, namespaces *namespaceIndex, clusterMap map[string]string,
	usedNames map[string]map[string]struct{}, projectID, clusterID, prefix string) *groupPlan {
	if usedNames[clusterID] == nil {
		usedNames[clusterID] = map[string]struct{}{}
	}
	name, description := groupName(data.projects[projectID], projectID, clusterID, usedNames[clusterID], prefix)
	return &groupPlan{
		RancherClusterID: clusterID,
		KiteCluster:      clusterMap[clusterID],
		ProjectID:        projectID,
		Name:             name,
		Description:      description,
		Namespaces:       append([]string(nil), namespaces.project(projectID)...),
	}
}

// addMember 把一条 Rancher 绑定落到权限绑定组的成员上。
func addMember(group *groupPlan, binding rancherBinding, roles map[string]roleMapping, prefix string) {
	role := kiteRoleName(prefix, binding.RoleTemplateID)
	if _, ok := roles[role]; !ok {
		return
	}
	source := fmt.Sprintf("集群绑定 %s", binding.RoleTemplateID)
	if binding.Scope == "project" {
		source = fmt.Sprintf("项目绑定 %s", binding.RoleTemplateID)
	}
	for i := range group.Members {
		member := &group.Members[i]
		if member.SubjectType != binding.SubjectType || member.Subject != binding.Subject {
			continue
		}
		if !containsString(member.Roles, role) {
			member.Roles = append(member.Roles, role)
		}
		if !containsString(member.Sources, source) {
			member.Sources = append(member.Sources, source)
		}
		return
	}
	group.Members = append(group.Members, memberPlan{
		SubjectType: binding.SubjectType,
		Subject:     binding.Subject,
		Roles:       []string{role},
		Sources:     []string{source},
	})
}

func finalizeMembers(group *groupPlan) {
	for i := range group.Members {
		sort.Strings(group.Members[i].Roles)
		sort.Strings(group.Members[i].Sources)
	}
	sort.Slice(group.Members, func(i, j int) bool {
		if group.Members[i].SubjectType != group.Members[j].SubjectType {
			return group.Members[i].SubjectType < group.Members[j].SubjectType
		}
		return group.Members[i].Subject < group.Members[j].Subject
	})
}

// templateContext 取角色模板的上下文；Rancher 的自定义模板可能没写，按使用位置推断。
func templateContext(template rancherRoleTemplate, scopes map[string]struct{}) (string, bool) {
	if template.Context == "cluster" || template.Context == "project" {
		return template.Context, false
	}
	if _, ok := scopes["cluster"]; ok {
		return "cluster", true
	}
	return "project", true
}

// resolveKiteCluster 决定一个 Rancher 集群该落到哪个 Kite 集群。
// 显式 -cluster-map 优先；其次按名字（或 Rancher 集群 ID）与 Kite 集群名匹配。
func resolveKiteCluster(cluster rancherCluster, kiteClusters []kiteCluster, explicit map[string]string) (string, bool, string) {
	if mapped, ok := explicit[cluster.ID]; ok {
		if _, exists := findKiteCluster(kiteClusters, mapped); !exists {
			return "", false, fmt.Sprintf("-cluster-map 指定的 Kite 集群 %q 不存在", mapped)
		}
		return mapped, true, ""
	}
	matches := make([]string, 0, 2)
	for _, kiteCluster := range kiteClusters {
		if strings.EqualFold(kiteCluster.Name, cluster.DisplayName) || strings.EqualFold(kiteCluster.Name, cluster.ID) {
			matches = append(matches, kiteCluster.Name)
		}
	}
	switch len(matches) {
	case 0:
		return "", false, fmt.Sprintf("Kite 里没有同名集群（用 -cluster-map %s=<Kite 集群名> 指定）", cluster.ID)
	case 1:
		return matches[0], true, ""
	default:
		sort.Strings(matches)
		return "", false, fmt.Sprintf("Kite 里有多个同名集群（%s），请用 -cluster-map 指定", strings.Join(matches, ", "))
	}
}

func findKiteCluster(clusters []kiteCluster, name string) (kiteCluster, bool) {
	for _, cluster := range clusters {
		if cluster.Name == name {
			return cluster, true
		}
	}
	return kiteCluster{}, false
}

// groupName 生成权限绑定组的名字与描述：默认直接用 Rancher 上的项目名，
// 集群内重名时补上项目 ID 的尾段（p-xxxxx）区分。
func groupName(project rancherProject, projectID, clusterID string, used map[string]struct{}, prefix string) (string, string) {
	base := firstNonEmpty(project.DisplayName, project.Name, projectID)
	name := sanitizeName(prefix + base)
	if _, taken := used[name]; taken {
		suffix := projectID
		if _, tail, ok := strings.Cut(projectID, ":"); ok && tail != "" {
			suffix = tail
		}
		name = sanitizeName(fmt.Sprintf("%s-%s", name, suffix))
	}
	used[name] = struct{}{}

	description := fmt.Sprintf("%s：集群 %s / 项目 %s", migrationMarker, clusterID, projectID)
	if project.DisplayName != "" {
		description += fmt.Sprintf("（%s）", project.DisplayName)
	}
	return name, description
}

// ---------- 输出 ----------

func printPlan(plan *migrationPlan) {
	fmt.Printf("\n=== 集群映射（Rancher → Kite）===\n")
	if len(plan.ClusterMappings) == 0 {
		fmt.Println("  （Rancher 上没有集群）")
	}
	for _, mapping := range plan.ClusterMappings {
		if mapping.KiteCluster == "" {
			fmt.Printf("  %s（%s）→ 未映射\n", mapping.RancherID, mapping.RancherName)
			continue
		}
		fmt.Printf("  %s（%s）→ %s\n", mapping.RancherID, mapping.RancherName, mapping.KiteCluster)
	}

	fmt.Printf("\n=== 角色（%d 个）===\n", len(plan.Roles))
	for _, role := range plan.Roles {
		fmt.Printf("  %s ← %s\n", role.Name, role.Description)
		for _, grant := range role.Grants {
			if grant.Resource == "*" {
				fmt.Printf("      *（集群里的一切资源，含集群级）→ %s\n", strings.Join(grant.Verbs, ","))
				continue
			}
			fmt.Printf("      %s → %s\n", grant.Resource, strings.Join(grant.Verbs, ","))
		}
	}

	memberCount, namespaceCount := 0, 0
	for _, group := range plan.Groups {
		memberCount += len(group.Members)
		namespaceCount += len(group.Namespaces)
	}
	fmt.Printf("\n=== 权限绑定组（%d 个 / 命名空间 %d 个 / 成员 %d 位）===\n",
		len(plan.Groups), namespaceCount, memberCount)
	for _, group := range plan.Groups {
		fmt.Printf("  [Kite 集群 %s] %s（%s）\n", group.KiteCluster, group.Name, group.ProjectID)
		fmt.Printf("      命名空间：%s\n", strings.Join(group.Namespaces, ", "))
		for _, member := range group.Members {
			fmt.Printf("      %s %s → %s\n", subjectLabel(member.SubjectType), member.Subject, strings.Join(member.Roles, ", "))
		}
	}

	if len(plan.Notes) > 0 {
		fmt.Printf("\n=== 提示与跳过项（%d 条）===\n", len(plan.Notes))
		for _, note := range plan.Notes {
			fmt.Printf("  - %s\n", note)
		}
	}
}

func subjectLabel(subjectType string) string {
	if subjectType == "group" {
		return "用户组"
	}
	return "用户  "
}

// ---------- 落库 ----------

func applyPlan(kite *kiteClient, plan *migrationPlan, opts options) error {
	if len(plan.Roles) == 0 && len(plan.Groups) == 0 {
		fmt.Println("  计划里没有任何要写入的内容。")
		return nil
	}

	// 1. 角色：名称与手工角色可能同名，靠描述里的迁移标记判断归属，非本工具建的不覆盖。
	existingRoles, err := kite.roles()
	if err != nil {
		return fmt.Errorf("读取 Kite 角色失败：%w", explainAuthError(err))
	}
	existingByName := map[string]kiteRole{}
	for _, role := range existingRoles {
		existingByName[role.Name] = role
	}
	roleIDs, err := ensureRoles(kite, plan.Roles, existingByName)
	if err != nil {
		return err
	}

	// 2. 权限绑定组：按 (集群, 名称) 复用，命名空间与成员默认与既有配置取并集。
	existingGroups, err := kite.bindingGroups()
	if err != nil {
		return fmt.Errorf("读取 Kite 权限绑定组失败：%w", explainAuthError(err))
	}
	groupsByKey := map[string]kiteBindingGroup{}
	for _, group := range existingGroups {
		groupsByKey[group.Cluster+"\x00"+group.Name] = group
	}

	knownUsers := map[string]struct{}{}
	checkUsers := false
	if hasUserSubjects(plan) {
		users, err := kite.usernames()
		switch err {
		case nil:
			knownUsers, checkUsers = users, true
		default:
			// 读用户列表需要 settings.users 权限，而迁移只需要 settings.rbac；
			// 拿不到时少做一项提醒，不影响迁移本身。
			fmt.Fprintf(os.Stderr, "  ! 无法读取 Kite 用户列表（%v），跳过「账号是否已存在」的检查\n", err)
		}
	}

	unknownUsers := map[string]struct{}{}
	failed := make([]string, 0)
	for _, group := range plan.Groups {
		current, exists := groupsByKey[group.KiteCluster+"\x00"+group.Name]
		if !exists {
			created, err := kite.createBindingGroup(group.KiteCluster, group.Name, group.Description)
			if err != nil {
				failed = append(failed, fmt.Sprintf("创建权限绑定组 %s 失败：%v", group.Name, err))
				continue
			}
			current = created
			fmt.Printf("  + 权限绑定组 [%s] %s\n", group.KiteCluster, group.Name)
		} else {
			fmt.Printf("  = 权限绑定组 [%s] %s 已存在，按并集补齐\n", group.KiteCluster, group.Name)
			if !isMigrated(current.Description, group.Description) {
				// 名称就是 Rancher 的项目名，与手工建的组可能撞名：合并是期望行为，但要提醒。
				fmt.Printf("      ! 该组不是本工具建的（描述：%s），本步会与它合并成员与命名空间\n", truncate(current.Description, 60))
			}
		}

		if message := syncNamespaces(kite, current, group, opts); message != "" {
			failed = append(failed, message)
			continue
		}
		message, missing := syncMembers(kite, current, group, roleIDs, opts, knownUsers, checkUsers)
		if message != "" {
			failed = append(failed, message)
			continue
		}
		for _, user := range missing {
			unknownUsers[user] = struct{}{}
		}
	}

	if len(unknownUsers) > 0 {
		users := make([]string, 0, len(unknownUsers))
		for user := range unknownUsers {
			users = append(users, user)
		}
		sort.Strings(users)
		fmt.Printf("\n  ! 以下账号在 Kite 里还不存在，绑定已写入、首次登录后即生效：%s\n", strings.Join(users, ", "))
	}

	if len(failed) > 0 {
		for _, message := range failed {
			fmt.Fprintf(os.Stderr, "  ❌ %s\n", message)
		}
		return fmt.Errorf("%d 个权限绑定组未能写入（见上面的错误；修正后重跑即可，已写入的部分不会重复）", len(failed))
	}

	fmt.Println("\n✅ 迁移完成。请在 Kite 控制台「系统设置 → 权限管理」复核授权结果。")
	return nil
}

// ensureRoles 创建 / 对齐计划里的角色，返回角色名 → 角色 ID。
func ensureRoles(kite *kiteClient, roles []roleMapping, existing map[string]kiteRole) (map[string]uint, error) {
	roleIDs := map[string]uint{}
	for _, mapping := range roles {
		current, exists := existing[mapping.Name]
		if !exists {
			created, err := kite.createRole(mapping)
			if err != nil {
				return nil, fmt.Errorf("创建角色 %s 失败：%w", mapping.Name, explainAuthError(err))
			}
			roleIDs[mapping.Name] = created.ID
			fmt.Printf("  + 角色 %s（%d 条授权）\n", mapping.Name, len(mapping.Grants))
			continue
		}
		roleIDs[mapping.Name] = current.ID
		switch {
		case current.IsSystem:
			fmt.Printf("  ! 角色 %s 已存在且是内置角色，跳过不改动\n", mapping.Name)
		case !isMigrated(current.Description, mapping.Description):
			// 同名但不是本工具建的（名称默认就是角色模板名，可能与管理员的角色撞名）：
			// 只报告、不覆盖，避免把手工配置的授权改掉。
			fmt.Printf("  ! 角色 %s 已存在且不是本工具建的（描述不符），跳过不改动；如需它按迁移口径重建，请先自行处理同名角色\n", mapping.Name)
		case grantsEqual(current.Grants, mapping.Grants):
			fmt.Printf("  = 角色 %s 已是最新\n", mapping.Name)
		default:
			if err := kite.updateRole(current.ID, mapping); err != nil {
				return nil, fmt.Errorf("更新角色 %s 失败：%w", mapping.Name, explainAuthError(err))
			}
			fmt.Printf("  ~ 角色 %s 已更新（%d 条授权）\n", mapping.Name, len(mapping.Grants))
		}
	}
	return roleIDs, nil
}

// syncNamespaces 把计划的命名空间写进绑定组；默认与既有命名空间取并集。
// 返回非空字符串表示这一步失败（调用方收集后统一报告）。
func syncNamespaces(kite *kiteClient, current kiteBindingGroup, group groupPlan, opts options) string {
	existing := namespaceNames(current.Namespaces)
	namespaces := group.Namespaces
	if !opts.replaceNamespaces {
		namespaces = unionStrings(namespaces, existing)
	}
	if sameStringSet(existing, namespaces) {
		return ""
	}
	if err := kite.setBindingGroupNamespaces(current.ID, namespaces); err != nil {
		return fmt.Sprintf("设置权限绑定组 %s 的命名空间失败：%v", group.Name, err)
	}
	fmt.Printf("      ~ 命名空间 %d 个\n", len(namespaces))
	return ""
}

// syncMembers 把计划的成员写进绑定组；返回错误说明（空表示成功）与 Kite 里还不存在的账号。
func syncMembers(kite *kiteClient, current kiteBindingGroup, group groupPlan, roleIDs map[string]uint,
	opts options, knownUsers map[string]struct{}, checkUsers bool) (string, []string) {
	members, err := kite.bindingGroupMembers(current.ID)
	if err != nil {
		return fmt.Sprintf("读取权限绑定组 %s 的成员失败：%v", group.Name, err), nil
	}
	inputs, changed, missing := mergeMembers(members, group, roleIDs, opts, knownUsers, checkUsers)
	if !changed {
		fmt.Printf("      = 成员无变化\n")
		return "", missing
	}
	if err := kite.setBindingGroupMembers(current.ID, inputs); err != nil {
		return fmt.Sprintf("设置权限绑定组 %s 的成员失败：%v", group.Name, err), nil
	}
	fmt.Printf("      ~ 成员 %d 位\n", len(inputs))
	return "", missing
}

func hasUserSubjects(plan *migrationPlan) bool {
	for _, group := range plan.Groups {
		for _, member := range group.Members {
			if member.SubjectType == "user" {
				return true
			}
		}
	}
	return false
}

// mergeMembers 把计划里的成员合并进既有成员（默认并集，-replace-members 则全量覆盖），
// 返回写入入参、是否需要写入，以及 Kite 里还不存在的用户名（checkUsers 为 false 时不检查）。
func mergeMembers(existing []kiteMember, group groupPlan, roleIDs map[string]uint, opts options,
	knownUsers map[string]struct{}, checkUsers bool) ([]kiteMemberInput, bool, []string) {
	current := memberInputsFromExisting(existing)
	planned := make([]kiteMemberInput, 0, len(group.Members))
	missingUsers := make([]string, 0)
	for _, member := range group.Members {
		if checkUsers && member.SubjectType == "user" {
			if _, ok := knownUsers[member.Subject]; !ok {
				missingUsers = append(missingUsers, member.Subject)
			}
		}
		ids := make([]uint, 0, len(member.Roles))
		for _, roleName := range member.Roles {
			if roleID, ok := roleIDs[roleName]; ok {
				ids = append(ids, roleID)
			}
		}
		if len(ids) == 0 {
			continue
		}
		planned = append(planned, kiteMemberInput{
			SubjectType: member.SubjectType,
			Subject:     member.Subject,
			Namespace:   "",
			RoleIDs:     ids,
		})
	}

	desired := planned
	if !opts.replaceMembers {
		desired = unionMembers(current, planned)
	}
	return desired, !sameMembers(current, desired), missingUsers
}

// memberInputsFromExisting 把 Kite 里既有的成员行按「主体 × 命名空间范围」归并。
func memberInputsFromExisting(existing []kiteMember) []kiteMemberInput {
	index := map[string]int{}
	inputs := make([]kiteMemberInput, 0, len(existing))
	for _, member := range existing {
		key := member.SubjectType + "\x00" + member.Subject + "\x00" + member.Namespace
		position, ok := index[key]
		if !ok {
			inputs = append(inputs, kiteMemberInput{
				SubjectType: member.SubjectType,
				Subject:     member.Subject,
				Namespace:   member.Namespace,
			})
			position = len(inputs) - 1
			index[key] = position
		}
		inputs[position].RoleIDs = append(inputs[position].RoleIDs, member.RoleID)
	}
	return normalizeMembers(inputs)
}

func unionMembers(base, extra []kiteMemberInput) []kiteMemberInput {
	index := map[string]int{}
	merged := make([]kiteMemberInput, 0, len(base)+len(extra))
	for _, group := range [][]kiteMemberInput{base, extra} {
		for _, member := range group {
			key := member.SubjectType + "\x00" + member.Subject + "\x00" + member.Namespace
			position, ok := index[key]
			if !ok {
				merged = append(merged, kiteMemberInput{
					SubjectType: member.SubjectType,
					Subject:     member.Subject,
					Namespace:   member.Namespace,
				})
				position = len(merged) - 1
				index[key] = position
			}
			merged[position].RoleIDs = append(merged[position].RoleIDs, member.RoleIDs...)
		}
	}
	return normalizeMembers(merged)
}

func normalizeMembers(members []kiteMemberInput) []kiteMemberInput {
	for i := range members {
		seen := map[uint]struct{}{}
		ids := make([]uint, 0, len(members[i].RoleIDs))
		for _, id := range members[i].RoleIDs {
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
		sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
		members[i].RoleIDs = ids
	}
	sort.Slice(members, func(i, j int) bool {
		left := members[i].SubjectType + "\x00" + members[i].Subject + "\x00" + members[i].Namespace
		right := members[j].SubjectType + "\x00" + members[j].Subject + "\x00" + members[j].Namespace
		return left < right
	})
	return members
}

func sameMembers(a, b []kiteMemberInput) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].SubjectType != b[i].SubjectType || a[i].Subject != b[i].Subject || a[i].Namespace != b[i].Namespace {
			return false
		}
		if len(a[i].RoleIDs) != len(b[i].RoleIDs) {
			return false
		}
		for j := range a[i].RoleIDs {
			if a[i].RoleIDs[j] != b[i].RoleIDs[j] {
				return false
			}
		}
	}
	return true
}

// cleanupByPrefix 删除本工具创建的角色与绑定组（-prefix 非空时按名字前缀圈定）。
// 不加 -yes 时只打印会删哪些，不动手。
func cleanupByPrefix(kite *kiteClient, opts options) error {
	preview := !opts.yes
	roles, err := kite.roles()
	if err != nil {
		return fmt.Errorf("读取 Kite 角色失败：%w", explainAuthError(err))
	}
	removedRoles := 0
	for _, role := range roles {
		if !strings.HasPrefix(role.Name, opts.prefix) || role.IsSystem {
			continue
		}
		removedRoles++
		fmt.Printf("  - 角色 %s\n", role.Name)
		if preview {
			continue
		}
		if err := kite.deleteRole(role.ID); err != nil {
			fmt.Fprintf(os.Stderr, "  ❌ 删除角色 %s 失败：%v\n", role.Name, err)
			removedRoles--
		}
	}

	groups, err := kite.bindingGroups()
	if err != nil {
		return fmt.Errorf("读取 Kite 权限绑定组失败：%w", explainAuthError(err))
	}
	removedGroups := 0
	for _, group := range groups {
		if !strings.HasPrefix(group.Name, opts.prefix) || group.Protected {
			continue
		}
		removedGroups++
		fmt.Printf("  - 权限绑定组 [%s] %s\n", group.Cluster, group.Name)
		if preview {
			continue
		}
		if err := kite.deleteBindingGroup(group.ID); err != nil {
			fmt.Fprintf(os.Stderr, "  ❌ 删除权限绑定组 [%s] %s 失败：%v\n", group.Cluster, group.Name, err)
			removedGroups--
		}
	}
	if preview {
		return previewCleanupError(opts.prefix, removedRoles, removedGroups)
	}
	fmt.Printf("\n已删除角色 %d 个、权限绑定组 %d 个。\n", removedRoles, removedGroups)
	return nil
}

// previewCleanupError 统一「预览完了、要确认」的出口：已经列了清单，就不再动手。
func previewCleanupError(prefix string, roles, groups int) error {
	scope := "本次计划对应的"
	if prefix != "" {
		scope = fmt.Sprintf("%q 前缀下的", prefix)
	}
	return fmt.Errorf("上面是 -cleanup 会删除的 %s角色 %d 个与权限绑定组 %d 个（尚未删除）；确认后加上 -yes 再执行",
		scope, roles, groups)
}

// cleanupPlan 按计划定位并删除本工具创建的对象。
// 名称默认就是项目名 / 角色模板名，与手工对象可能同名，所以这里只删描述里带迁移标记的那些：
// 同名但描述不对的对象视为管理员的，跳过并报告。
// 不加 -yes 时只把会删的对象列出来，不动手。
func cleanupPlan(kite *kiteClient, plan *migrationPlan, opts options) error {
	preview := !opts.yes
	roles, err := kite.roles()
	if err != nil {
		return fmt.Errorf("读取 Kite 角色失败：%w", explainAuthError(err))
	}
	plannedRoles := make(map[string]string, len(plan.Roles))
	for _, role := range plan.Roles {
		plannedRoles[role.Name] = role.Description
	}
	removedRoles, skippedRoles := 0, 0
	for _, role := range roles {
		description, planned := plannedRoles[role.Name]
		if !planned || role.IsSystem {
			continue
		}
		if !isMigrated(role.Description, description) {
			skippedRoles++
			fmt.Printf("  ! 角色 %s 同名但不是本工具建的（描述不符），跳过\n", role.Name)
			continue
		}
		removedRoles++
		fmt.Printf("  - 角色 %s\n", role.Name)
		if preview {
			continue
		}
		if err := kite.deleteRole(role.ID); err != nil {
			fmt.Fprintf(os.Stderr, "  ❌ 删除角色 %s 失败：%v\n", role.Name, err)
			removedRoles--
		}
	}

	groups, err := kite.bindingGroups()
	if err != nil {
		return fmt.Errorf("读取 Kite 权限绑定组失败：%w", explainAuthError(err))
	}
	plannedGroups := make(map[string]string, len(plan.Groups))
	for _, group := range plan.Groups {
		plannedGroups[group.KiteCluster+"\x00"+group.Name] = group.Description
	}
	removedGroups, skippedGroups := 0, 0
	for _, group := range groups {
		description, planned := plannedGroups[group.Cluster+"\x00"+group.Name]
		if !planned || group.Protected {
			continue
		}
		if !isMigrated(group.Description, description) {
			skippedGroups++
			fmt.Printf("  ! 权限绑定组 [%s] %s 同名但不是本工具建的（描述不符），跳过\n", group.Cluster, group.Name)
			continue
		}
		removedGroups++
		fmt.Printf("  - 权限绑定组 [%s] %s\n", group.Cluster, group.Name)
		if preview {
			continue
		}
		if err := kite.deleteBindingGroup(group.ID); err != nil {
			fmt.Fprintf(os.Stderr, "  ❌ 删除权限绑定组 [%s] %s 失败：%v\n", group.Cluster, group.Name, err)
			removedGroups--
		}
	}

	if preview {
		if skippedRoles+skippedGroups > 0 {
			fmt.Printf("\n同名但非本工具创建的已跳过 %d 个角色 / %d 个绑定组（未动）。\n", skippedRoles, skippedGroups)
		}
		return previewCleanupError("", removedRoles, removedGroups)
	}
	fmt.Printf("\n已删除角色 %d 个、权限绑定组 %d 个", removedRoles, removedGroups)
	if skippedRoles+skippedGroups > 0 {
		fmt.Printf("；同名但非本工具创建的已跳过 %d 个角色 / %d 个绑定组（未动）", skippedRoles, skippedGroups)
	}
	fmt.Println("。")
	return nil
}

// isMigrated 判断一个已存在的对象是否由本工具创建：描述里带迁移标记，或与计划描述完全一致。
func isMigrated(existing, planned string) bool {
	if strings.Contains(existing, migrationMarker) {
		return true
	}
	return planned != "" && strings.TrimSpace(existing) == strings.TrimSpace(planned)
}

// ---------- 小工具 ----------

func grantsEqual(a, b []common.ResourceGrant) bool {
	normalize := func(grants []common.ResourceGrant) map[string]string {
		out := make(map[string]string, len(grants))
		for _, grant := range grants {
			verbs := append([]string(nil), grant.Verbs...)
			sort.Strings(verbs)
			out[grant.Resource] = strings.Join(verbs, ",")
		}
		return out
	}
	left, right := normalize(a), normalize(b)
	if len(left) != len(right) {
		return false
	}
	for resource, verbs := range left {
		if right[resource] != verbs {
			return false
		}
	}
	return true
}

func namespaceNames(refs []kiteNamespaceRef) []string {
	names := make([]string, 0, len(refs))
	for _, ref := range refs {
		names = append(names, ref.Namespace)
	}
	return names
}

func unionStrings(base, extra []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(base)+len(extra))
	for _, group := range [][]string{base, extra} {
		for _, value := range group {
			if value == "" {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	left := append([]string(nil), a...)
	right := append([]string(nil), b...)
	sort.Strings(left)
	sort.Strings(right)
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
