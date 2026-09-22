package bindinggroups

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"gorm.io/gorm"
	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/klog/v2"
)

// Handler 提供权限绑定组的管理接口。
// 全部挂在 adminAPI 组下，仅管理员可操作。
type Handler struct {
	cm *cluster.ClusterManager
}

func NewHandler(cm *cluster.ClusterManager) *Handler {
	return &Handler{cm: cm}
}

type bindingGroupReq struct {
	Cluster     string `json:"cluster" binding:"required"`
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
	// Global 为全局作用域：成员在全部集群与命名空间（含集群级资源）上持有绑定角色。
	Global bool `json:"global"`
}

// CreateBindingGroup 创建权限绑定组。
// 路由：POST /api/v1/admin/binding-groups
func (h *Handler) CreateBindingGroup(c *gin.Context) {
	var req bindingGroupReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var conflict int64
	// 不与 detached 组同名：DB 唯一索引 (cluster, name) 覆盖保留中的组，
	// 这里先查出来返回 409，而不是让插入失败返回 500。
	if err := model.DB.Model(&model.BindingGroup{}).
		Where("cluster = ? AND name = ?", req.Cluster, req.Name).
		Count(&conflict).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if conflict > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": model.ErrBindingGroupNameConflict.Error()})
		return
	}

	group := model.BindingGroup{
		Cluster:     req.Cluster,
		Name:        req.Name,
		Description: req.Description,
		Global:      req.Global,
	}
	if err := model.DB.Create(&group).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create binding group: " + err.Error()})
		return
	}
	rbac.TriggerSync()
	c.JSON(http.StatusCreated, gin.H{"bindingGroup": group})
}

// ListBindingGroups 列出权限绑定组；支持 ?cluster= 过滤（设置页跟随顶栏集群上下文）。
// ?detached=true 只列出被保留（所属集群已删除）的权限绑定组，用于重新绑定。
// 路由：GET /api/v1/admin/binding-groups
func (h *Handler) ListBindingGroups(c *gin.Context) {
	cluster := c.Query("cluster")
	detached := c.Query("detached") == "true"

	query := model.DB.Preload("Namespaces").Preload("Members.Role").
		Where("detached = ?", detached)
	if cluster != "" {
		query = query.Where("cluster = ?", cluster)
	}
	var groups []model.BindingGroup
	if err := query.Order("cluster asc, name asc").Find(&groups).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list binding groups: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"bindingGroups": groups})
}

// BindBindingGroup 把保留的权限绑定组绑定到集群：绑定后该组恢复参与授权。
// 路由：POST /api/v1/admin/binding-groups/:id/bind
func (h *Handler) BindBindingGroup(c *gin.Context) {
	group, ok := h.loadBindingGroup(c)
	if !ok {
		return
	}
	var req struct {
		Cluster string `json:"cluster" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := h.cm.GetClientSet(req.Cluster); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cluster not found: " + req.Cluster})
		return
	}

	bound, err := model.BindBindingGroupToCluster(group.ID, req.Cluster)
	if err != nil {
		if errors.Is(err, model.ErrBindingGroupNameConflict) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to bind binding group: " + err.Error()})
		return
	}
	rbac.TriggerSync()
	c.JSON(http.StatusOK, gin.H{"bindingGroup": bound})
}

// GetBindingGroup 项目详情。
// 路由：GET /api/v1/admin/binding-groups/:id
func (h *Handler) GetBindingGroup(c *gin.Context) {
	project, ok := h.loadBindingGroup(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"bindingGroup": project})
}

// UpdateBindingGroup 改名/描述。
// 路由：PUT /api/v1/admin/binding-groups/:id
func (h *Handler) UpdateBindingGroup(c *gin.Context) {
	project, ok := h.loadBindingGroup(c)
	if !ok {
		return
	}
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		// 指针：不传时保持原值，避免误把全局作用域关掉。
		Global *bool `json:"global"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Name != "" && req.Name != project.Name {
		var conflict int64
		if err := model.DB.Model(&model.BindingGroup{}).
			Where("cluster = ? AND name = ? AND id <> ?", project.Cluster, req.Name, project.ID).
			Count(&conflict).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if conflict > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": model.ErrBindingGroupNameConflict.Error()})
			return
		}
	}
	if req.Name != "" {
		project.Name = req.Name
	}
	project.Description = req.Description
	if req.Global != nil {
		project.Global = *req.Global
	}
	if err := model.DB.Save(&project).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update project: " + err.Error()})
		return
	}
	rbac.TriggerSync()
	c.JSON(http.StatusOK, gin.H{"bindingGroup": project})
}

// DeleteBindingGroup 删除权限绑定组：命名空间仅解绑（K8s 资源不受影响），成员与
// 归属关系一并删除。
//
// 子表显式删除，不依赖 ON DELETE CASCADE：SQLite 的外键约束取决于连接的
// PRAGMA foreign_keys，而连接池下该 pragma 并不一定对每个连接生效（与
// DeleteBindingGroupsByCluster 的做法一致）。
// 路由：DELETE /api/v1/admin/binding-groups/:id
func (h *Handler) DeleteBindingGroup(c *gin.Context) {
	project, ok := h.loadBindingGroup(c)
	if !ok {
		return
	}
	if project.Protected {
		c.JSON(http.StatusForbidden, gin.H{"error": "this binding group is protected and cannot be deleted"})
		return
	}
	// 组名 + 完整配置快照：权限绑定里存的是「谁在哪些命名空间上拿到哪些角色」，
	// 删除后组成员行会被一并清掉，只有快照能说清删掉了哪些授权。
	c.Set(common.AdminAuditDetailKey, common.AdminAuditDetail{
		ResourceName: project.Name,
		PreviousYAML: common.AdminAuditSnapshot(*project),
	})
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("project_id = ?", project.ID).
			Delete(&model.BindingGroupNamespace{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ?", project.ID).
			Delete(&model.BindingGroupMember{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", project.ID).Delete(&model.BindingGroup{}).Error
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete project: " + err.Error()})
		return
	}
	rbac.TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// SetBindingGroupNamespaces 全量设置权限绑定组内的命名空间。绑定前先把同命名空间从
// 其它权限绑定组解绑——实现"一个命名空间同一时间只属于一个权限绑定组"以及
// "命名空间可移动到其他权限绑定组"。
// 路由：PUT /api/v1/admin/binding-groups/:id/namespaces
func (h *Handler) SetBindingGroupNamespaces(c *gin.Context) {
	project, ok := h.loadBindingGroup(c)
	if !ok {
		return
	}
	var req struct {
		Namespaces []string `json:"namespaces" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 一个命名空间同一时间只属于一个权限绑定组：已被同集群的另一个组占用时直接拒绝，
	// 由管理员先到原组解绑，不做静默迁移（原组成员会无声失去该命名空间的权限）。
	if ns, owner, err := namespaceConflict(project.Cluster, req.Namespaces, project.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check namespace ownership: " + err.Error()})
		return
	} else if owner != nil {
		respondNamespaceTaken(c, ns, owner)
		return
	}

	err := model.DB.Transaction(func(tx *gorm.DB) error {
		// 先解绑所有归属在本权限绑定组的命名空间，再按请求重新绑定。
		if err := tx.Where("project_id = ?", project.ID).
			Delete(&model.BindingGroupNamespace{}).Error; err != nil {
			return err
		}
		// 成员按命名空间范围的绑定也要跟着收缩：组内已不包含的命名空间，
		// 针对它的绑定不再有任何效果，保留只会变成脏数据。
		prune := tx.Where("project_id = ? AND namespace <> ''", project.ID)
		if len(req.Namespaces) > 0 {
			prune = prune.Where("namespace NOT IN ?", req.Namespaces)
		}
		if err := prune.Delete(&model.BindingGroupMember{}).Error; err != nil {
			return err
		}
		for _, ns := range req.Namespaces {
			if ns == "" {
				continue
			}
			if err := tx.Create(&model.BindingGroupNamespace{
				ProjectID: project.ID,
				Cluster:   project.Cluster,
				Namespace: ns,
			}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		// 唯一索引 (cluster, namespace) 并发下兵家必争之地：把它也翻成 409，
		// 不让客户端看到一个无法理解的 500。
		if model.IsUniqueConstraintError(err) {
			c.JSON(http.StatusConflict, gin.H{
				"error": model.ErrBindingGroupNamespaceTaken.Error(),
				"code":  "binding_group_namespace_taken",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to set project namespaces: " + err.Error()})
		return
	}
	rbac.TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// namespaceConflict 找出在被检查的命名空间里，已被**同集群其它**权限绑定组占用的那一个。
// 返回第一个冲突的命名空间与其占用组；没有冲突时返回 ("", nil, nil)。
func namespaceConflict(cluster string, namespaces []string, exceptGroupID uint) (string, *model.BindingGroup, error) {
	for _, ns := range namespaces {
		if strings.TrimSpace(ns) == "" {
			continue
		}
		owner, err := model.BindingGroupNamespaceOwner(cluster, ns, exceptGroupID)
		if err != nil {
			return "", nil, err
		}
		if owner != nil {
			return ns, owner, nil
		}
	}
	return "", nil, nil
}

// respondNamespaceTaken 把「命名空间已被别的权限绑定组占用」回给客户端。
// 带上占用组信息，界面才能告诉管理员去哪个组解绑。
func respondNamespaceTaken(c *gin.Context, namespace string, owner *model.BindingGroup) {
	c.JSON(http.StatusConflict, gin.H{
		"error": model.ErrBindingGroupNamespaceTaken.Error(),
		"code":  "binding_group_namespace_taken",
		"params": gin.H{
			"namespace": namespace,
			"group":     owner.Name,
			"groupId":   owner.ID,
		},
	})
}

// CreateBindingGroupNamespace 在权限绑定组所属集群内创建命名空间，
// 并将其归属到该权限绑定组。
// 路由：POST /api/v1/admin/binding-groups/:id/namespaces/create
func (h *Handler) CreateBindingGroupNamespace(c *gin.Context) {
	group, ok := h.loadBindingGroup(c)
	if !ok {
		return
	}
	var req struct {
		Namespace string `json:"namespace" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 先确认该命名空间没被同集群的其它权限绑定组占用：放在创建 K8s 命名空间之前，
	// 否则会先建出一个归属不了的命名空间。
	if _, owner, err := namespaceConflict(group.Cluster, []string{req.Namespace}, group.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check namespace ownership: " + err.Error()})
		return
	} else if owner != nil {
		respondNamespaceTaken(c, req.Namespace, owner)
		return
	}

	cs, err := h.cm.GetClientSet(group.Cluster)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"error": "failed to get cluster client: " + err.Error(),
		})
		return
	}

	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: req.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "aerolink",
			},
		},
	}
	created, err := cs.K8sClient.ClientSet.CoreV1().Namespaces().
		Create(c.Request.Context(), ns, metav1.CreateOptions{})
	if err != nil {
		if k8serrors.IsAlreadyExists(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "namespace already exists"})
		} else {
			c.JSON(http.StatusBadGateway, gin.H{
				"error": "failed to create namespace: " + err.Error(),
			})
		}
		return
	}

	// 归属到本权限绑定组（占用检查已在创建前完成）。
	err = model.DB.Transaction(func(tx *gorm.DB) error {
		return tx.Create(&model.BindingGroupNamespace{
			ProjectID: group.ID,
			Cluster:   group.Cluster,
			Namespace: req.Namespace,
		}).Error
	})
	if err != nil {
		// 并发下唯一索引兜底：归属刚被别的组抢先占走。回 409 并尽量带上占用组，
		// 让界面能提示去哪个组解绑；此时 K8s 命名空间已建好，不会重复创建。
		if model.IsUniqueConstraintError(err) {
			if _, owner, lookupErr := namespaceConflict(group.Cluster, []string{req.Namespace}, group.ID); lookupErr == nil && owner != nil {
				respondNamespaceTaken(c, req.Namespace, owner)
				return
			}
			c.JSON(http.StatusConflict, gin.H{
				"error": model.ErrBindingGroupNamespaceTaken.Error(),
				"code":  "binding_group_namespace_taken",
			})
			return
		}
		// 命名空间已创建但归属失败：记录日志，前端可手动重新绑定。
		klog.Errorf("created namespace %s but failed to bind to group %d: %v",
			req.Namespace, group.ID, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "namespace created but failed to bind: " + err.Error(),
		})
		return
	}
	rbac.TriggerSync()
	c.JSON(http.StatusCreated, gin.H{
		"namespace": created.Name,
		"cluster":   group.Cluster,
	})
}

// EnsureClusterDefaults 为指定集群创建内置的默认授权配置（超级管理员的
// 全局作用域「超级权限绑定」组）。重新导入集群并选择「新建默认授权」时调用。
// 路由：POST /api/v1/admin/binding-groups/defaults
func (h *Handler) EnsureClusterDefaults(c *gin.Context) {
	var req struct {
		Cluster string `json:"cluster" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// 只要集群已注册即可（不要求客户端可用：集群短暂不可达时也应能补齐默认授权）。
	if _, err := model.GetClusterByName(req.Cluster); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cluster not found: " + req.Cluster})
		return
	}
	if err := model.EnsureSuperAdminProvisioningForCluster(req.Cluster); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create default authorizations: " + err.Error()})
		return
	}
	rbac.TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// GetBindingGroupMembers 成员列表（含各自绑定的角色）。
// 路由：GET /api/v1/admin/binding-groups/:id/members
func (h *Handler) GetBindingGroupMembers(c *gin.Context) {
	project, ok := h.loadBindingGroup(c)
	if !ok {
		return
	}
	var members []model.BindingGroupMember
	if err := model.DB.Preload("Role").
		Where("project_id = ?", project.ID).Find(&members).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list members: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"members": members})
}

// bindingGroupMemberInput 是「全量设置成员」请求里的一行：主体 × 命名空间范围 × 角色。
type bindingGroupMemberInput struct {
	SubjectType string `json:"subjectType" binding:"required"`
	Subject     string `json:"subject" binding:"required"`
	Namespace   string `json:"namespace"`
	RoleIDs     []uint `json:"roleIds"`
}

// separationOfDutiesViolation 检查这次成员写入会不会让某个用户同时持有互斥的管理员
// 角色（职责分离，等保三级）。返回冲突主体、冲突角色名与是否冲突。
//
// 只检查用户主体：用户组主体的成员关系由目录侧维护，写的时候无法预知未来成员，
// 靠判定层的兜底拦截（见 rbac.SeparationOfDutiesConflict）。同一用户在本组里被
// 多行授权时按并集判定。
func separationOfDutiesViolation(groupID uint, members []bindingGroupMemberInput) (string, []string, bool) {
	roleNames, err := roleNamesByID()
	if err != nil {
		klog.Errorf("failed to load role names for separation-of-duties check: %v", err)
		return "", nil, false
	}

	granted := make(map[string]map[string]struct{})
	subjects := make([]string, 0, len(members))
	for _, member := range members {
		if member.SubjectType != model.SubjectTypeUser {
			continue
		}
		subject := strings.TrimSpace(member.Subject)
		if subject == "" {
			continue
		}
		if _, ok := granted[subject]; !ok {
			granted[subject] = make(map[string]struct{})
			subjects = append(subjects, subject)
		}
		for _, roleID := range member.RoleIDs {
			if name, ok := roleNames[roleID]; ok {
				granted[subject][name] = struct{}{}
			}
		}
	}

	for _, subject := range subjects {
		user, err := model.GetUserByUsername(subject)
		if err != nil || user == nil {
			continue
		}
		names := make([]string, 0, len(granted[subject]))
		for name := range granted[subject] {
			names = append(names, name)
		}
		if conflict, roles := rbac.SeparationOfDutiesConflictOnGrant(*user, groupID, names...); conflict {
			return subject, roles, true
		}
	}
	return "", nil, false
}

// roleNamesByID 返回角色 ID → 名称的映射。
func roleNamesByID() (map[uint]string, error) {
	var roles []model.Role
	if err := model.DB.Select("id", "name").Find(&roles).Error; err != nil {
		return nil, err
	}
	names := make(map[uint]string, len(roles))
	for _, role := range roles {
		names[role.ID] = role.Name
	}
	return names, nil
}

// SetBindingGroupMembers 全量设置权限绑定组成员（用户/用户组 × 命名空间范围 × 多角色）。
// namespace 为空表示角色作用于组内全部命名空间；非空时只在该命名空间生效，
// 且必须是本权限绑定组当前归属的命名空间。
// 路由：PUT /api/v1/admin/binding-groups/:id/members
func (h *Handler) SetBindingGroupMembers(c *gin.Context) {
	project, ok := h.loadBindingGroup(c)
	if !ok {
		return
	}
	var req struct {
		Members []bindingGroupMemberInput `json:"members" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 可用的命名空间范围：空（全部）+ 组内当前归属的命名空间，
	// 防止前端传来已不属于本组的命名空间而留下永不生效的绑定。
	var groupNamespaces []string
	if err := model.DB.Model(&model.BindingGroupNamespace{}).
		Where("project_id = ?", project.ID).Pluck("namespace", &groupNamespaces).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load group namespaces: " + err.Error()})
		return
	}
	allowedScopes := map[string]struct{}{"": {}}
	for _, ns := range groupNamespaces {
		allowedScopes[ns] = struct{}{}
	}

	// 职责分离（等保三级）：权限绑定组同样能授予角色，写入前先拦住互斥组合。
	// 同一个组里把某人的 admin 换成 auditor 是合法变更，所以校验时排除本组
	// 当前授予他的角色（见 rbac.SeparationOfDutiesConflictOnGrant）。
	if subject, roles, conflict := separationOfDutiesViolation(project.ID, req.Members); conflict {
		c.JSON(http.StatusConflict, gin.H{
			"error":   "role_conflict",
			"code":    "role_conflict",
			"subject": subject,
			"roles":   roles,
		})
		return
	}

	err := model.DB.Transaction(func(tx *gorm.DB) error {
		// 受保护成员（例如初始化创建的超级管理员）不由全量设置接口移除：
		// 先取出，重写完成后再原样恢复。
		var protected []model.BindingGroupMember
		if err := tx.Where("project_id = ? AND protected = ?", project.ID, true).
			Find(&protected).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ?", project.ID).
			Delete(&model.BindingGroupMember{}).Error; err != nil {
			return err
		}
		seen := make(map[string]struct{})
		for _, m := range req.Members {
			namespace := strings.TrimSpace(m.Namespace)
			if _, ok := allowedScopes[namespace]; !ok {
				klog.V(1).Infof("skip member %s scope %q: not a namespace of binding group %d", m.Subject, namespace, project.ID)
				continue
			}
			for _, roleID := range m.RoleIDs {
				// 角色必须存在，防止悬挂引用。
				var count int64
				if err := tx.Model(&model.Role{}).Where("id = ?", roleID).
					Count(&count).Error; err != nil {
					return err
				}
				if count == 0 {
					klog.V(1).Infof("skip unknown role %d for project member %s", roleID, m.Subject)
					continue
				}
				// 同一「主体 × 命名空间 × 角色」只保留一行（唯一索引会拒绝重复插入）。
				key := m.SubjectType + "\x00" + m.Subject + "\x00" + namespace + "\x00" + strconv.FormatUint(uint64(roleID), 10)
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				if err := tx.Create(&model.BindingGroupMember{
					ProjectID:   project.ID,
					SubjectType: m.SubjectType,
					Subject:     m.Subject,
					Namespace:   namespace,
					RoleID:      roleID,
				}).Error; err != nil {
					return err
				}
			}
		}
		for _, m := range protected {
			// 每个语句都用一条**新**链：GORM 的链在 Count 之后会被复用为 UPDATE，
			// 导致生成的 SQL 里出现两张表而报 "ambiguous column name: project_id"。
			matchProtected := func() *gorm.DB {
				return tx.Model(&model.BindingGroupMember{}).
					Where("binding_group_members.project_id = ? AND binding_group_members.subject_type = ? AND binding_group_members.subject = ? AND binding_group_members.namespace = ? AND binding_group_members.role_id = ?",
						m.ProjectID, m.SubjectType, m.Subject, m.Namespace, m.RoleID)
			}
			var count int64
			if err := matchProtected().Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				// 请求里带了同一行：保留它，并确保受保护标记不被抹掉。
				if err := matchProtected().Update("protected", true).Error; err != nil {
					return err
				}
				continue
			}
			if err := tx.Create(&model.BindingGroupMember{
				ProjectID:   m.ProjectID,
				SubjectType: m.SubjectType,
				Subject:     m.Subject,
				Namespace:   m.Namespace,
				RoleID:      m.RoleID,
				Protected:   true,
			}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to set project members: " + err.Error()})
		return
	}
	rbac.TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// GetUserBindingGroups 返回当前用户可见的权限绑定组（成员身份），供导航与
// 命名空间分组展示使用。
// 路由：GET /api/v1/projects
func (h *Handler) GetUserBindingGroups(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	var projects []model.BindingGroup
	if err := model.DB.Preload("Namespaces").Find(&projects).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list projects: " + err.Error()})
		return
	}

	visible := rbac.UserVisibleBindingGroups(user)
	result := make([]model.BindingGroup, 0, len(visible))
	for _, p := range projects {
		if _, ok := visible[p.ID]; ok {
			result = append(result, p)
		}
	}
	c.JSON(http.StatusOK, gin.H{"bindingGroups": result})
}

func (h *Handler) loadBindingGroup(c *gin.Context) (*model.BindingGroup, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid project id"})
		return nil, false
	}
	var project model.BindingGroup
	if err := model.DB.Preload("Namespaces").Preload("Members.Role").
		First(&project, uint(id)).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "project not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return nil, false
	}
	return &project, true
}
