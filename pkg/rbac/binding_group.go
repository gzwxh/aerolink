package rbac

import (
	"strings"
	"sync"

	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
	"k8s.io/klog/v2"
)

// bindingGroupCache 是权限绑定组授权数据的内存缓存，随 RBACConfig 一起刷新。
// 判定路径：命名空间 → 归属权限绑定组 → 成员 → 绑定的角色规则。
type bindingGroupCache struct {
	// byNamespace 把 "cluster/namespace" 映射到它所属的项目。
	byNamespace map[string]uint
	// projects 把项目 id 映射到它所在的集群。
	projects map[uint]string
	// namespaces 把项目 id 映射到它拥有的命名空间，按数据库顺序。
	namespaces map[uint][]string
	// members 把项目 id 映射到它的成员条目；每个条目把一个
	// 主体与一个已绑定角色的规则配对。
	members map[uint][]bindingGroupMemberEntry
	// globals 标记具有全局范围的组：其成员在所有集群与命名空间上都持有
	// 被绑定的角色，集群级资源也包括在内。
	globals map[uint]bool
}

type bindingGroupMemberEntry struct {
	subjectType string // user | group
	subject     string
	// namespace 限定该绑定生效的命名空间；为空表示组内全部命名空间。
	namespace string
	role      common.Role
}

var (
	bindingGroupRWLock sync.RWMutex
	bindingGroupsCache *bindingGroupCache
)

func loadBindingGroupsFromDB() error {
	var projects []model.BindingGroup
	if err := model.DB.Preload("Namespaces").Find(&projects).Error; err != nil {
		return err
	}

	var members []model.BindingGroupMember
	if err := model.DB.Preload("Role").Find(&members).Error; err != nil {
		return err
	}

	cache := &bindingGroupCache{
		byNamespace: make(map[string]uint),
		projects:    make(map[uint]string),
		namespaces:  make(map[uint][]string),
		members:     make(map[uint][]bindingGroupMemberEntry),
		globals:     make(map[uint]bool),
	}
	for _, p := range projects {
		// 所属集群已被删除、配置被保留的权限绑定组不参与授权，
		// 直到在权限管理页显式重新绑定到集群。
		if p.Detached {
			continue
		}
		cache.projects[p.ID] = p.Cluster
		cache.globals[p.ID] = p.Global
		for _, ns := range p.Namespaces {
			cache.namespaces[p.ID] = append(cache.namespaces[p.ID], ns.Namespace)
			// 同一命名空间唯一归属（DB 唯一索引兜底）；防御性覆盖时保留先到者。
			key := p.Cluster + "/" + ns.Namespace
			if _, exists := cache.byNamespace[key]; !exists {
				cache.byNamespace[key] = p.ID
			}
		}
	}
	for _, m := range members {
		cache.members[m.ProjectID] = append(cache.members[m.ProjectID], bindingGroupMemberEntry{
			subjectType: m.SubjectType,
			subject:     m.Subject,
			namespace:   m.Namespace,
			// 用 commonRole 而不是手抄字段：绑定组带来的角色会随用户对象发给前端
			// （见 GlobalBindingGroupRoles），漏掉 Namespaces 会让前端把「集群/资源/操作」
			// 都允许的角色当成「没有命名空间授权」，从而隐藏创建、批量删除等入口。
			role: commonRole(m.Role),
		})
	}

	bindingGroupRWLock.Lock()
	bindingGroupsCache = cache
	bindingGroupRWLock.Unlock()
	return nil
}

// canAccessViaBindingGroup 是权限绑定组授权路径：命名空间归属某权限绑定组、用户（或其
// 用户组）是该组成员、且成员绑定的角色规则命中资源与操作时放行。
// 该路径与全局角色判定并行（并集），授权范围按角色里的规则形态分两种：
//
//   - 资源通配 * 的授权（k8s:*:*、k8s:*:get 等）写的是「集群里的一切资源」，作用范围
//     本来就是整个集群，因此不受组内命名空间收窄：集群级资源（节点等）与跨命名空间
//     请求一并放行，见 bindingGroupAllowsClusterWide；
//
// 　- 指名资源的授权（例如只给 pods 的角色）仍然只在组内命名空间级资源上生效，
// 　  集群级资源不在其范围内。
//
// 「创建命名空间」不在这里判定：它是管理员专属动作，在 CanAccess 里直接按管理员
// 身份放行，不经过角色 / 绑定组。
func canAccessViaBindingGroup(user model.User, resource, verb, cluster, namespace string) bool {
	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()
	if bindingGroupsCache == nil {
		return false
	}

	userKey := user.Key()

	// 全局作用域的组（超级权限绑定）：成员不受集群与命名空间限制，命中即放行，
	// 包括集群级资源和“全部命名空间”请求。
	for projectID, entries := range bindingGroupsCache.members {
		if !bindingGroupsCache.globals[projectID] {
			continue
		}
		for _, entry := range entries {
			if bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) &&
				bindingGroupEntryCovers(entry, namespace) &&
				roleAllows(entry.role, resource, verb) {
				klog.V(2).Infof("RBAC BindingGroup Check - User: %s, GlobalBindingGroup: %d, Resource: %s, Verb: %s, Cluster: %s, Namespace: %s, Hit Role: %v",
					userKey, projectID, resource, verb, cluster, namespace, entry.role.Name)
				return true
			}
		}
	}

	// 资源通配 * 的授权与命名空间无关：命中即放行，不看组内命名空间列表。
	if bindingGroupAllowsClusterWide(user, resource, verb, cluster) {
		return true
	}

	if namespace == "" || namespace == common.AllNamespaces || namespace == "*" {
		return false
	}

	projectID, ok := bindingGroupsCache.byNamespace[cluster+"/"+namespace]
	if !ok {
		return false
	}
	if bindingGroupsCache.projects[projectID] != cluster {
		return false
	}

	for _, entry := range bindingGroupsCache.members[projectID] {
		if !bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
			continue
		}
		if !bindingGroupEntryCovers(entry, namespace) {
			continue
		}
		if roleAllows(entry.role, resource, verb) {
			klog.V(2).Infof("RBAC BindingGroup Check - User: %s, BindingGroup: %d, Resource: %s, Verb: %s, Cluster: %s, Namespace: %s, Hit Role: %v",
				userKey, projectID, resource, verb, cluster, namespace, entry.role.Name)
			return true
		}
	}
	return false
}

// bindingGroupAllowsClusterWide 报告用户是否通过 cluster 中某个非全局的
// 权限绑定组持有一条规则，该规则以裸 "*" 资源通配授予了
// 对 resource 的 verb（k8s:*:*、k8s:*:get、k8s:*:create 等），即写的是
// 「集群里的一切资源」，作用范围本来就是整个集群，组的命名空间列表不能把它收窄：
// 集群级资源（nodes、persistent volumes 等）与跨命名空间的（_all）请求同样被放行。
//
// 全局作用域的组由调用方的全局分支处理，这里只覆盖普通组。
func bindingGroupAllowsClusterWide(user model.User, resource, verb, cluster string) bool {
	userKey := user.Key()
	for projectID, projectCluster := range bindingGroupsCache.projects {
		if projectCluster != cluster || bindingGroupsCache.globals[projectID] {
			continue
		}
		for _, entry := range bindingGroupsCache.members[projectID] {
			if !bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
				continue
			}
			if roleAllowsClusterWide(entry.role, resource, verb) {
				klog.V(2).Infof("RBAC BindingGroup Check - User: %s, BindingGroup: %d, ClusterWide Resource: %s, Verb: %s, Cluster: %s, Hit Role: %v",
					userKey, projectID, resource, verb, cluster, entry.role.Name)
				return true
			}
		}
	}
	return false
}

// hasBindingGroupResourcePermission 报告用户是否是该集群中至少一个
// 绑定组的成员，且这些组绑定的角色授予了对 resource 的 verb。
// 它是 HasResourcePermission 在绑定组一侧的对应实现，
// 让跨命名空间的 LIST 能到达 handler，
// 随后由 handler 通过 CanAccess 逐条过滤。
func hasBindingGroupResourcePermission(user model.User, resource, verb, cluster string) bool {
	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()
	if bindingGroupsCache == nil {
		return false
	}

	userKey := user.Key()
	for projectID, projectCluster := range bindingGroupsCache.projects {
		if projectCluster != cluster && !bindingGroupsCache.globals[projectID] {
			continue
		}
		for _, entry := range bindingGroupsCache.members[projectID] {
			if !bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
				continue
			}
			if roleAllows(entry.role, resource, verb) {
				return true
			}
		}
	}
	return false
}

// bindingGroupMemberMatches 报告某个成员条目是否属于该用户：
// 直接属于，或通过其某个用户组属于。
func bindingGroupMemberMatches(entry bindingGroupMemberEntry, userKey string, oidcGroups []string) bool {
	switch entry.subjectType {
	case model.SubjectTypeUser:
		return entry.subject == userKey
	case model.SubjectTypeGroup:
		return slicesContains(oidcGroups, entry.subject)
	default:
		return false
	}
}

// bindingGroupEntryCovers 报告某条成员绑定是否适用于正在校验的命名空间：
// 范围为空表示覆盖该组的所有命名空间。
func bindingGroupEntryCovers(entry bindingGroupMemberEntry, namespace string) bool {
	return entry.namespace == "" || entry.namespace == namespace
}

func slicesContains(list []string, val string) bool {
	for _, item := range list {
		if item == val {
			return true
		}
	}
	return false
}

// canAccessNamespaceViaBindingGroup 判断命名空间可见性：只要用户（或其用户组）
// 是归属该权限绑定组的成员（任意角色），即可见该命名空间。
func canAccessNamespaceViaBindingGroup(user model.User, cluster, namespace string) bool {
	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()
	if bindingGroupsCache == nil {
		return false
	}

	userKey := user.Key()
	// 全局作用域的组对所有集群生效：成员可见任意命名空间。
	for projectID, entries := range bindingGroupsCache.members {
		if !bindingGroupsCache.globals[projectID] {
			continue
		}
		for _, entry := range entries {
			if bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) &&
				bindingGroupEntryCovers(entry, namespace) {
				return true
			}
		}
	}

	// 资源通配 * 的授权作用范围是整个集群（见 bindingGroupAllowsClusterWide），
	// 与本集群任意命名空间的 CanAccess 判定保持一致，否则会出现「后端放行、命名空间
	// 选择器里却看不到这个命名空间」。
	for projectID, entries := range bindingGroupsCache.members {
		if bindingGroupsCache.globals[projectID] ||
			bindingGroupsCache.projects[projectID] != cluster {
			continue
		}
		for _, entry := range entries {
			if bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) &&
				roleHasResourceWildcard(entry.role) {
				return true
			}
		}
	}

	projectID, ok := bindingGroupsCache.byNamespace[cluster+"/"+namespace]
	if !ok {
		return false
	}
	if bindingGroupsCache.projects[projectID] != cluster {
		return false
	}

	for _, entry := range bindingGroupsCache.members[projectID] {
		if !bindingGroupEntryCovers(entry, namespace) {
			continue
		}
		if bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
			return true
		}
	}
	return false
}

// BindingGroupRoleNames 返回用户通过某一个绑定组持有的角色名。
// 写入路径用它来在校验"某次变更是否会破坏职责分离规则"时
// 忽略该组自己的授权——否则重写一个组的角色
// （"admin → auditor"）会被误判为与该组即将移除的角色冲突。
func BindingGroupRoleNames(projectID uint, userKey string, oidcGroups []string) []string {
	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()

	names := make([]string, 0)
	if bindingGroupsCache == nil {
		return names
	}
	seen := make(map[string]struct{})
	for _, entry := range bindingGroupsCache.members[projectID] {
		if !bindingGroupMemberMatches(entry, userKey, oidcGroups) {
			continue
		}
		if _, ok := seen[entry.role.Name]; ok {
			continue
		}
		seen[entry.role.Name] = struct{}{}
		names = append(names, entry.role.Name)
	}
	return names
}

// CanSeeNamespacesInCluster 报告用户在该集群下是否可能有可见的命名空间：
// 直接角色覆盖该集群，或是本集群（含全局作用域）某个权限绑定组的成员。
//
// 命名空间**列表**接口用它放行请求，再由列表 handler 逐项用 CanAccessNamespace
// 过滤，因此放行本身不泄露数据——与该分支上「有集群访问权就放行列表」的既有取舍
// 一致。少了这条，只靠权限绑定组授权的用户连命名空间列表都拿不到（403），
// 前端的命名空间选择器与命名空间页对他们不可用。
func CanSeeNamespacesInCluster(user model.User, cluster string) bool {
	if CanAccessCluster(user, cluster) {
		return true
	}

	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()
	if bindingGroupsCache == nil {
		return false
	}

	userKey := user.Key()
	for projectID, entries := range bindingGroupsCache.members {
		projectCluster, ok := bindingGroupsCache.projects[projectID]
		if !ok {
			// 所属集群已删除、配置被保留的组不参与授权。
			continue
		}
		if projectCluster != cluster && !bindingGroupsCache.globals[projectID] {
			continue
		}
		for _, entry := range entries {
			if bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
				return true
			}
		}
	}
	return false
}

// HasBindingGroupMembership 报告用户是否至少是一个绑定组的成员。
// 这样的用户确实持有授权（范围限定在该组的命名空间，
// 全局组则是全局范围），因此登录流程不能因为没有直接分配的角色就拒绝该账号。
func HasBindingGroupMembership(user model.User) bool {
	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()
	if bindingGroupsCache == nil {
		return false
	}
	userKey := user.Key()
	for projectID, entries := range bindingGroupsCache.members {
		if _, ok := bindingGroupsCache.projects[projectID]; !ok {
			continue
		}
		for _, entry := range entries {
			if bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
				return true
			}
		}
	}
	return false
}

// GlobalBindingGroupRoles 返回用户通过全局权限绑定组
// （例如超级管理员组）持有的角色。这类角色适用于所有集群与命名空间，
// 因此控制台在决定展示哪些管理界面时，可以把它们当作用户自己的角色来渲染；
// 授权校验本身已经覆盖了这些角色。
func GlobalBindingGroupRoles(user model.User) []common.Role {
	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()
	roles := make([]common.Role, 0)
	if bindingGroupsCache == nil {
		return roles
	}
	userKey := user.Key()
	seen := make(map[string]struct{})
	for projectID, entries := range bindingGroupsCache.members {
		if !bindingGroupsCache.globals[projectID] {
			continue
		}
		for _, entry := range entries {
			if !bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
				continue
			}
			// 同一角色可能在多个集群的同名超级组里都绑了一份，按名称去重。
			if _, ok := seen[entry.role.Name]; ok {
				continue
			}
			seen[entry.role.Name] = struct{}{}
			roles = append(roles, entry.role)
		}
	}
	return roles
}

// NamespaceScopedBindingGroupRoles 返回用户通过**命名空间级**权限绑定组持有的角色，
// 每个角色都带上该绑定生效的集群与命名空间范围（成员只绑定了组内某一个命名空间时，
// 就收窄到那一个）。全局作用域的组不在这里（见 GlobalBindingGroupRoles）。
// 唯一的例外是资源通配 * 的授权：它的范围是整个集群，下发时不带命名空间列表（空列表
// 对前端就是「不约束」），见下方注释。
//
// 用途：/api/auth/user 把它单独下发给前端，让控制台把「创建 / 批量删除」这类不绑定单个
// 命名空间的入口，在绑定组范围外也隐藏；否则前端只看到直接分配的角色，会把这些入口
// 显示成后端必然拒绝的样子。它不参与后端授权判定（后端走 CanAccess / canAccessViaBindingGroup）。
func NamespaceScopedBindingGroupRoles(user model.User) []common.Role {
	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()
	if bindingGroupsCache == nil {
		return nil
	}

	userKey := user.Key()
	roles := make([]common.Role, 0)
	seen := make(map[string]struct{})
	for projectID, entries := range bindingGroupsCache.members {
		if bindingGroupsCache.globals[projectID] {
			continue
		}
		// 所属集群已删除、配置被保留的组不参与授权。
		cluster := bindingGroupsCache.projects[projectID]
		if cluster == "" {
			continue
		}
		groupNamespaces := bindingGroupsCache.namespaces[projectID]
		for _, entry := range entries {
			if !bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
				continue
			}
			namespaces := groupNamespaces
			if entry.namespace != "" {
				if !slicesContains(groupNamespaces, entry.namespace) {
					continue
				}
				namespaces = []string{entry.namespace}
			}
			// 资源通配 * 的授权作用范围是整个集群（见 bindingGroupAllowsClusterWide），
			// 所以不能带命名空间列表下发：前端把空列表当「不约束」，带了列表就会按组内
			// 命名空间把集群级资源与跨命名空间的入口重新隐藏，退化成「后端放行、界面没有
			// 入口」。这类角色即便所在的组一个命名空间都没有，也照常下发。
			role := entry.role
			if roleHasResourceWildcard(entry.role) {
				namespaces = nil
			} else if len(namespaces) == 0 {
				// 指名资源的授权在没有命名空间的组里什么都授不了（canAccessViaBindingGroup
				// 也命中不了），因此不下发空范围的角色。空组是正常状态：组里还没分配命名空间
				// 时成员本来就没有可用授权，创建命名空间也不再由绑定组下发。
				continue
			}
			role.Clusters = []string{cluster}
			role.Namespaces = append([]string(nil), namespaces...)
			key := role.Name + "\x00" + cluster + "\x00" + strings.Join(namespaces, ",")
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			roles = append(roles, role)
		}
	}
	return roles
}

// UserVisibleBindingGroups 返回用户可见的权限绑定组 id 集合（所属当前集群），
// 供导航与命名空间分组展示使用。projectID -> projectCluster。
func UserVisibleBindingGroups(user model.User) map[uint]string {
	bindingGroupRWLock.RLock()
	defer bindingGroupRWLock.RUnlock()
	visible := make(map[uint]string)
	if bindingGroupsCache == nil {
		return visible
	}
	userKey := user.Key()
	for projectID, cluster := range bindingGroupsCache.projects {
		for _, entry := range bindingGroupsCache.members[projectID] {
			if bindingGroupMemberMatches(entry, userKey, user.OIDCGroups) {
				visible[projectID] = cluster
				break
			}
		}
	}
	return visible
}
