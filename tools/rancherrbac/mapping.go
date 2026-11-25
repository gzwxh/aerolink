package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/gzwxh/aerolink/pkg/common"
)

// 本文件是纯粹的角色规则映射：把 Rancher 角色模板的 RBAC 规则翻成鸢联 AeroLink 角色的
// 「资源 × 操作」。它是整次迁移里最容易出错、也最需要单测的部分，因此不碰网络与文件。
//
// 迁移口径（取值理由见 docs/dev/plans/2026-09-21-Rancher授权迁移脚本.md）：
//   - 角色模板里资源通配 `*` 在 project 上下文下**必须展开**成具体命名空间级资源：
//    鸢联 AeroLink 权限绑定组里 `*` 的语义是「集群里的一切资源」，照搬会把项目级只读权限
//     放大成整个集群的只读权限。
//   - 只有 apiGroups 也是 `*` 时才能用鸢联 AeroLink 的资源通配；具体 API 组的 `*` 按组展开。
//   - 集群级资源（nodes、namespaces 等）在权限绑定组里授不出去（见
//     pkg/rbac/binding_group.go 的说明），点名列出时只记录、不写进角色。
//   - Rancher 在内置项目角色之外还会绑一个 Kubernetes 内置角色（admin / edit / view），
//     那部分权限必须一并补上，见 rancherBuiltinEquivalent。

// aerolinkVerbs 是鸢联 AeroLink 的全部操作（见 pkg/common/rbac.go）。
var aerolinkVerbs = []string{
	string(common.VerbGet),
	string(common.VerbCreate),
	string(common.VerbUpdate),
	string(common.VerbDelete),
	string(common.VerbLog),
	string(common.VerbExec),
	string(common.VerbViewFile),
	string(common.VerbDownloadFile),
	string(common.VerbUploadFile),
}

// podWriteVerbs 是 Pod 上「写」类的专用操作：与 Kubernetes 的 pods/exec、attach、
// portforward 对应（容器文件读写不单独存在于 k8s RBAC，但 Rancher 的 edit/admin 实际上
// 允许终端，因此一并给出）。
var podWriteVerbs = []string{
	string(common.VerbExec),
	string(common.VerbViewFile),
	string(common.VerbDownloadFile),
	string(common.VerbUploadFile),
}

// podOnlyVerbs 是只对 Pod 成立的操作：容器日志、终端与容器文件。
var podOnlyVerbs = []string{
	string(common.VerbLog),
	string(common.VerbExec),
	string(common.VerbViewFile),
	string(common.VerbDownloadFile),
	string(common.VerbUploadFile),
}

// rancherVerbAlias 把 Rancher（即 Kubernetes）的操作名映射到鸢联 AeroLink 的操作。
// list / watch 在鸢联 AeroLink 里并入 get（鸢联 AeroLink 的读权限就是读），deletecollection 并入 delete。
var rancherVerbAlias = map[string]string{
	"get":              string(common.VerbGet),
	"list":             string(common.VerbGet),
	"watch":            string(common.VerbGet),
	"create":           string(common.VerbCreate),
	"update":           string(common.VerbUpdate),
	"patch":            string(common.VerbUpdate),
	"delete":           string(common.VerbDelete),
	"deletecollection": string(common.VerbDelete),
}

// podSubresourceVerbs 把 pod 子资源映射到鸢联 AeroLink 的专用操作；
// 未列出的子资源（如 status、ephemeralcontainers）鸢联 AeroLink 不单独授权，直接跳过。
var podSubresourceVerbs = map[string]string{
	"log":          string(common.VerbLog),
	"exec":         string(common.VerbExec),
	"attach":       string(common.VerbExec),
	"portforward":  string(common.VerbExec),
	"port-forward": string(common.VerbExec),
}

// podSubresourceVerbAllowed 报告某条子资源规则在 Rancher 里是否真的给了对应操作。
// 注意不能拿映射后的鸢联 AeroLink 操作去比对：Rancher 侧的 exec / attach 是 create，
// 日志是 get，这些词汇在鸢联 AeroLink 里叫 exec / log。
func podSubresourceVerbAllowed(subresource string, rancherVerbs []string) bool {
	write := subresource != "log"
	for _, verb := range rancherVerbs {
		if verb == "*" {
			return true
		}
		switch verb {
		case "get", "list", "watch":
			if !write {
				return true
			}
		case "create", "update", "patch", "delete", "deletecollection":
			if write {
				return true
			}
		}
	}
	return false
}

// rancherRule 是角色模板里的一条 RBAC 规则，字段与 Rancher 的一致。
type rancherRule struct {
	APIGroups       []string
	Resources       []string
	Verbs           []string
	ResourceNames   []string
	NonResourceURLs []string
}

// rancherRoleTemplate 是迁移关心的角色模板字段。
type rancherRoleTemplate struct {
	ID          string
	DisplayName string
	// Context 是 "cluster" 或 "project"；Rancher 的自定义模板可能为空，由调用方推断。
	Context string
	Rules   []rancherRule
}

type mappingOptions struct {
	// AllowResourceNameWidening 允许把带 resourceNames 的规则放宽到整个资源类型。
	// 默认关闭：鸢联 AeroLink 无法表达「只对某个具体对象」，放宽等于提权。
	AllowResourceNameWidening bool
	// NamePrefix 是生成的角色名前缀（默认空，直接用角色模板名）。
	NamePrefix string
}

// roleMapping 是一次角色模板映射的结果：鸢联 AeroLink 角色定义 + 映射过程中的说明。
type roleMapping struct {
	Name        string                 `json:"name"`
	DisplayName string                 `json:"displayName"`
	Description string                 `json:"description"`
	Grants      []common.ResourceGrant `json:"grants"`
	// Notes 记录被丢弃或放宽的规则，供迁移报告展示。
	Notes []string `json:"notes,omitempty"`
}

// resourceIndex 是鸢联 AeroLink 已知资源的索引，按 pkg/common/resource.go 的 Registry 构建。
type resourceIndex struct {
	byPlural          map[string]common.ResourceMeta
	namespaced        []string
	namespacedByGroup map[string][]string
}

func newResourceIndex() *resourceIndex {
	index := &resourceIndex{
		byPlural:          make(map[string]common.ResourceMeta, len(common.Registry)),
		namespacedByGroup: map[string][]string{},
	}
	for _, meta := range common.Registry {
		plural := string(meta.Plural)
		if _, exists := index.byPlural[plural]; !exists {
			index.byPlural[plural] = meta
		}
		if meta.ClusterScoped {
			continue
		}
		index.namespaced = append(index.namespaced, plural)
		index.namespacedByGroup[meta.Group] = append(index.namespacedByGroup[meta.Group], plural)
	}
	return index
}

// lookup 按 Rancher 规则里的资源名找鸢联 AeroLink 资源元数据。
// 个别资源在两个体系里叫法不同（metrics.k8s.io 的 pods 在鸢联 AeroLink 是 podmetrics），
// 先查别名表。
func (index *resourceIndex) lookup(group, resource string) (common.ResourceMeta, bool) {
	if alias, ok := resourceAliases[group+"/"+resource]; ok {
		resource = alias
	}
	meta, ok := index.byPlural[resource]
	return meta, ok
}

// resourceAliases 处理「同一个资源、不同叫法」：键是 "apiGroup/资源名"。
var resourceAliases = map[string]string{
	"metrics.k8s.io/pods":  string(common.PodMetrics),
	"metrics.k8s.io/nodes": string(common.NodeMetrics),
}

// rancherBuiltinEquivalent 是「Rancher 内置角色模板 → Kubernetes 内置角色」的对应关系。
//
// 现场核对（rancher.gogdev.cn，2026-09-21）：Rancher 在命名空间里除了绑自己生成的同名
// ClusterRole（规则就是 roleTemplate 的 rules），**还会再绑一个 Kubernetes 内置角色**：
//
//	project-owner  → admin        （命名空间内全部权限，含 roles / rolebindings）
//	project-member → edit         （除 roles / rolebindings 之外的读写，含 secrets）
//	read-only      → view         （只读，不含 secrets）
//	cluster-member → view         （集群级，ClusterRoleBinding 名为 <user>-view）
//
// 只看 roleTemplate.rules 会漏掉这一半——那正是「项目成员在 Rancher 里能干活、
// 在迁移后的鸢联 AeroLink 里却动不了工作负载」的根因。
type builtinRule struct {
	KubernetesRole string
	Context        string
}

var rancherBuiltinEquivalent = map[string]builtinRule{
	"project-owner":  {KubernetesRole: "admin", Context: "project"},
	"project-member": {KubernetesRole: "edit", Context: "project"},
	"read-only":      {KubernetesRole: "view", Context: "project"},
	"cluster-member": {KubernetesRole: "view", Context: "cluster"},
}

// builtinEquivalent 描述一个 Kubernetes 内置角色对应到鸢联 AeroLink 的操作与排除项。
type builtinEquivalent struct {
	verbs    []string
	excluded map[string]struct{}
}

var builtinEquivalents = map[string]builtinEquivalent{
	// admin：命名空间里的一切（含 secrets、roles、rolebindings）。
	"admin": {
		verbs: []string{
			string(common.VerbGet), string(common.VerbCreate),
			string(common.VerbUpdate), string(common.VerbDelete),
		},
	},
	// edit：与 admin 的差别就是不能改 roles / rolebindings（k8s 内置定义如此）。
	"edit": {
		verbs: []string{
			string(common.VerbGet), string(common.VerbCreate),
			string(common.VerbUpdate), string(common.VerbDelete),
		},
		excluded: map[string]struct{}{
			string(common.Roles):        {},
			string(common.RoleBindings): {},
		},
	},
	// view：只读，且 k8s 内置 view 不包含 secrets。
	"view": {
		verbs:    []string{string(common.VerbGet)},
		excluded: map[string]struct{}{string(common.Secrets): {}},
	},
}

// addBuiltinEquivalent 把 Rancher 额外绑定的 Kubernetes 内置角色并入授权。
func (index *resourceIndex) addBuiltinEquivalent(grants *grantBuilder, kubernetesRole, context string) {
	equiv, ok := builtinEquivalents[kubernetesRole]
	if !ok {
		return
	}
	verbs := append([]string(nil), equiv.verbs...)
	if containsString(verbs, string(common.VerbGet)) {
		// 容器日志是只读观测数据，内置 view 也包含 pods/log。
		verbs = append(verbs, string(common.VerbLog))
	}
	if hasWriteVerb(equiv.verbs) {
		// admin / edit 包含 pods/exec、attach、portforward：
		// 在鸢联 AeroLink 里对应终端与容器文件操作。
		verbs = append(verbs, podWriteVerbs...)
	}

	if context == "cluster" {
		// 集群级：鸢联 AeroLink 只有资源通配 * 能覆盖集群级资源（节点、PV 等）。
		// 被排除的资源用否定模式表达，与内置「只读管理员」同一套写法（见 model.denyPatterns）。
		for _, verb := range verbs {
			grants.add("*", verb)
		}
		for excluded := range equiv.excluded {
			for _, verb := range verbs {
				grants.add("!"+excluded, verb)
			}
		}
		return
	}

	for _, resource := range index.namespaced {
		if _, excluded := equiv.excluded[resource]; excluded {
			continue
		}
		for _, verb := range verbsForResource(resource, verbs) {
			grants.add(resource, verb)
		}
	}
}

func hasWriteVerb(verbs []string) bool {
	for _, verb := range []string{string(common.VerbCreate), string(common.VerbUpdate), string(common.VerbDelete)} {
		if containsString(verbs, verb) {
			return true
		}
	}
	return false
}

// mapRoleTemplate 把一个 Rancher 角色模板映射成鸢联 AeroLink 角色定义。
// context 取 "project" 或 "cluster"，决定资源通配 `*` 怎么处理。
func (index *resourceIndex) mapRoleTemplate(template rancherRoleTemplate, context string, opts mappingOptions) roleMapping {
	grants := newGrantBuilder()
	notes := make([]string, 0)
	notef := func(format string, args ...any) {
		notes = append(notes, fmt.Sprintf(format, args...))
	}

	for _, rule := range template.Rules {
		if len(rule.Resources) == 0 {
			// 只针对非资源 URL（/healthz 之类）的规则，鸢联 AeroLink 没有对应概念。
			if len(rule.NonResourceURLs) > 0 {
				notef("跳过非资源 URL 规则：%s", strings.Join(rule.NonResourceURLs, ", "))
			}
			continue
		}
		if len(rule.ResourceNames) > 0 && !opts.AllowResourceNameWidening {
			notef("跳过限定对象名的规则（resourceNames=%s）：AeroLink 无法按对象名授权，放宽等于提权",
				strings.Join(rule.ResourceNames, ", "))
			continue
		}
		verbs, unknown := aerolinkVerbsOf(rule.Verbs)
		if len(unknown) > 0 {
			notef("忽略无法映射的操作：%s", strings.Join(unknown, ", "))
		}
		if len(verbs) == 0 {
			continue
		}
		groups := rule.APIGroups
		if len(groups) == 0 {
			groups = []string{""}
		}
		for _, resource := range rule.Resources {
			if base, sub, ok := strings.Cut(resource, "/"); ok {
				if verb, known := podSubresourceVerbs[sub]; known && base == string(common.Pods) && podSubresourceVerbAllowed(sub, rule.Verbs) {
					grants.add(base, verb)
				} else {
					notef("跳过子资源规则 %s/%s", base, sub)
				}
				continue
			}
			if resource == "*" {
				index.addWildcard(grants, groups, verbs, context, notef)
				continue
			}

			// 必须逐（API 组 × 资源名）解析：别名会把同一个资源名指向不同的鸢联 AeroLink 资源
			// （metrics.k8s.io 的 pods 在鸢联 AeroLink 是 podmetrics），先查资源名再看组会错。
			resolved := false
			for _, group := range groups {
				meta, known := index.lookup(group, resource)
				if !known || !groupsMatch([]string{group}, meta.Group) {
					continue
				}
				resolved = true
				if meta.ClusterScoped {
					notef("记录但不生效：%s 是集群级资源，权限绑定组无法授予（只有资源通配 * 的授权能覆盖它）", resource)
					continue
				}
				plural := string(meta.Plural)
				for _, verb := range verbsForResource(plural, verbs) {
					grants.add(plural, verb)
				}
			}
			if !resolved {
				notef("跳过 AeroLink 未收录的资源 %s（apiGroups=%s，控制台没有这个资源面）",
					resource, strings.Join(groups, ", "))
			}
		}
	}

	// Rancher 还会额外绑一个 Kubernetes 内置角色（admin / edit / view），
	// 那部分权限不在 roleTemplate.rules 里，必须一并补上。
	if rule, ok := rancherBuiltinEquivalent[template.ID]; ok && rule.Context == context {
		index.addBuiltinEquivalent(grants, rule.KubernetesRole, context)
		notef("按 Rancher 的实际绑定补齐 Kubernetes 内置角色 %s 的权限（roleTemplate.rules 里没有这一半）",
			rule.KubernetesRole)
	}

	// 只读授权补上容器日志：鸢联 AeroLink 的内置「只读管理员」同样把 get 与 log 放在一起
	// （见 pkg/model/rbac.go），迁移过来的只读账号在 Rancher 上看得到的日志
	// 不应该在鸢联 AeroLink 上变成 403。
	if grants.has(string(common.Pods), string(common.VerbGet)) {
		grants.add(string(common.Pods), string(common.VerbLog))
	}

	return roleMapping{
		Name:        aerolinkRoleName(opts.NamePrefix, template.ID),
		DisplayName: templateDisplayName(template),
		Description: fmt.Sprintf("%s：角色模板 %s（%s 上下文）", migrationMarker, template.ID, context),
		Grants:      grants.grants(),
		Notes:       notes,
	}
}

// addWildcard 处理资源通配 `*`：
//
//   - 只有 **apiGroups 也是通配** 的规则才代表「集群里的一切资源」。cluster 上下文的这种
//     规则保留成鸢联 AeroLink 的资源通配（作用域就是整个集群）；project 上下文展开成命名空间级资源。
//   - apiGroups 是具体组（例如 rke-machine-config.cattle.io）时，`*` 只覆盖该组的资源，
//     绝不能偷懒成鸢联 AeroLink 的 `*`——那会把一个 Rancher 专有的只读规则放大成整个集群。
//     这时按组展开成鸢联 AeroLink 收录的命名空间级资源；鸢联 AeroLink 没收录则跳过并说明。
func (index *resourceIndex) addWildcard(grants *grantBuilder, groups, verbs []string, context string, notef func(string, ...any)) {
	global := false
	for _, group := range groups {
		if group == "*" {
			global = true
			break
		}
	}

	if global {
		if context == "cluster" {
			for _, verb := range verbs {
				grants.add("*", verb)
			}
			return
		}
		for _, resource := range index.namespaced {
			for _, verb := range verbsForResource(resource, verbs) {
				grants.add(resource, verb)
			}
		}
		return
	}

	matched := false
	for _, group := range groups {
		for _, resource := range index.namespacedByGroup[group] {
			for _, verb := range verbsForResource(resource, verbs) {
				grants.add(resource, verb)
			}
			matched = true
		}
	}
	if !matched {
		notef("跳过 apiGroups=%s 的资源通配规则：只覆盖 Rancher 专有 API 组，鸢联 AeroLink 没有对应资源面",
			strings.Join(groups, ", "))
	}
}

// verbsForResource 去掉只对 Pod 成立的操作（容器日志 / 终端 / 容器文件），
// 否则资源通配的规则会把它们顺带发给每一个资源。
func verbsForResource(resource string, verbs []string) []string {
	if resource == string(common.Pods) {
		return verbs
	}
	filtered := make([]string, 0, len(verbs))
	for _, verb := range verbs {
		if !containsString(podOnlyVerbs, verb) {
			filtered = append(filtered, verb)
		}
	}
	return filtered
}

// groupsMatch 报告某条规则的 apiGroups 是否能覆盖鸢联 AeroLink 资源所属的 API 组。
func groupsMatch(groups []string, resourceGroup string) bool {
	for _, group := range groups {
		// Rancher 规则里 "extensions" 一类历史组名如今没有对应资源：不匹配即为不授权。
		if group == "*" || group == resourceGroup {
			return true
		}
	}
	return false
}

// aerolinkVerbsOf 把 Rancher 的一串操作映射成鸢联 AeroLink 操作；返回无法映射的那些。
func aerolinkVerbsOf(rancherVerbs []string) ([]string, []string) {
	verbs := make([]string, 0, len(rancherVerbs))
	unknown := make([]string, 0)
	for _, verb := range rancherVerbs {
		if verb == "*" {
			for _, aerolinkVerb := range aerolinkVerbs {
				if !containsString(verbs, aerolinkVerb) {
					verbs = append(verbs, aerolinkVerb)
				}
			}
			continue
		}
		mapped, ok := rancherVerbAlias[verb]
		if !ok {
			unknown = append(unknown, verb)
			continue
		}
		if !containsString(verbs, mapped) {
			verbs = append(verbs, mapped)
		}
	}
	return verbs, unknown
}

// grantBuilder 按资源累积操作集合，输出时保持稳定顺序。
type grantBuilder struct {
	order []string
	verbs map[string]map[string]struct{}
}

func newGrantBuilder() *grantBuilder {
	return &grantBuilder{verbs: map[string]map[string]struct{}{}}
}

func (b *grantBuilder) add(resource, verb string) {
	if _, ok := b.verbs[resource]; !ok {
		b.order = append(b.order, resource)
		b.verbs[resource] = map[string]struct{}{}
	}
	b.verbs[resource][verb] = struct{}{}
}

func (b *grantBuilder) has(resource, verb string) bool {
	_, ok := b.verbs[resource][verb]
	return ok
}

// grants 输出按「资源名排序、通配在前」的定义，便于比对与复跑。
func (b *grantBuilder) grants() []common.ResourceGrant {
	order := append([]string(nil), b.order...)
	sort.Slice(order, func(i, j int) bool {
		if (order[i] == "*") != (order[j] == "*") {
			return order[i] == "*"
		}
		return order[i] < order[j]
	})
	grants := make([]common.ResourceGrant, 0, len(order))
	for _, resource := range order {
		verbs := make([]string, 0, len(b.verbs[resource]))
		for _, verb := range aerolinkVerbs {
			if _, ok := b.verbs[resource][verb]; ok {
				verbs = append(verbs, verb)
			}
		}
		grants = append(grants, common.ResourceGrant{Resource: resource, Verbs: verbs})
	}
	return grants
}

// Prefix 是角色名 / 绑定组名的前缀，默认空（直接用 Rancher 上的项目名 / 角色模板名）。
const defaultNamePrefix = ""

// migrationMarker 出现在角色与绑定组的描述里，用来区分「本工具生成的」与「管理员手工建的」。
// 名称默认不加前缀，清理时只能靠这个标记判断归属；名字撞上手工对象时必须跳过而不是覆盖。
//
// 描述会直接显示在控制台上，所以这里不用产品名，只说清「是批量导入的」。
const migrationMarker = "由授权迁移导入"

// aerolinkRoleName 是迁移出来的鸢联 AeroLink 角色名。默认直接用角色模板名（project-owner 等），
// 与 Rancher 界面上看到的一致；需要避让时可加 -prefix。
func aerolinkRoleName(prefix, templateID string) string {
	return sanitizeName(prefix + templateID)
}

func templateDisplayName(template rancherRoleTemplate) string {
	if strings.TrimSpace(template.DisplayName) != "" {
		return strings.TrimSpace(template.DisplayName)
	}
	return template.ID
}

// maxNameRunes 是鸢联 AeroLink 角色名 / 权限绑定组名的长度上限（varchar(100)）。
const maxNameRunes = 100

// sanitizeName 把名称整理成鸢联 AeroLink 能存的形式（varchar(100)，不能为空）。
func sanitizeName(raw string) string {
	name := strings.Join(strings.Fields(strings.TrimSpace(raw)), "-")
	name = strings.ReplaceAll(name, "/", "-")
	name = strings.Trim(name, "-")
	if name == "" {
		name = "unnamed"
	}
	runes := []rune(name)
	if len(runes) > maxNameRunes {
		name = strings.TrimRight(string(runes[:maxNameRunes]), "-")
	}
	return name
}

func containsString(list []string, val string) bool {
	for _, item := range list {
		if item == val {
			return true
		}
	}
	return false
}
