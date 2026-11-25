package rbac

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
	"github.com/gzwxh/aerolink/pkg/notification"
	"gorm.io/gorm"
)

// roleReq 是角色新建 / 更新的请求体。角色只由集群、资源、动作定义：
// 命名空间范围不再属于角色，而由权限绑定组（命名空间 + 主体 + 角色）决定。
// 因此请求体里不再接受 namespaces / roleType 这两个旧字段——存量角色里已存的
// 值会被原样保留（不被写入路径改写），判定逻辑见 pkg/rbac/rbac.go 的兼容分支。
//
// grants 按资源保存操作集合（资源 × 操作一一对应）；resources / verbs 为兼容字段，
// 不传时后端会从 grants 推导并集（旧客户端、旧表单仍可只传笛卡尔积形式）。
//
// 没有 clusters 字段：角色是**全局**的，不区分集群（生效范围由权限绑定表达）。
// 旧客户端仍可把它传进来，但会被忽略。
//
// displayName 是可选的界面展示名：只影响界面文案，不参与授权判定；留空表示未自定义，
// 界面回落到内置名或 name。name 才是角色 ID，创建后不再允许改名。
type roleReq struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"displayName"`
	Description string   `json:"description"`
	Resources   []string `json:"resources"`
	Verbs       []string `json:"verbs"`
	Grants      []struct {
		Resource string   `json:"resource"`
		Verbs    []string `json:"verbs"`
	} `json:"grants"`
}

// toRole 依据请求构造一个角色。RoleType 保持其存储默认值
// ('user')；已废弃的命名空间范围不再可设置。
func (req roleReq) toRole() model.Role {
	role := model.Role{
		Name:        strings.TrimSpace(req.Name),
		DisplayName: strings.TrimSpace(req.DisplayName),
		Description: req.Description,
		// 角色全局生效（clusters = "*"）；集群与命名空间范围由权限绑定决定。
		Clusters:  model.SliceString{"*"},
		Resources: model.SliceString(req.Resources),
		Verbs:     model.SliceString(req.Verbs),
	}
	for _, grant := range req.Grants {
		resource := strings.TrimSpace(grant.Resource)
		if resource == "" {
			continue
		}
		role.Grants = append(role.Grants, model.ResourceGrant{
			Resource: resource,
			Verbs:    cleanVerbs(grant.Verbs),
		})
	}
	if len(role.Grants) > 0 {
		// resources / verbs 是 grants 的并集：列出操作集合时保持兼容。
		role.Resources = model.SliceString(grantResources(role.Grants))
		role.Verbs = model.SliceString(grantVerbUnion(role.Grants))
	}
	return role
}

// cleanVerbs 去除空白与重复项，保留顺序。
func cleanVerbs(verbs []string) []string {
	cleaned := make([]string, 0, len(verbs))
	seen := make(map[string]struct{}, len(verbs))
	for _, verb := range verbs {
		verb = strings.TrimSpace(verb)
		if verb == "" {
			continue
		}
		if _, ok := seen[verb]; ok {
			continue
		}
		seen[verb] = struct{}{}
		cleaned = append(cleaned, verb)
	}
	return cleaned
}

func grantResources(grants model.ResourceGrants) []string {
	resources := make([]string, 0, len(grants))
	for _, grant := range grants {
		resources = append(resources, grant.Resource)
	}
	return resources
}

func grantVerbUnion(grants model.ResourceGrants) []string {
	verbs := make([]string, 0)
	seen := make(map[string]struct{})
	for _, grant := range grants {
		for _, verb := range grant.Verbs {
			if _, ok := seen[verb]; ok {
				continue
			}
			seen[verb] = struct{}{}
			verbs = append(verbs, verb)
		}
	}
	return verbs
}

// roleNameReserved 报告该名称是否被内置角色占用——这些角色必须保持唯一且不会混淆：
// 最高权限角色（admin）、已退役的 super 角色名
// （一个叫这个名字的自定义角色会被误认为是旧的应急入口，
// 见 RetireSuperRole）以及其余受保护的内置角色。
func roleNameReserved(name string) bool {
	if name == model.DefaultAdminRole.Name || name == model.SuperRoleName {
		return true
	}
	return model.IsProtectedRoleName(name)
}

// protectedRoleError 说明受保护角色为什么不能改 / 不能删。
//
// 三种受保护原因不同，必须分开说：
//   - admin 是最高权限角色（代次 3 起不受限），它的定义就是“最高权限”本身；
//   - security-admin / auditor 是职责分离的支点，能改就能把它们改回去；
//   - viewer / cluster-admin / cluster-viewer 不参与职责分离，但它们的规则由代码维护，
//     改乱或删掉就不再是「全部资源的只读入口 / 集群的全权与只读入口」。
func protectedRoleError(roleName, action string) string {
	if roleName == model.DefaultAdminRole.Name {
		if action == "deleted" {
			return fmt.Sprintf("the highest-privilege role %s is protected and cannot be deleted", roleName)
		}
		return fmt.Sprintf("the highest-privilege role %s is protected: its permissions cannot be modified", roleName)
	}
	if roleName == model.DefaultViewerRole.Name ||
		roleName == model.DefaultClusterAdminRole.Name ||
		roleName == model.DefaultClusterViewerRole.Name {
		return fmt.Sprintf("the built-in %s role is maintained in code and cannot be %s", roleName, action)
	}
	return fmt.Sprintf("the built-in %s role is required by the three-way separation of duties and cannot be %s", roleName, action)
}

// ListRoles 返回所有角色及其授权关系
func ListRoles(c *gin.Context) {
	var roles []model.Role
	if err := model.DB.Preload("Assignments").Find(&roles).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list roles: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"roles": roles})
}

// ListGroups 返回当前已知的所有组名（LDAP/OIDC 同步来的、手动分配的、
// 或显式持久化的），供角色授权选择器使用。
func ListGroups(c *gin.Context) {
	infos, err := model.ListGroupInfos()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list groups: " + err.Error()})
		return
	}
	// groups 保持纯名称数组（既有调用方依赖它），sources / descriptions 是并行的来源说明：
	// local = 控制台创建；ldap / oidc = 目录同步发现；description 是控制台本地备注。
	groups := make([]string, 0, len(infos))
	sources := make(map[string]string, len(infos))
	descriptions := make(map[string]string, len(infos))
	for _, info := range infos {
		groups = append(groups, info.Name)
		sources[info.Name] = info.Source
		if info.Description != "" {
			descriptions[info.Name] = info.Description
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"groups":       groups,
		"sources":      sources,
		"descriptions": descriptions,
	})
}

// ListGroupMembers 从规范化的 group_members 表返回某个组的成员。
func ListGroupMembers(c *gin.Context) {
	name := c.Param("name")
	members, err := model.ListGroupMembers(name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list group members: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"members": members})
}

// ListAllGroupMembers 返回所有用户组及其成员用户名（group -> usernames），
// 供权限绑定组列表把「用户组」主体连同它覆盖的用户一起展示。
// 路由：GET /api/v1/admin/group-members
func ListAllGroupMembers(c *gin.Context) {
	groups, err := model.ListGroupMembersMap()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list group members: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"groups": groups})
}

// CreateGroup 把用户组作为实体持久化，这样即使它还没有成员
// 或角色授权，也依然可见。
func CreateGroup(c *gin.Context) {
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "group name is required"})
		return
	}
	exists, err := model.LocalGroupExists(name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create group: " + err.Error()})
		return
	}
	if exists {
		c.JSON(http.StatusConflict, gin.H{"error": "group already exists"})
		return
	}
	if err := model.CreateLocalGroup(name, strings.TrimSpace(req.Description)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create group: " + err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"name": name})
}

// UpdateGroupDescription 设置用户组的描述（控制台本地备注）。
//
// 描述不参与授权，也不参与目录同步，因此目录来源的组也能标注；这与改名 / 删除不同，
// 那两者会与目录同步互相覆盖。
// 路由：PUT /api/v1/admin/groups/:name/description
func UpdateGroupDescription(c *gin.Context) {
	name := strings.TrimSpace(c.Param("name"))
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "group name is required"})
		return
	}
	var req struct {
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	description := strings.TrimSpace(req.Description)
	if err := model.SetLocalGroupDescription(name, description); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update group description: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"name": name, "description": description})
}

// RenameGroup 原子地重命名一个已持久化的组，以及它的每一处引用
// （用户资料与角色授权）。
func RenameGroup(c *gin.Context) {
	name := c.Param("name")
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	newName := strings.TrimSpace(req.Name)
	if newName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "group name is required"})
		return
	}
	if newName == name {
		c.JSON(http.StatusOK, gin.H{"name": newName})
		return
	}
	// 目录来源的组由 LDAP / OIDC 同步维护：在控制台改名会在下次同步时被覆盖回原名，
	// 造成成员关系错乱，因此一律拒绝，请到目录侧修改。
	source, err := model.LocalGroupSource(name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read group: " + err.Error()})
		return
	}
	if source != model.GroupSourceLocal {
		c.JSON(http.StatusConflict, gin.H{
			"error": "this group comes from the directory and is renamed there, not in the console",
			"code":  "group_directory_managed",
		})
		return
	}
	if err := model.RenameLocalGroup(name, newName); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to rename group: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"name": newName})
}

// DeleteGroup 删除一个已持久化的组及其所有引用
// （用户资料上的成员关系与以组为主体的角色授权）。
func DeleteGroup(c *gin.Context) {
	name := c.Param("name")
	if err := model.DeleteLocalGroup(name); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete group: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// AddGroupMember 把一个用户加入用户组，记为**本地附加**成员关系。
//
// 路由：POST /api/v1/admin/groups/:name/members {username}（需 settings.users 写权限）。
//
// 目录来源的账号（LDAP / OIDC）同样可以加：它们的目录组由同步维护，本地附加组
// （group_members.source = local）不会被目录同步移除，并随之获得绑定在该组上的角色。
func AddGroupMember(c *gin.Context) {
	name := strings.TrimSpace(c.Param("name"))
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "group name is required"})
		return
	}
	var req struct {
		Username string `json:"username"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username is required"})
		return
	}
	user, err := model.GetUserByUsername(username)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if err := model.AddLocalGroupMember(user.ID, name); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add group member: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// RemoveGroupMember 移除一条**本地附加**成员关系。
//
// 路由：DELETE /api/v1/admin/groups/:name/members/:username（需 settings.users 写权限）。
//
// 目录带来的成员关系不受影响（目录移除后由下一次同步收回）；此时返回 409 并说明原因，
// 避免界面以为已经移除、刷新后又出现。该用户根本不是这个组的成员时返回 404。
func RemoveGroupMember(c *gin.Context) {
	name := strings.TrimSpace(c.Param("name"))
	username := strings.TrimSpace(c.Param("username"))
	if name == "" || username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "group name and username are required"})
		return
	}
	user, err := model.GetUserByUsername(username)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	local, err := model.IsLocalGroupMember(user.ID, name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read group membership: " + err.Error()})
		return
	}
	if !local {
		// 有两种「不是本地成员」：成员关系由目录管辖（只能在目录里改），
		// 以及压根不在这个组里。二者的处理方式不同，不能都给 409。
		member, err := model.IsGroupMember(user.ID, name)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read group membership: " + err.Error()})
			return
		}
		if !member {
			c.JSON(http.StatusNotFound, gin.H{"error": "user is not a member of this group"})
			return
		}
		c.JSON(http.StatusConflict, gin.H{
			"error": "this membership comes from the directory and is removed there, not in the console",
			"code":  "group_member_directory_managed",
		})
		return
	}
	if err := model.RemoveLocalGroupMember(user.ID, name); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove group member: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// GetRole 按 id 返回单个角色
func GetRole(c *gin.Context) {
	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var role model.Role
	if err := model.DB.Preload("Assignments").First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"role": role})
}

// CreateRole 创建一个新角色
func CreateRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	var req roleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	role := req.toRole()
	if role.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role name is required"})
		return
	}
	// 代次 3 起最高权限角色就是系统管理员，而它是受保护角色（不可修改、不可删除），
	// 因此新增角色不得再冒用它的名称（也不能用已退休的 super-admin）。
	if roleNameReserved(role.Name) {
		c.JSON(http.StatusConflict, gin.H{
			"error": fmt.Sprintf("the name %q is reserved for the built-in administrator role", role.Name),
			"code":  "role_name_reserved",
		})
		return
	}
	if err := model.DB.Create(&role).Error; err != nil {
		if model.IsUniqueConstraintError(err) {
			c.JSON(http.StatusConflict, gin.H{
				"error": fmt.Sprintf("a role named %q already exists", role.Name),
				"code":  "role_name_conflict",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create role: " + err.Error()})
		return
	}
	// 刷新内存中的配置
	TriggerSync()
	c.JSON(http.StatusCreated, gin.H{"role": role})
}

// UpdateRole 更新一个已有角色
func UpdateRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var req roleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var role model.Role
	if err := model.DB.First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}
	// 等保三员角色与只读管理员的定义直接在代码中维护，不能在控制台修改（只能"恢复默认"）。
	if model.IsProtectedRoleName(role.Name) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": protectedRoleError(role.Name, "modified"),
			"code":  "protected_role_immutable",
		})
		return
	}
	roleData := req.toRole()
	if roleData.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role name is required"})
		return
	}
	// 系统角色的规则（集群/资源/动作）与描述可以像自定义角色一样调整，但名称是权限
	// 判定依据（例如 admin 用于放行管理接口），保持固定。
	if role.IsSystem && roleData.Name != role.Name {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "system role name cannot be changed",
			"code":  "system_role_name_immutable",
		})
		return
	}
	// 代次 3 起最高权限角色就是系统管理员，而它是受保护角色（不可修改、不可删除），
	// 因此新增角色不得再冒用它的名称。
	if roleData.Name != role.Name && roleNameReserved(roleData.Name) {
		c.JSON(http.StatusConflict, gin.H{
			"error": fmt.Sprintf("the name %q is reserved for the built-in administrator role", roleData.Name),
			"code":  "role_name_reserved",
		})
		return
	}
	// update fields（存量的 namespaces / roleType 保持原值：这里不改写它们）
	role.Name = roleData.Name
	// 「名称」随时可改：空值表示回到未自定义状态（界面显示内置名 / 角色 ID）。
	role.DisplayName = roleData.DisplayName
	role.Description = roleData.Description
	// 角色始终全局：不接受客户端传入的集群限制（存量值也在这里被归一化）。
	role.Clusters = model.SliceString{"*"}
	role.Resources = roleData.Resources
	role.Verbs = roleData.Verbs
	role.Grants = roleData.Grants

	if err := model.DB.Save(&role).Error; err != nil {
		if model.IsUniqueConstraintError(err) {
			c.JSON(http.StatusConflict, gin.H{
				"error": fmt.Sprintf("a role named %q already exists", role.Name),
				"code":  "role_name_conflict",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update role: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusOK, gin.H{"role": role})
}

// DeleteRole 删除一个角色及其授权关系
func DeleteRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var role model.Role
	// Preload 直接分配：它们会随角色一起删掉，得进审计快照（见下面的审计详情）。
	if err := model.DB.Preload("Assignments").First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}
	// 这条路由没有请求体，审计中间件只能从路径推断出 `#6`；把角色名与配置快照交出去，
	// 三个分支（删除成功、受保护角色被拒、仍被权限绑定引用被拒）才都能查到动的是谁、
	// 删掉的是什么。
	c.Set(common.AdminAuditDetailKey, common.AdminAuditDetail{
		ResourceName: role.Name,
		PreviousYAML: common.AdminAuditSnapshot(role),
	})
	// 所有内置系统角色（系统管理员、安全管理员、审计管理员、只读管理员）均不可删除。
	if model.IsProtectedRoleName(role.Name) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": protectedRoleError(role.Name, "deleted"),
			"code":  "protected_role_immutable",
		})
		return
	}
	// 角色还绑在权限绑定组里时不允许直接删除：删角色会连带删掉组成员行
	// （见 deleteRoleReferences），对管理员来说就是「某个组的授权悄悄少了」，
	// 事后无法归因。要求先到「权限绑定」里解绑，再回来删角色。
	groups, err := model.BindingGroupsUsingRole(role.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check the role's binding groups: " + err.Error()})
		return
	}
	if len(groups) > 0 {
		names := make([]string, 0, len(groups))
		for _, group := range groups {
			names = append(names, fmt.Sprintf("%s (%s)", group.Name, group.Cluster))
		}
		c.JSON(http.StatusConflict, gin.H{
			"error": fmt.Sprintf("the role is still used by %d permission binding group(s)", len(groups)),
			"code":  "role_in_use_by_binding_group",
			"params": gin.H{
				"count":  len(groups),
				"groups": strings.Join(names, ", "),
			},
		})
		return
	}
	if err := model.DB.Transaction(func(tx *gorm.DB) error {
		if err := deleteRoleReferences(tx, role.ID); err != nil {
			return err
		}
		return tx.Delete(&role).Error
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete role: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// deleteRoleReferences 删掉角色残留的引用（直接分配 + 权限绑定组成员）。
//
// 权限绑定组里的引用在正常路径上已被 DeleteRole 挡在前面（要求先解绑），这里保留
// 作为兜底：并发下仍可能有成员行插进来。不做的话这些行会指向一个不存在的
// role_id：既静默失效，又会在角色被重建后（自增 ID 不同）继续悬空——而超级角色
// 恰恰会被显式重建，悬空的成员行会让「超级权限绑定」组里的超级管理员拿不到权限。
func deleteRoleReferences(tx *gorm.DB, roleID uint) error {
	return model.DeleteRoleReferences(tx, roleID)
}

// 授权相关接口
type roleAssignmentReq struct {
	SubjectType string `json:"subjectType" binding:"required"`
	Subject     string `json:"subject" binding:"required"`
}

// AssignRole 把角色分配给用户或组
func AssignRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var req roleAssignmentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// 校验主体类型
	if req.SubjectType != model.SubjectTypeUser && req.SubjectType != model.SubjectTypeGroup {
		c.JSON(http.StatusBadRequest, gin.H{"error": "subjectType must be 'user' or 'group'"})
		return
	}
	// 确认角色存在
	var role model.Role
	if err := model.DB.First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}

	// 职责分离（等保三级）：直接分配角色时先拦住互斥组合，而不是先写进去、
	// 再让管理面全部 403（那种状态很难排查）。
	if req.SubjectType == model.SubjectTypeUser {
		if conflict, names := conflictForUserNamed(req.Subject, role.Name); conflict {
			c.JSON(http.StatusConflict, gin.H{
				"error": "role_conflict",
				"code":  "role_conflict",
				"roles": names,
			})
			return
		}
	}
	// 检查是否已存在
	var existing model.RoleAssignment
	if err := model.DB.Where("role_id = ? AND subject_type = ? AND subject = ?", role.ID, req.SubjectType, req.Subject).First(&existing).Error; err == nil {
		c.JSON(http.StatusOK, gin.H{"assignment": existing})
		return
	}

	assignment := model.RoleAssignment{
		RoleID:      role.ID,
		SubjectType: req.SubjectType,
		Subject:     req.Subject,
	}
	if err := model.DB.Create(&assignment).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create assignment: " + err.Error()})
		return
	}
	TriggerSync()
	notifyRoleChange(model.NotificationEventRoleAssigned, role.Name, req.SubjectType, req.Subject)
	c.JSON(http.StatusCreated, gin.H{"assignment": assignment})
}

// UnassignRole 移除一条授权。接受 subjectType 与 subject 查询参数。
func UnassignRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	subjectType := c.Query("subjectType")
	subject := c.Query("subject")
	if subjectType == "" || subject == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "subjectType and subject query params are required"})
		return
	}
	var role model.Role
	if err := model.DB.First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}
	// 没有请求体：不补充的话审计里只有 `#6/assign`，看不出收回的是谁对哪个角色的分配。
	c.Set(common.AdminAuditDetailKey, common.AdminAuditDetail{
		ResourceName: fmt.Sprintf("%s ← %s:%s", role.Name, subjectType, subject),
	})
	if err := model.DB.Where("role_id = ? AND subject_type = ? AND subject = ?", uint(dbID), subjectType, subject).Delete(&model.RoleAssignment{}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove assignment: " + err.Error()})
		return
	}
	TriggerSync()
	notifyRoleChange(model.NotificationEventRoleUnassigned, role.Name, subjectType, subject)
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// notifyRoleChange 通知受影响的用户（仅限直接分配给用户的角色；
// 组级别的变更会波及很多成员，因此不通知）他们的角色发生了变化，
// 这样权限差异不会让人措手不及。
func notifyRoleChange(event string, roleName, subjectType, subject string) {
	if event != model.NotificationEventRoleAssigned &&
		event != model.NotificationEventRoleUnassigned {
		return
	}
	if subjectType != string(model.SubjectTypeUser) {
		return
	}
	user, err := model.GetUserByUsername(strings.TrimSpace(subject))
	if err != nil || user == nil || !user.Enabled {
		return
	}
	notification.SendEventTo(event, map[string]string{
		"username": user.Username,
		"role":     roleName,
		"time":     time.Now().Format("2006-01-02 15:04:05"),
	}, user.ID)
}

// conflictForUserNamed 报告把 roleName 授予该用户名下的用户是否会
// break the mutual-exclusion rules (职责分离). Unknown or anonymous subjects are
// 被忽略：此时还没有任何东西会与之冲突。
func conflictForUserNamed(username, roleName string) (bool, []string) {
	user, err := model.GetUserByUsername(strings.TrimSpace(username))
	if err != nil || user == nil {
		return false, nil
	}
	return SeparationOfDutiesConflictWith(*user, roleName)
}

// RoleConflictSubject 是一个职责分离冲突的账号：它同时持有互斥的管理员角色。
type RoleConflictSubject struct {
	Username string   `json:"username"`
	Name     string   `json:"name,omitempty"`
	Enabled  bool     `json:"enabled"`
	Roles    []string `json:"roles"`
}

// ListRoleConflicts 列出同时持有互斥管理员角色的账号（职责分离巡检）。
//
// 这些账号的管理面已被整体拒绝（见 rbac.CanAccessAdminAPI），但它们的角色不会自动
// 改正——需要由安全管理员解绑其中一个角色。权限管理页据此提示，避免用户碰到
// 「明明有角色却什么都打不开」却查不出原因。
//
// 路由：GET /api/v1/admin/role-conflicts
func ListRoleConflicts(c *gin.Context) {
	var users []model.User
	if err := model.DB.Find(&users).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list users: " + err.Error()})
		return
	}

	conflicts := make([]RoleConflictSubject, 0)
	for _, user := range users {
		if conflict, roles := SeparationOfDutiesConflict(user); conflict {
			conflicts = append(conflicts, RoleConflictSubject{
				Username: user.Username,
				Name:     user.Name,
				Enabled:  user.Enabled,
				Roles:    roles,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"conflicts": conflicts})
}

// RestoreRoleDefaults 把一个内置系统角色重置为随程序发布的定义
// this release (等保三级三权分立要求的内置三员角色就靠它或一次性迁移落地）。
//
// 路由：POST /api/v1/admin/roles/:id/restore_defaults
func RestoreRoleDefaults(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}
	dbID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var role model.Role
	if err := model.DB.First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}
	if !role.IsSystem {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "only system roles have defaults to restore",
			"code":  "not_a_system_role",
		})
		return
	}
	if err := model.RestoreSystemRoleDefaults(role.Name); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to restore default role: " + err.Error()})
		return
	}
	if err := model.DB.First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to reload role: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusOK, gin.H{"role": role})
}
