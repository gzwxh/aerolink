package rbac

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// roleAllows 报告该角色是否授予对某资源的 verb。带 Grants 的角色
// 按资源逐条校验（因此同一个角色可以对不同资源授予不同的操作）；
// 没有 Grants 的旧式角色沿用
// Resources × Verbs 的叉乘语义。
//
// 设置族资源（settings / settings.<章节>）单独走 settingsRoleAllows：它们必须显式
// 授权，通配 * 不覆盖——否则一个含 "*" 的普通角色就能把「系统配置 / 安全授权 /
// 审计」三员的权限并回一人，职责分离失效。
func roleAllows(role common.Role, resource, verb string) bool {
	if common.IsSettingsResource(resource) {
		return settingsRoleAllows(role, resource, verb)
	}
	if roleDenies(role, resource) {
		return false
	}
	if len(role.Grants) > 0 {
		for _, grant := range role.Grants {
			if match([]string{grant.Resource}, resource) && match(grant.Verbs, verb) {
				return true
			}
		}
		return false
	}
	return match(role.Resources, resource) && match(role.Verbs, verb)
}

// roleAllowsClusterWide 报告该角色是否在整个集群范围内授权对某资源的 verb。
// through a bare "*" resource rule (k8s:*:*、k8s:*:get 这类授权)。Such a rule is
// 针对集群中的每一个资源编写，因此它的范围是集群全域，
// 命名空间列表不应该把它的范围收窄（见
// canAccessViaBindingGroup）。
//
// 设置族资源仍然必须显式授权（见 roleAllows），通配 * 不覆盖它们。
func roleAllowsClusterWide(role common.Role, resource, verb string) bool {
	if common.IsSettingsResource(resource) || roleDenies(role, resource) {
		return false
	}
	if len(role.Grants) > 0 {
		for _, grant := range role.Grants {
			if grant.Resource == "*" && match(grant.Verbs, verb) {
				return true
			}
		}
		return false
	}
	return contains(role.Resources, "*") && match(role.Verbs, verb)
}

// roleHasResourceWildcard 报告该角色是否带有裸 "*" 资源的
// 规则（对任意操作），也就是说它对自己授予的操作而言是集群范围的，
// 无论这些操作是什么。调用方在尚不知道 verb 时使用它
// （例如告诉控制台某个角色能覆盖哪些命名空间）。
func roleHasResourceWildcard(role common.Role) bool {
	if len(role.Grants) > 0 {
		for _, grant := range role.Grants {
			if grant.Resource == "*" {
				return true
			}
		}
		return false
	}
	return contains(role.Resources, "*")
}

// roleDenies 报告该角色是否显式排除了该资源。排除
// 模式（"!roles"）保存在 Resources 中；它们只对携带 Grants 的角色有意义，
// 因为这类角色的其它规则都在 Grants 里，
// 这样宽泛的 "*" 授权才能被收窄（例如：除 RBAC 对象之外的所有 Kubernetes 资源）。
func roleDenies(role common.Role, resource string) bool {
	for _, pattern := range role.Resources {
		if len(pattern) < 2 || !strings.HasPrefix(pattern, "!") {
			continue
		}
		if matchPattern(pattern[1:], resource) {
			return true
		}
	}
	return false
}

// settingsRoleAllows 授权某个控制台设置项资源。只有直接点名该设置资源的规则才计入：
// 裸的父级 "settings" 覆盖所有分区，分区级规则只覆盖它自己的分区，
// 没有任何规则会隐式覆盖父级。
func settingsRoleAllows(role common.Role, resource, verb string) bool {
	if len(role.Grants) > 0 {
		for _, grant := range role.Grants {
			if settingsRuleCovers(grant.Resource, resource) && match(grant.Verbs, verb) {
				return true
			}
		}
		return false
	}
	for _, pattern := range role.Resources {
		if strings.HasPrefix(pattern, "!") {
			continue
		}
		if settingsRuleCovers(pattern, resource) && match(role.Verbs, verb) {
			return true
		}
	}
	return false
}

// settingsRuleCovers 报告某条规则的资源模式是否授权了目标控制台设置资源。
func settingsRuleCovers(pattern, resource string) bool {
	if pattern == resource {
		return true
	}
	if resource == common.SystemSettingsResource {
		// 章节规则不反向覆盖父级：父级语义是「全部章节」。
		return false
	}
	return pattern == common.SystemSettingsResource
}

// execRequiresGet 报告某个 verb 是否还额外要求同一资源的 get 权限。
// Pod 终端是唯一的例子：会话必须先选定 pod 与容器，
// 因此只持有 exec 而没有 get 的角色本来就开不了终端——
// 控制台按同一规则把终端入口隐藏起来。
func execRequiresGet(resource, verb string) bool {
	return resource == string(common.Pods) && verb == string(common.VerbExec)
}

// CanAccess 检查 user/oidcGroup 能否以 verb 访问 cluster/namespace 中的 resource
func CanAccess(user model.User, resource, verb, cluster, namespace string) bool {
	if execRequiresGet(resource, verb) &&
		!canAccessVerb(user, resource, string(common.VerbGet), cluster, namespace) {
		return false
	}
	return canAccessVerb(user, resource, verb, cluster, namespace)
}

// canAccessVerb 是 CanAccess 背后的纯角色 / 权限绑定组校验，
// 不含 exec 的前置要求。
func canAccessVerb(user model.User, resource, verb, cluster, namespace string) bool {
	// 「创建命名空间」是管理员专属动作，不通过授权配置下发：命名空间统一由管理员创建，
	// 再通过权限绑定组授权给用户使用。因此这条路径只看管理员身份，不看角色 / 绑定组，
	// 也就没有「请求上的 _all 只是占位哨兵」这回事了。
	//
	// 它同时覆盖两条创建路径：资源创建接口，以及 YAML apply
	// （`POST /resources/apply` 用的也是同一个 CanAccess）。
	if resource == string(common.Namespaces) && verb == string(common.VerbCreate) {
		return IsAdministrator(user)
	}
	roles := GetUserRoles(user)
	clusterScoped := namespaceUnconstrained(resource)
	for _, role := range roles {
		if !match(role.Clusters, cluster) {
			continue
		}
		// 兼容存量：显式配置了 namespaces 的角色继续受其约束（match 内置
		// 否定规则语义）；新建角色不再提供该字段（为空 = 不约束），
		// 命名空间范围由权限绑定组圈定。
		switch {
		case clusterScoped:
			if namespaceRestricted(role.Namespaces) && !matchExplicit(role.Resources, resource) {
				continue
			}
		case len(role.Namespaces) > 0 && !match(role.Namespaces, namespace):
			continue
		}
		if roleAllows(role, resource, verb) {
			klog.V(2).Infof("RBAC Check - User: %s, OIDC Groups: %v, Resource: %s, Verb: %s, Cluster: %s, Namespace: %s, Hit Role: %v",
				user.Key(), user.OIDCGroups, resource, verb, cluster, namespace, role.Name)
			return true
		}
	}
	// 权限绑定组路径：命名空间归属某权限绑定组且用户（或其组）为成员时，按成员绑定
	// 的角色规则放行。与全局角色取并集。
	if canAccessViaBindingGroup(user, resource, verb, cluster, namespace) {
		return true
	}
	klog.V(2).Infof("RBAC Check - User: %s, OIDC Groups: %v, Resource: %s, Verb: %s, Cluster: %s, Namespace: %s, No Access",
		user.Key(), user.OIDCGroups, resource, verb, cluster, namespace)
	return false
}

// namespaceRestricted 报告角色是否显式地把访问限制在
// 特定命名空间内。为空（新式角色）表示不受限。
func namespaceRestricted(namespaces []string) bool {
	if len(namespaces) == 0 {
		return false
	}
	return !contains(namespaces, "*") && !contains(namespaces, common.AllNamespaces)
}

// matchExplicit 是去掉裸 "*" 通配之后的 match()，
// 这样通配资源授权不能冒充显式的集群级授权。
func matchExplicit(list []string, val string) bool {
	if !contains(list, "*") {
		return match(list, val)
	}
	filtered := make([]string, 0, len(list))
	for _, pattern := range list {
		if pattern != "*" {
			filtered = append(filtered, pattern)
		}
	}
	return match(filtered, val)
}

// namespaceUnconstrained 报告某个资源是否是集群级的，
// 从而其授权必须忽略角色的命名空间范围。
// "namespaces" 资源被排除：它的名字本身就是授权命名空间。
func namespaceUnconstrained(resource string) bool {
	meta := common.LookupResource(resource)
	if meta == nil || !meta.ClusterScoped {
		return false
	}
	return resource != string(common.Namespaces)
}

// CanAccessCurrent 校验最新的角色配置，而不是认证时附带的角色快照。
// 匿名访问继续使用其内置角色。
func CanAccessCurrent(user model.User, resource, verb, cluster, namespace string) bool {
	if user.Username == model.AnonymousUser.Username && user.Provider == model.AnonymousUser.Provider {
		user.Roles = model.AnonymousUser.Roles
	} else {
		user.Roles = nil
	}
	return CanAccess(user, resource, verb, cluster, namespace)
}

// HasResourcePermission 报告用户在 cluster 中是否持有任何授予
// 对 resource 执行 verb 的角色，与命名空间无关。RBAC 中间件用它判断
// 跨命名空间的 LIST 是否可以放行到 handler——
// 随后 handler 会按完整的资源权限过滤条目，
// 使用户只看到自己有权访问的对象。
// 这里要求存在匹配的角色，以免零权限的用户
// 触发 list 调用。权限绑定组的成员身份同样计入，
// 因此仅通过绑定组获得授权的用户也能跨命名空间列表，
// 并得到同样的逐对象过滤。
func HasResourcePermission(user model.User, resource, verb, cluster string) bool {
	roles := GetUserRoles(user)
	for _, role := range roles {
		if match(role.Clusters, cluster) && roleAllows(role, resource, verb) {
			return true
		}
	}
	return hasBindingGroupResourcePermission(user, resource, verb, cluster)
}

// CanManageSystemSettings 报告用户是否可以修改控制台的整体设置
// （父级 "settings" 资源）。系统设置是控制台的全局状态，
// 因此角色的集群与命名空间范围不适用：只匹配资源与 verb 模式，
// 且裸 "*" 资源授权不包含它们（见 roleAllows）。
func CanManageSystemSettings(user model.User, verb string) bool {
	return CanManageSettingsSection(user, "", verb)
}

// CanManageSettingsSection 报告用户是否可以对某个控制台设置分区执行给定的 verb。
// 分区为空时针对父级 "settings" 资源（所有分区）；分区级授权不隐含父级权限。
func CanManageSettingsSection(user model.User, section, verb string) bool {
	if conflict, _ := SeparationOfDutiesConflict(user); conflict {
		return false
	}
	resource := common.SettingsSectionResource(section)
	for _, role := range effectiveRoles(user) {
		if roleAllows(role, resource, verb) {
			return true
		}
	}
	return false
}

// CanViewSystemSettings 报告用户是否可以打开控制台的系统设置与权限页面：
// 对父级 "settings" 资源有读权限，或者有管理权限（写权限隐含读权限）。
func CanViewSystemSettings(user model.User) bool {
	return CanManageSystemSettings(user, string(common.VerbGet)) ||
		CanManageSystemSettings(user, string(common.SystemSettingsVerb))
}

// CanViewSettingsSection 报告用户是否可以打开某个控制台设置分区：
// 有读权限，或者有管理权限（写权限隐含读权限）。
func CanViewSettingsSection(user model.User, section string) bool {
	return CanManageSettingsSection(user, section, string(common.VerbGet)) ||
		CanManageSettingsSection(user, section, string(common.SystemSettingsVerb))
}

// CanAccessAnySettingsSection 报告用户是否至少可以打开一个
// 控制台设置分区。设置区本身（导航、路由守卫）就以此为准。
func CanAccessAnySettingsSection(user model.User) bool {
	for _, section := range common.SettingsSections {
		if CanViewSettingsSection(user, section) {
			return true
		}
	}
	return false
}

// effectiveRoles 返回用户直接持有、或通过全局权限绑定组持有的角色。
// 这两组都是副本，绝不会原地追加，
// 因此调用方无法改动 model.User 上由调用方拥有的角色快照。
func effectiveRoles(user model.User) []common.Role {
	roles := GetUserRoles(user)
	globals := GlobalBindingGroupRoles(user)
	if len(globals) == 0 {
		return roles
	}
	combined := make([]common.Role, 0, len(roles)+len(globals))
	combined = append(combined, roles...)
	combined = append(combined, globals...)
	return combined
}

// RolesForDisplay 返回控制台应当为用户展示的角色：直接分配的，加上通过**全局作用域**
// 权限绑定组（受保护的「超级权限绑定」）持有的。
//
// 与 effectiveRoles 的区别只在按名称去重（重复项会让角色列表看起来像坏数据），
// 但它的用途很关键：前端的管理入口完全由这份角色列表推导（canViewSettingsSection /
// isAdmin 等）。判定与展示必须来自同一份来源，否则会出现「后端放行、界面没有入口」
// ——典型的症状是仅由绑定组授权的账号能登录、却看不到系统设置。
func RolesForDisplay(user model.User) []common.Role {
	roles := GetUserRoles(user)
	globals := GlobalBindingGroupRoles(user)
	if len(globals) == 0 {
		return roles
	}
	seen := make(map[string]struct{}, len(roles)+len(globals))
	for _, role := range roles {
		seen[role.Name] = struct{}{}
	}
	combined := make([]common.Role, 0, len(roles)+len(globals))
	combined = append(combined, roles...)
	for _, role := range globals {
		if _, ok := seen[role.Name]; ok {
			continue
		}
		seen[role.Name] = struct{}{}
		combined = append(combined, role)
	}
	return combined
}

// SeparationOfDutiesConflict 报告用户的有效角色集合是否破坏了
// the mutual-exclusion rules between the three administrator roles (系统管理员 /
// 安全管理员 / 审计管理员) and returns the conflicting role names.
//
// 这样的账号无法被独立审计，因此在运维人员移除其中一个角色之前，
// 控制台的管理界面对它关闭（见 CanAccessAdminAPI）。
// 集群资源访问被有意保留：成员关系可能来自外部目录中的某个组，
// 若因为目录侧的一次失误也把账号锁在集群之外，
// 会破坏日常工作。
func SeparationOfDutiesConflict(user model.User) (bool, []string) {
	names := RoleNamesForUser(user)
	return mutualExclusionConflict(names)
}

// SeparationOfDutiesConflictWith 报告把给定的角色名授予该用户
// 是否会破坏互斥规则，会把用户已持有的角色（直接持有或通过全局绑定组）
// 一并考虑。负责分配角色的写入路径——直接授权与绑定组成员关系——
// 用它提前拒绝这种组合，
// 而不是留下一个静默失去管理界面的账号。
func SeparationOfDutiesConflictWith(user model.User, granted ...string) (bool, []string) {
	return SeparationOfDutiesConflictOnGrant(user, 0, granted...)
}

// SeparationOfDutiesConflictOnGrant 是针对通过某个权限绑定组进行的授权，
// 等价于 SeparationOfDutiesConflictWith。用户已通过该组持有的角色会被忽略，
// 这样重写该组自己的授权（把它的 "admin" 换成 "auditor"）
// 不会被误判为冲突。bindingGroupID 为 0 表示该授权不是来自某个组。
func SeparationOfDutiesConflictOnGrant(user model.User, bindingGroupID uint, granted ...string) (bool, []string) {
	excluded := make(map[string]struct{})
	if bindingGroupID != 0 {
		for _, name := range BindingGroupRoleNames(bindingGroupID, user.Key(), user.OIDCGroups) {
			excluded[name] = struct{}{}
		}
	}

	names := make([]string, 0, len(granted)+4)
	for _, name := range RoleNamesForUser(user) {
		if _, skip := excluded[name]; skip {
			continue
		}
		names = append(names, name)
	}
	names = append(names, granted...)
	return mutualExclusionConflict(names)
}

// RoleNamesForUser 返回用户持有的所有角色名（直接持有，或通过
// 全局权限绑定组持有），已去重。
func RoleNamesForUser(user model.User) []string {
	seen := make(map[string]struct{})
	names := make([]string, 0)
	for _, role := range effectiveRoles(user) {
		if _, ok := seen[role.Name]; ok {
			continue
		}
		seen[role.Name] = struct{}{}
		names = append(names, role.Name)
	}
	return names
}

// mutualExclusionConflict 返回第一个持有了多个角色的互斥组，
// 以及该组中已持有的角色。
func mutualExclusionConflict(names []string) (bool, []string) {
	held := make(map[string]struct{}, len(names))
	for _, name := range names {
		held[name] = struct{}{}
	}
	for _, group := range model.MutuallyExclusiveRoleGroups {
		conflict := make([]string, 0, len(group))
		for _, name := range group {
			if _, ok := held[name]; ok {
				conflict = append(conflict, name)
			}
		}
		if len(conflict) > 1 {
			return true, conflict
		}
	}
	return false, nil
}

// commonRole 把存储中的角色转换成授权校验使用的形态。
func commonRole(role model.Role) common.Role {
	return common.Role{
		Name:       role.Name,
		Clusters:   role.Clusters,
		Resources:  role.Resources,
		Namespaces: role.Namespaces,
		Verbs:      role.Verbs,
		Grants:     toCommonGrants(role.Grants),
	}
}

func CanAccessCluster(user model.User, name string) bool {
	roles := GetUserRoles(user)
	for _, role := range roles {
		if match(role.Clusters, name) {
			return true
		}
	}
	return false
}

func CanAccessNamespace(user model.User, cluster, name string) bool {
	// 兼容存量：显式配置 namespaces 的角色按列表匹配；空（新建角色）= 不约束，
	// 对该集群全部命名空间可见。权限绑定组成员额外可见其组内命名空间。
	roles := GetUserRoles(user)
	for _, role := range roles {
		if !match(role.Clusters, cluster) {
			continue
		}
		if len(role.Namespaces) == 0 || contains(role.Namespaces, "*") ||
			contains(role.Namespaces, common.AllNamespaces) {
			return true
		}
		if match(role.Namespaces, name) {
			return true
		}
	}
	return canAccessNamespaceViaBindingGroup(user, cluster, name)
}

// GetUserRoles 返回 user/oidcGroups 的所有角色
func GetUserRoles(user model.User) []common.Role {
	if user.Roles != nil {
		return user.Roles
	}
	rolesMap := make(map[string]common.Role)
	rwlock.RLock()
	defer rwlock.RUnlock()
	if RBACConfig == nil {
		return nil
	}
	for _, mapping := range RBACConfig.RoleMapping {
		if contains(mapping.Users, "*") || contains(mapping.Users, user.Key()) {
			if r := findRoleLocked(mapping.Name); r != nil {
				rolesMap[r.Name] = *r
			}
		}
		for _, group := range user.OIDCGroups {
			if contains(mapping.OIDCGroups, group) {
				if r := findRoleLocked(mapping.Name); r != nil {
					rolesMap[r.Name] = *r
				}
			}
		}
	}
	roles := make([]common.Role, 0, len(rolesMap))
	for _, role := range rolesMap {
		roles = append(roles, role)
	}
	return roles
}

func findRoleLocked(name string) *common.Role {
	for _, r := range RBACConfig.Roles {
		if r.Name == name {
			return &r
		}
	}
	return nil
}

func match(list []string, val string) bool {
	for _, pattern := range list {
		if len(pattern) > 1 && strings.HasPrefix(pattern, "!") && matchPattern(pattern[1:], val) {
			return false
		}
	}
	for _, pattern := range list {
		if strings.HasPrefix(pattern, "!") {
			continue
		}
		if matchPattern(pattern, val) {
			return true
		}
	}
	return false
}

func matchPattern(pattern, val string) bool {
	if pattern == "*" || pattern == val {
		return true
	}
	// 普通值是字面量；点号在 Kubernetes API 组名中很常见。
	if !strings.ContainsAny(pattern, `\^$*+?()[]{}|`) {
		return false
	}
	re, err := regexp.Compile("^(?:" + pattern + ")$")
	if err != nil {
		klog.Error(err)
		return false
	}
	return re.MatchString(val)
}

func contains(list []string, val string) bool {
	return slices.Contains(list, val)
}

func NoAccess(user, verb, resource, ns, cluster string) string {
	if ns == "" {
		return fmt.Sprintf("user %s does not have permission to %s %s on cluster %s",
			user, verb, resource, cluster)
	}
	if ns == common.AllNamespaces {
		ns = "All"
	}
	return fmt.Sprintf("user %s does not have permission to %s %s in namespace %s on cluster %s",
		user, verb, resource, ns, cluster)
}

func UserHasRole(user model.User, roleName string) bool {
	roles := GetUserRoles(user)
	for _, role := range roles {
		if role.Name == roleName {
			return true
		}
	}
	return false
}

// IsAdministrator 报告用户是否是特权控制台操作员。内置的
// "admin" 角色是历史标记；超级管理员角色同样计入，
// 无论是直接分配，还是通过全局权限绑定组持有。
// 它驱动运维级别的策略（口令强度、MFA 二次验证、kubectl 终端），
// 并作为管理 API 网关（见 CanAccessAdminAPI）的兼容兜底，
// 以便已有部署继续可用。
func IsAdministrator(user model.User) bool {
	if UserHasRole(user, model.DefaultAdminRole.Name) {
		return true
	}
	for _, role := range GlobalBindingGroupRoles(user) {
		if role.Name == model.DefaultAdminRole.Name {
			return true
		}
	}
	return false
}

// CanAccessAdminAPI 报告用户是否可以调用控制台管理
// 接口（/api/v1/admin/*）。持有任意控制台设置权限即可，
// the security administrator (授权) and the audit administrator (审计) reach their
// 这样分区管理员可以管理自己负责的分区，而不必拿到完整的管理员角色。
//
// 角色破坏三权分立的用户会在这里被拒绝：
// this is the enforcement point for 三权分立 (see SeparationOfDutiesConflict).
func CanAccessAdminAPI(user model.User) bool {
	if conflict, _ := SeparationOfDutiesConflict(user); conflict {
		return false
	}
	if CanAccessAnySettingsSection(user) {
		return true
	}
	return IsAdministrator(user)
}
