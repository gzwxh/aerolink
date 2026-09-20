package bindinggroups

import (
	"slices"
	"strings"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"k8s.io/klog/v2"
)

// NamespaceBindingOutcome 是「新建命名空间自动归属」的结论，随创建响应下发给前端，
// 让界面能提示「已自动归属」或「未自动归属，请联系管理员分配」。
type NamespaceBindingOutcome struct {
	// Bound 为 true 表示已把命名空间纳入创建者的授权范围。
	Bound bool `json:"bound"`
	// Method 说明走的是哪条路径，取值见 NamespaceBindingMethod*。
	Method string `json:"method,omitempty"`
	// BindingID / BindingName 是归属到的权限绑定组（Method 为 binding_group 时有效）。
	BindingID   uint   `json:"bindingId,omitempty"`
	BindingName string `json:"bindingName,omitempty"`
	// Roles 是退化路径下被追加了该命名空间的角色名（Method 为 role_namespaces 时有效）。
	Roles []string `json:"roles,omitempty"`
	// Reason 说明未归属的原因，取值见 NamespaceBindingReason*。
	Reason string `json:"reason,omitempty"`
}

const (
	// NamespaceBindingMethodGroup 命名空间被归属到创建者的权限绑定组。
	NamespaceBindingMethodGroup = "binding_group"
	// NamespaceBindingMethodRoles 命名空间被追加到创建者直接持有的受限角色。
	NamespaceBindingMethodRoles = "role_namespaces"

	// NamespaceBindingReasonAdministrator 管理员创建的命名空间不自动归属。
	NamespaceBindingReasonAdministrator = "administrator"
	// NamespaceBindingReasonNoCandidates 创建者没有可归属的权限绑定组，也没有受限角色。
	NamespaceBindingReasonNoCandidates = "no_candidates"
	// NamespaceBindingReasonMultipleGroups 创建者属于多个权限绑定组，无法判断该归属哪个。
	NamespaceBindingReasonMultipleGroups = "multiple_binding_groups"
	// NamespaceBindingReasonConflict 该命名空间已被同集群的另一个权限绑定组占用。
	NamespaceBindingReasonConflict = "conflict"
)

// AutoBindCreatedNamespace 把普通用户新建的命名空间纳入其已有的授权范围，避免出现
// 「自己建的命名空间自己看不见」。规则（与产品确认过的口径）：
//
//   - 管理员（rbac.IsAdministrator，含经全局绑定组持有管理员角色）创建的命名空间
//     不归属，留给管理员在权限绑定里手动分配；
//   - 只在该用户恰好属于一个可归属的权限绑定组时自动归属；属于多个组时无法判断该给谁
//     （一个命名空间同一时间只能属于一个组），退回退化路径；
//   - 退化路径：把命名空间追加到该用户直接持有的、已限定命名空间范围的自定义角色的
//     namespaces 列表（旧模型的等价表达），否则什么都不做；
//   - 任何失败都不影响命名空间创建本身，只在返回值里说明原因。
func AutoBindCreatedNamespace(user model.User, cluster, namespace string) NamespaceBindingOutcome {
	namespace = strings.TrimSpace(namespace)
	if namespace == "" {
		return NamespaceBindingOutcome{}
	}
	if rbac.IsAdministrator(user) {
		return NamespaceBindingOutcome{Reason: NamespaceBindingReasonAdministrator}
	}

	groups, err := autoBindCandidateGroups(user, cluster)
	if err != nil {
		klog.Errorf("auto bind namespace %s/%s: failed to load binding groups: %v", cluster, namespace, err)
		return NamespaceBindingOutcome{Reason: NamespaceBindingReasonNoCandidates}
	}
	if len(groups) == 1 {
		return bindNamespaceToGroup(groups[0], namespace)
	}

	reason := NamespaceBindingReasonNoCandidates
	if len(groups) > 1 {
		reason = NamespaceBindingReasonMultipleGroups
	}
	return appendNamespaceToUserRoles(user, cluster, namespace, reason)
}

// autoBindCandidateGroups 返回用户可自动归属的权限绑定组：当前集群内、未保留、且
// **非全局作用域**的组。全局组的成员本来就覆盖全部集群与命名空间，把新命名空间抓进
// 全局组只会让管理员再也无法把它分配给别的组，因此不作为候选。
//
// 成员判定与授权判定保持一致：既有直接绑定到用户身上的成员，也有通过用户所属用户组
// 绑定的成员。
func autoBindCandidateGroups(user model.User, cluster string) ([]model.BindingGroup, error) {
	var groups []model.BindingGroup
	if err := model.DB.Preload("Members").
		Where("cluster = ? AND detached = ? AND global = ?", cluster, false, false).
		Order("id asc").
		Find(&groups).Error; err != nil {
		return nil, err
	}

	userKey := user.Key()
	candidates := make([]model.BindingGroup, 0, len(groups))
	for _, group := range groups {
		for _, member := range group.Members {
			if !memberMatchesUser(member, userKey, user.OIDCGroups) {
				continue
			}
			candidates = append(candidates, group)
			break
		}
	}
	return candidates, nil
}

func memberMatchesUser(member model.BindingGroupMember, userKey string, userGroups []string) bool {
	switch member.SubjectType {
	case model.SubjectTypeUser:
		return member.Subject == userKey
	case model.SubjectTypeGroup:
		return slices.Contains(userGroups, member.Subject)
	default:
		return false
	}
}

// bindNamespaceToGroup 把命名空间归属到权限绑定组（路径 A）。
func bindNamespaceToGroup(group model.BindingGroup, namespace string) NamespaceBindingOutcome {
	// 先查占用：并发下唯一索引会兜底，但先查能给出更准确的日志与结论。
	owner, err := model.BindingGroupNamespaceOwner(group.Cluster, namespace, group.ID)
	if err != nil {
		klog.Errorf("auto bind namespace %s/%s: failed to check namespace ownership: %v",
			group.Cluster, namespace, err)
		return NamespaceBindingOutcome{Reason: NamespaceBindingReasonConflict}
	}
	if owner != nil {
		klog.Warningf("namespace %s/%s already belongs to binding group %q (%d), auto bind skipped",
			group.Cluster, namespace, owner.Name, owner.ID)
		return NamespaceBindingOutcome{Reason: NamespaceBindingReasonConflict}
	}

	err = model.DB.Create(&model.BindingGroupNamespace{
		ProjectID: group.ID,
		Cluster:   group.Cluster,
		Namespace: namespace,
	}).Error
	if err != nil {
		// 并发下唯一索引兜底：归属刚被别的组抢先占走。
		if model.IsUniqueConstraintError(err) {
			return NamespaceBindingOutcome{Reason: NamespaceBindingReasonConflict}
		}
		klog.Errorf("namespace %s/%s created but failed to bind to binding group %d: %v",
			group.Cluster, namespace, group.ID, err)
		return NamespaceBindingOutcome{}
	}

	rbac.TriggerSync()
	klog.Infof("namespace %s/%s auto bound to binding group %q (%d)",
		group.Cluster, namespace, group.Name, group.ID)
	return NamespaceBindingOutcome{
		Bound:       true,
		Method:      NamespaceBindingMethodGroup,
		BindingID:   group.ID,
		BindingName: group.Name,
	}
}

// appendNamespaceToUserRoles 是「路径 A 不适用」时的退化路径（路径 B）：把新命名空间
// 追加到该用户**直接持有**的、已限定命名空间范围的角色上，让创建者仍然看得见它。
//
// 只处理直接分配给该用户的角色：通过用户组分配的角色是整组成员共享的，往它的命名空间
// 列表里追加等于给整个组开权限，这种「共享一个新的命名空间」应当用权限绑定组（路径 A）
// 表达。内置角色（is_system）也不处理：它们由代码维护，升级时会按内置定义重建，
// 在这里追加的内容会被覆盖。
func appendNamespaceToUserRoles(
	user model.User,
	cluster, namespace, fallbackReason string,
) NamespaceBindingOutcome {
	var roleIDs []uint
	if err := model.DB.Model(&model.RoleAssignment{}).
		Where("subject_type = ? AND subject = ?", model.SubjectTypeUser, user.Key()).
		Pluck("role_id", &roleIDs).Error; err != nil {
		klog.Errorf("auto bind namespace %s/%s: failed to load roles of %s: %v",
			cluster, namespace, user.Key(), err)
		return NamespaceBindingOutcome{Reason: fallbackReason}
	}
	if len(roleIDs) == 0 {
		return NamespaceBindingOutcome{Reason: fallbackReason}
	}

	var roles []model.Role
	if err := model.DB.Where("id IN ? AND is_system = ?", roleIDs, false).Find(&roles).Error; err != nil {
		klog.Errorf("auto bind namespace %s/%s: failed to load roles: %v", cluster, namespace, err)
		return NamespaceBindingOutcome{Reason: fallbackReason}
	}

	updated := make([]string, 0, len(roles))
	for _, role := range roles {
		if !namespaceRestricted(role.Namespaces) ||
			!rbac.RoleCoversCluster(role.Clusters, cluster) ||
			slices.Contains(role.Namespaces, namespace) {
			continue
		}
		next := append(model.SliceString{}, role.Namespaces...)
		next = append(next, namespace)
		if err := model.DB.Model(&model.Role{}).
			Where("id = ?", role.ID).
			Update("namespaces", next).Error; err != nil {
			klog.Errorf("auto bind namespace %s/%s: failed to update role %q: %v",
				cluster, namespace, role.Name, err)
			continue
		}
		updated = append(updated, role.Name)
	}
	if len(updated) == 0 {
		return NamespaceBindingOutcome{Reason: fallbackReason}
	}

	rbac.TriggerSync()
	klog.Infof("namespace %s/%s added to namespaces of role(s) %s held by %s",
		cluster, namespace, strings.Join(updated, ", "), user.Key())
	return NamespaceBindingOutcome{
		Bound:  true,
		Method: NamespaceBindingMethodRoles,
		Roles:  updated,
	}
}

// namespaceRestricted 判断角色的命名空间列表是否已经限定了范围：空列表或含通配
// （* / _all）表示不约束，该角色本来就能看到全部命名空间（含新建的），无需追加。
func namespaceRestricted(list model.SliceString) bool {
	if len(list) == 0 {
		return false
	}
	for _, item := range list {
		if item == "*" || item == common.AllNamespaces {
			return false
		}
	}
	return true
}
