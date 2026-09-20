package model

import (
	"errors"

	"gorm.io/gorm"
)

// ErrBindingGroupNameConflict 目标集群中已存在同名权限绑定组。
var ErrBindingGroupNameConflict = errors.New("binding group name already exists in the target cluster")

// ErrBindingGroupNamespaceTaken 该命名空间已被同集群的另一个权限绑定组占用。
// 一个命名空间同一时间只能属于一个权限绑定组，因此不允许静默迁移：
// 原组的成员会无声失去该命名空间的权限，必须由管理员先在原组解绑。
var ErrBindingGroupNamespaceTaken = errors.New("namespace is already bound to another binding group in this cluster")

// BindingGroup 是集群下的「权限绑定组」（权限绑定组）：把命名空间、用户/用户组和
// 角色关联起来的授权容器。
//
// 授权语义：成员绑定的角色规则生效于权限绑定组内的全部命名空间（含加入权限绑定组
// 之后新建的）。角色自身不再携带命名空间范围，范围完全由权限绑定组决定。
type BindingGroup struct {
	Model

	// 所属集群：集群是最大的隔离边界，切换集群后权限绑定组与授权信息跟随集群。
	Cluster     string `json:"cluster" gorm:"type:varchar(100);not null;uniqueIndex:idx_project_cluster_name"`
	Name        string `json:"name" gorm:"type:varchar(100);not null;uniqueIndex:idx_project_cluster_name"`
	Description string `json:"description" gorm:"type:text"`

	// Detached 标记所属集群已被删除、配置被保留的权限绑定组：保留期间不参与授权，
	// 集群重新导入或指定其它集群后显式重新绑定才恢复生效。
	Detached bool `json:"detached" gorm:"type:boolean;not null;default:false;index"`

	// Global 表示全局作用域：成员绑定的角色对所有集群、所有命名空间（含以后新建的）
	// 以及集群级资源生效，即“超级权限”组。普通组只在组内命名空间的命名空间级资源上生效，
	// 例外是绑定的角色里资源通配 * 的授权（k8s:*:get 等）：它写的是整个集群，作用范围
	// 不受组内命名空间列表收窄，见 rbac 包的 bindingGroupAllowsClusterWide。
	Global bool `json:"global" gorm:"type:boolean;not null;default:false;index"`

	// Protected 标记初始化播种的超级管理员组：不可删除，且启动时会恢复其全局作用域。
	Protected bool `json:"protected" gorm:"type:boolean;not null;default:false"`

	Namespaces []BindingGroupNamespace `json:"namespaces" gorm:"foreignKey:ProjectID;constraint:OnDelete:CASCADE"`
	Members    []BindingGroupMember    `json:"members" gorm:"foreignKey:ProjectID;constraint:OnDelete:CASCADE"`
}

// CountBindingGroupsByCluster 统计集群下的权限绑定组数量（含已保留的）。
func CountBindingGroupsByCluster(cluster string) (int64, error) {
	var count int64
	err := DB.Model(&BindingGroup{}).Where("cluster = ?", cluster).Count(&count).Error
	return count, err
}

// RetainBindingGroupsByCluster 保留集群下的权限绑定组：标记为 detached，配置保留但
// 不再参与授权，等待集群重新导入后重新绑定。
func RetainBindingGroupsByCluster(cluster string) (int64, error) {
	result := DB.Model(&BindingGroup{}).
		Where("cluster = ? AND detached = ?", cluster, false).
		Update("detached", true)
	return result.RowsAffected, result.Error
}

// DeleteBindingGroupsByCluster 删除集群下的全部权限绑定组，连同命名空间归属与成员。
func DeleteBindingGroupsByCluster(cluster string) (int64, error) {
	var deleted int64
	err := DB.Transaction(func(tx *gorm.DB) error {
		var ids []uint
		if err := tx.Model(&BindingGroup{}).Where("cluster = ?", cluster).
			Pluck("id", &ids).Error; err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		// 显式删除关联数据，避免依赖数据库级联行为。
		if err := tx.Where("project_id IN ?", ids).
			Delete(&BindingGroupNamespace{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id IN ?", ids).
			Delete(&BindingGroupMember{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id IN ?", ids).Delete(&BindingGroup{}).Error; err != nil {
			return err
		}
		deleted = int64(len(ids))
		return nil
	})
	return deleted, err
}

// ListDetachedBindingGroups 列出被保留的权限绑定组；cluster 非空时只返回该集群名下的。
func ListDetachedBindingGroups(cluster string) ([]BindingGroup, error) {
	query := DB.Preload("Namespaces").Preload("Members.Role").
		Where("detached = ?", true)
	if cluster != "" {
		query = query.Where("cluster = ?", cluster)
	}
	var groups []BindingGroup
	err := query.Order("cluster asc, name asc").Find(&groups).Error
	return groups, err
}

// BindBindingGroupToCluster 把保留的权限绑定组绑定到集群，绑定后恢复授权生效。
func BindBindingGroupToCluster(id uint, cluster string) (*BindingGroup, error) {
	var group BindingGroup
	if err := DB.First(&group, id).Error; err != nil {
		return nil, err
	}
	if group.Cluster == cluster && !group.Detached {
		return &group, nil
	}
	var conflict int64
	if err := DB.Model(&BindingGroup{}).
		Where("cluster = ? AND name = ? AND id <> ?", cluster, group.Name, group.ID).
		Count(&conflict).Error; err != nil {
		return nil, err
	}
	if conflict > 0 {
		return nil, ErrBindingGroupNameConflict
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&group).Updates(map[string]interface{}{
			"cluster":  cluster,
			"detached": false,
		}).Error; err != nil {
			return err
		}
		// 命名空间归属携带所属集群（唯一性按集群判定），重新绑定必须一起迁移，
		// 否则组与归属记录的集群会不一致。
		var namespaces []string
		if err := tx.Model(&BindingGroupNamespace{}).Where("project_id = ?", group.ID).
			Pluck("namespace", &namespaces).Error; err != nil {
			return err
		}
		if len(namespaces) == 0 {
			return nil
		}
		// 目标集群中同名命名空间的归属让位（一个命名空间同一时间只属于一个组）。
		if err := tx.Where("cluster = ? AND namespace IN ? AND project_id <> ?", cluster, namespaces, group.ID).
			Delete(&BindingGroupNamespace{}).Error; err != nil {
			return err
		}
		return tx.Model(&BindingGroupNamespace{}).Where("project_id = ?", group.ID).
			Update("cluster", cluster).Error
	})
	if err != nil {
		return nil, err
	}
	group.Cluster = cluster
	group.Detached = false
	return &group, nil
}

// BindingGroupNamespaceOwner 返回同集群内已经占用该命名空间的权限绑定组，
// 没有被占用（或只被 exceptGroupID 占用）时返回 nil。
func BindingGroupNamespaceOwner(cluster, namespace string, exceptGroupID uint) (*BindingGroup, error) {
	var owner BindingGroup
	err := DB.Model(&BindingGroup{}).
		Joins("JOIN binding_group_namespaces ON binding_group_namespaces.project_id = binding_groups.id").
		Where("binding_group_namespaces.cluster = ? AND binding_group_namespaces.namespace = ?", cluster, namespace).
		Where("binding_groups.id <> ?", exceptGroupID).
		First(&owner).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &owner, nil
}

// BindingGroupNamespace 记录命名空间在权限绑定组中的归属。
// (cluster, namespace) 上的唯一索引保证「同一集群内一个命名空间同一时间只属于一个
// 权限绑定组」；集群是隔离边界，不同集群存在同名命名空间（default、kube-system 等），
// 因此唯一性不能跨集群判定。
type BindingGroupNamespace struct {
	Model

	ProjectID uint `json:"projectId" gorm:"not null;index"`
	// Cluster 冗余存储所属权限绑定组的集群：唯一索引必须带上集群维度，
	// 否则不同集群的同名命名空间会互相抢占。
	Cluster   string `json:"cluster" gorm:"type:varchar(100);not null;uniqueIndex:idx_binding_group_cluster_ns,priority:1"`
	Namespace string `json:"namespace" gorm:"type:varchar(100);not null;uniqueIndex:idx_binding_group_cluster_ns,priority:2"`
}

// BindingGroupMember 把用户/用户组与角色在权限绑定组内绑定起来。
// 一行 = 某主体在该权限绑定组中、某个命名空间范围内的一个角色绑定：
//   - Namespace 为空：作用于组内全部命名空间（含之后新加入的），即默认语义；
//   - Namespace 非空：只在该命名空间生效。
//
// 多角色 / 多命名空间 = 多行；同一角色可被多个成员引用（多对多）。
type BindingGroupMember struct {
	Model

	ProjectID   uint   `json:"projectId" gorm:"not null;uniqueIndex:idx_project_member_ns,priority:1"`
	SubjectType string `json:"subjectType" gorm:"type:varchar(20);not null;uniqueIndex:idx_project_member_ns,priority:2"` // user | group
	Subject     string `json:"subject" gorm:"type:varchar(255);not null;uniqueIndex:idx_project_member_ns,priority:3"`
	// Namespace 限定该角色绑定的生效命名空间；空字符串表示组内全部命名空间。
	Namespace string `json:"namespace" gorm:"type:varchar(100);not null;default:'';uniqueIndex:idx_project_member_ns,priority:4"`
	RoleID    uint   `json:"roleId" gorm:"not null;uniqueIndex:idx_project_member_ns,priority:5"`

	// Protected 标记受保护成员（如初始化创建的超级管理员）：全量设置成员时不会被移除。
	Protected bool `json:"protected" gorm:"type:boolean;not null;default:false"`

	Role Role `json:"role" gorm:"foreignKey:RoleID"`
}

// legacyBindingGroupMemberIndex 是引入命名空间范围之前的成员唯一索引名。
const legacyBindingGroupMemberIndex = "idx_project_member"

// MigrateBindingGroupMemberNamespace 删除旧的成员唯一索引：
// 旧索引 (project_id, subject_type, subject, role_id) 不允许同一成员把同一个角色
// 绑定到不同命名空间，而新的 idx_project_member_ns 已带上命名空间维度。
// AutoMigrate 不会重建同名但定义不同的索引，所以这里显式删除一次（可重复执行）。
func MigrateBindingGroupMemberNamespace() error {
	migrator := DB.Migrator()
	if !migrator.HasIndex(&BindingGroupMember{}, legacyBindingGroupMemberIndex) {
		return nil
	}
	if err := migrator.DropIndex(&BindingGroupMember{}, legacyBindingGroupMemberIndex); err != nil {
		return err
	}
	return nil
}

// SuperBindingGroupName 超级管理员所属权限绑定组的名称。
const SuperBindingGroupName = "超级权限绑定"

// SuperBindingGroupDescription 是「超级权限绑定」组的默认描述。
//
// 代次 3 起它的授权来源是系统管理员角色（原超级角色已并入 `admin`），因此描述里的
// 「超级角色」写法已经过时：存量库里仍是旧文案的行会在启动时刷新（见
// legacySuperBindingGroupDescriptions）。
const SuperBindingGroupDescription = "超级管理员权限绑定组：成员获得系统管理员（admin）角色的全部权限"

// legacySuperBindingGroupDescriptions 是历史版本的默认描述。启动时只把**完全等于**这些
// 内置文案的行改成当前文案：管理员自己写过的描述不会被覆盖。
var legacySuperBindingGroupDescriptions = []string{
	"超级管理员权限绑定组：成员获得超级角色的全部权限",
}

// isProtectedBindingGroupMember 判断用户名是否为某个权限绑定组的受保护成员
// （初始化创建的超级管理员）。受保护成员不允许从组里移除，其账号也不允许删除。
func isProtectedBindingGroupMember(username string) bool {
	if username == "" {
		return false
	}
	var count int64
	DB.Model(&BindingGroupMember{}).
		Where("subject_type = ? AND subject = ? AND protected = ?", SubjectTypeUser, username, true).
		Count(&count)
	return count > 0
}

// EnsureSuperAdminProvisioning 幂等地准备超级管理员的授权：
//   - 直接给标记的超级管理员分配最高权限角色（不依赖组配置）；
//   - 为每个集群创建全局作用域的「超级权限绑定」组，并把超级管理员加为受保护成员。
//
// 代次 3 起最高权限角色就是系统管理员（DefaultAdminRole）：原超级角色已并入它。
// 绑定组按集群存储，所以每个集群各有一份同名名单；全局作用域使成员在任意集群
// 都拥有该角色的全部权限。初始化完成后可重复调用。
func EnsureSuperAdminProvisioning() error {
	return ensureSuperAdminProvisioning("")
}

// EnsureSuperAdminProvisioningForCluster 只为指定集群补齐内置授权配置（超管角色 +
// 全局作用域的「超级权限绑定」组）：重新导入集群并选择「新建默认授权」时使用。
func EnsureSuperAdminProvisioningForCluster(cluster string) error {
	if cluster == "" {
		return EnsureSuperAdminProvisioning()
	}
	return ensureSuperAdminProvisioning(cluster)
}

func ensureSuperAdminProvisioning(onlyCluster string) error {
	adminRole, err := GetRoleByName(DefaultAdminRole.Name)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// 系统角色还未播种（应在 InitDefaultRole 之后调用）。
			return nil
		}
		return err
	}

	// 存量库补标：判别只做一次（见 flagExistingSuperAdmin）。这里无条件调用，
	// 因为「本次无需补标」也是一次判别结果，必须记下来，否则管理员删掉超级管理员
	// 之后重启会重新猜人。
	if err := flagExistingSuperAdmin(); err != nil {
		return err
	}
	// 内置描述的过时文案（把授权说成已退休的「超级角色」）一并刷新。
	if err := refreshSuperBindingGroupDescriptions(); err != nil {
		return err
	}

	var supers []User
	if err := DB.Where("is_super_admin = ?", true).Find(&supers).Error; err != nil {
		return err
	}
	if len(supers) == 0 {
		return nil
	}

	for _, super := range supers {
		if err := EnsureRoleAssignment(adminRole.Name, SubjectTypeUser, super.Username); err != nil {
			return err
		}
	}

	clusters, err := ListClusters()
	if err != nil {
		return err
	}
	for _, cluster := range clusters {
		if onlyCluster != "" && cluster.Name != onlyCluster {
			continue
		}
		group, err := ensureSuperBindingGroup(cluster.Name)
		if err != nil {
			return err
		}
		for _, super := range supers {
			if err := ensureProtectedGroupMember(group.ID, SubjectTypeUser, super.Username, adminRole.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// flagExistingSuperAdmin 兼容存量库：引入超级管理员标记之前，初始化向导创建的
// 账号就是唯一被直接分配 admin 角色的用户，把它补标为超级管理员。
//
// 只判别一次（记在 general_settings.super_admin_flagged）：管理员删掉超级管理员
// 之后如果每次启动都重新判别，标记就会落到「当时仍持有 admin 的账号」身上，凭空
// 长出一个删不掉的影子超级管理员。
//
// 判别条件刻意取严：库里有且仅有**一个**账号被直接分配 admin 角色时才补标。有多个
// 候选说明这不是初始化向导建出来的库，宁可不补，也不要猜错人。
func flagExistingSuperAdmin() error {
	// 先保证设置行存在（首次启动时可能还没建）。这一步必须在事务之外。
	setting, err := GetGeneralSetting()
	if err != nil {
		return err
	}
	if setting.SuperAdminFlagged {
		return nil
	}

	candidate, err := legacySuperAdminCandidate()
	if err != nil {
		return err
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&GeneralSetting{}).Where("id = ?", setting.ID).
			Update("super_admin_flagged", true).Error; err != nil {
			return err
		}
		if candidate == 0 {
			return nil
		}
		return tx.Model(&User{}).Where("id = ?", candidate).
			Update("is_super_admin", true).Error
	})
}

// legacySuperAdminCandidate 返回需要补标为超级管理员的账号 ID，0 表示本次无需补标
// （已经有标记账号，或者库的形态不适合猜人）。
func legacySuperAdminCandidate() (uint, error) {
	var flagged int64
	if err := DB.Model(&User{}).Where("is_super_admin = ?", true).Count(&flagged).Error; err != nil {
		return 0, err
	}
	if flagged > 0 {
		return 0, nil
	}

	var adminRole Role
	if err := DB.Where("name = ?", DefaultAdminRole.Name).First(&adminRole).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// 没有 admin 角色，无法稳妥判断，不动任何数据。
			return 0, nil
		}
		return 0, err
	}

	var candidates []string
	if err := DB.Model(&RoleAssignment{}).
		Where("role_id = ? AND subject_type = ?", adminRole.ID, SubjectTypeUser).
		Distinct().Pluck("subject", &candidates).Error; err != nil {
		return 0, err
	}
	if len(candidates) != 1 {
		return 0, nil
	}

	var user User
	if err := DB.Where("username = ?", candidates[0]).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}
	return user.ID, nil
}

func ensureSuperBindingGroup(cluster string) (*BindingGroup, error) {
	// 先按受保护标记找（管理员改名后也不会重复创建），再按默认名称兼容旧数据。
	var group BindingGroup
	err := DB.Where("cluster = ? AND protected = ?", cluster, true).First(&group).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = DB.Where("cluster = ? AND name = ?", cluster, SuperBindingGroupName).First(&group).Error
	}
	if err == nil {
		// 超级组必须保持全局作用域、未被保留且受保护，否则成员会静默失去权限。
		updates := map[string]interface{}{}
		if !group.Global {
			updates["global"] = true
			group.Global = true
		}
		if group.Detached {
			updates["detached"] = false
			group.Detached = false
		}
		if !group.Protected {
			updates["protected"] = true
			group.Protected = true
		}
		if len(updates) > 0 {
			if err := DB.Model(&group).Updates(updates).Error; err != nil {
				return nil, err
			}
		}
		return &group, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	group = BindingGroup{
		Cluster:     cluster,
		Name:        SuperBindingGroupName,
		Description: SuperBindingGroupDescription,
		Global:      true,
		Protected:   true,
	}
	if err := DB.Create(&group).Error; err != nil {
		return nil, err
	}
	return &group, nil
}

// refreshSuperBindingGroupDescriptions 把历史版本的**内置**描述整批刷新成当前文案。
//
// 这里用一条语句覆盖所有集群（包括已保留 / 已离集群的组），因为那些组不会被
// ensureSuperBindingGroup 逐个访问到；只改完全等于旧内置文案的行，不动管理员自己写的描述。
func refreshSuperBindingGroupDescriptions() error {
	return DB.Model(&BindingGroup{}).
		Where("description IN ?", legacySuperBindingGroupDescriptions).
		Update("description", SuperBindingGroupDescription).Error
}

func ensureProtectedGroupMember(groupID uint, subjectType, subject string, roleID uint) error {
	var member BindingGroupMember
	err := DB.Where("project_id = ? AND subject_type = ? AND subject = ? AND role_id = ?",
		groupID, subjectType, subject, roleID).First(&member).Error
	if err == nil {
		if member.Protected {
			return nil
		}
		return DB.Model(&member).Update("protected", true).Error
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	return DB.Create(&BindingGroupMember{
		ProjectID:   groupID,
		SubjectType: subjectType,
		Subject:     subject,
		RoleID:      roleID,
		Protected:   true,
	}).Error
}
