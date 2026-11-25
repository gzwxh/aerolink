package model

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/gzwxh/aerolink/pkg/common"
	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

// ResourceGrant 是「资源 → 该资源上允许的操作」的一条授权。角色按资源分别保存
// 操作集合，因此同一角色里不同资源可以拥有不同操作。
type ResourceGrant struct {
	Resource string   `json:"resource"`
	Verbs    []string `json:"verbs"`
}

// ResourceGrants 以 JSON 文本落库（列类型 text）。为空表示角色沿用旧语义：
// Resources × Verbs 的笛卡尔积（存量角色、系统角色）。
type ResourceGrants []ResourceGrant

func (g *ResourceGrants) Scan(value interface{}) error {
	if value == nil {
		*g = nil
		return nil
	}
	var raw []byte
	switch v := value.(type) {
	case string:
		raw = []byte(v)
	case []byte:
		raw = v
	default:
		return fmt.Errorf("cannot scan %T into ResourceGrants", value)
	}
	if len(raw) == 0 {
		*g = nil
		return nil
	}
	var grants ResourceGrants
	if err := json.Unmarshal(raw, &grants); err != nil {
		return fmt.Errorf("failed to decode resource grants: %w", err)
	}
	*g = grants
	return nil
}

func (g ResourceGrants) Value() (driver.Value, error) {
	if len(g) == 0 {
		return "", nil
	}
	encoded, err := json.Marshal(g)
	if err != nil {
		return nil, err
	}
	return string(encoded), nil
}

type Role struct {
	Model

	Name string `json:"name" gorm:"type:varchar(100);uniqueIndex;not null"`
	// DisplayName 是界面上展示用的「名称」，可自定义、可留空。留空表示未自定义：
	// 界面回落到内置名（内置角色，随语言切换）或 Name（自定义角色）。它只影响文案，
	// Name 才是权限判定与绑定的依据。
	DisplayName string `json:"displayName" gorm:"type:varchar(100)"`
	Description string `json:"description" gorm:"type:text"`
	IsSystem    bool   `json:"isSystem" gorm:"type:boolean;not null;default:false"`

	// RoleType 区分面向单个用户的角色（'user'）与
	// 面向 LDAP/OIDC 组的角色（'group'）。空值按 'user' 处理。
	RoleType string `json:"roleType" gorm:"type:varchar(10);not null;default:'user'"`

	// 规则
	Clusters   SliceString `json:"clusters" gorm:"type:text"`
	Resources  SliceString `json:"resources" gorm:"type:text"`
	Namespaces SliceString `json:"namespaces" gorm:"type:text"`
	Verbs      SliceString `json:"verbs" gorm:"type:text"`

	// Grants 按资源保存操作集合（资源 × 操作一一对应）；为空时退回
	// Resources × Verbs 的旧语义。Resources / Verbs 在新版角色里是 Grants 的
	// 并集，仅供兼容读取（列表展示、旧客户端）。
	Grants ResourceGrants `json:"grants" gorm:"type:text"`

	Assignments []RoleAssignment `json:"assignments" gorm:"foreignKey:RoleID;constraint:OnDelete:CASCADE"`
}

// RoleAssignment 把角色映射到主体，主体可以是用户或 OIDC 组。
// SubjectType：'user' 或 'group'
type RoleAssignment struct {
	Model

	RoleID uint `json:"roleId" gorm:"index;not null;constraint:OnDelete:CASCADE"`

	SubjectType string `json:"subjectType" gorm:"type:varchar(20);not null;index:idx_role_assignments_subject,priority:2"`
	Subject     string `json:"subject" gorm:"type:varchar(255);not null;index:idx_role_assignments_subject,priority:1"`
}

// SubjectType 的便捷常量
const (
	SubjectTypeUser  = "user"
	SubjectTypeGroup = "group"
)

var (
	// DefaultAdminRole 系统管理员：控制台与集群的最高权限角色。
	//
	// 它是**唯一**的「超级管理员」角色（代次 3 把原内置超级角色 `super-admin` 并入
	// 本角色，见 RetireSuperRole）：全部 Kubernetes 资源 + 全部控制台设置章节。
	//
	// 注意这与等保三级「三权分立」的原始设定不同：原设定要求系统管理员不掌握安全
	// 策略与审计日志（见 DefaultSecurityAdminRole / DefaultAuditorRole）。合并是一次
	// 经确认的偏离，需按新版等保方案重新评估；`security-admin` 与 `auditor` 仍然存在，
	// 用于把「安全授权」「审计」单独委派给别人。
	//
	// Resources 里显式列出 settings：设置族资源必须显式授权，通配 * 不覆盖它
	// （见 rbac.settingsRoleAllows），而最高权限角色要能管理全部章节。
	DefaultAdminRole = Role{
		Name:        "admin",
		Description: "System administrator: unrestricted console and cluster administration",
		IsSystem:    true,
		Clusters:    []string{"*"},
		Namespaces:  []string{"*"},
		Resources:   []string{"*", common.SystemSettingsResource},
		Verbs:       []string{"*"},
	}
	// DefaultAuditorRole 审计管理员：只能读审计日志，不能改任何配置。
	//
	// 它只持有 settings.audit：不再像旧定义那样是「全资源只读 + 日志」，
	// 因为那会同时拿到 secrets 与全部业务资源，与三权分立相悖。
	//
	// 代次 2 起多给了 `update`：它仅用于配置审计记录的**存储策略**（保留天数与
	// syslog 外发），对应 /api/v1/admin/audit-setting。审计记录本身仍然只能读，
	// 没有任何手工删除接口（删除只可能由保留策略按时间自动滚动发生，且每次都留痕）。
	DefaultAuditorRole = Role{
		Name:        "auditor",
		Description: "Audit administrator: read-only access to audit logs, plus the audit retention policy",
		IsSystem:    true,
		Clusters:    []string{"*"},
		Namespaces:  []string{"*"},
		Verbs:       []string{string(common.VerbGet), string(common.VerbUpdate)},
		Grants: ResourceGrants{
			{
				Resource: common.SettingsSectionResource(common.SettingsSectionAudit),
				Verbs:    []string{string(common.VerbGet), string(common.VerbUpdate)},
			},
		},
	}
	// DefaultSecurityAdminRole 安全管理员：安全策略、身份与授权。
	//
	// 覆盖「用户与用户组」「角色与权限绑定」「安全策略」「认证源」四个章节，
	// 以及 Kubernetes 里的主体 / 授权对象；不碰业务资源与审计日志。
	DefaultSecurityAdminRole = Role{
		Name:        "security-admin",
		Description: "Security administrator: identity, authorization and security policy",
		IsSystem:    true,
		Clusters:    []string{"*"},
		Namespaces:  []string{"*"},
		Verbs:       []string{"*"},
		Grants: ResourceGrants{
			{Resource: "serviceaccounts", Verbs: []string{"*"}},
			{Resource: "roles", Verbs: []string{"*"}},
			{Resource: "rolebindings", Verbs: []string{"*"}},
			{Resource: "clusterroles", Verbs: []string{"*"}},
			{Resource: "clusterrolebindings", Verbs: []string{"*"}},
			{Resource: common.SettingsSectionResource(common.SettingsSectionUsers), Verbs: []string{"*"}},
			{Resource: common.SettingsSectionResource(common.SettingsSectionRBAC), Verbs: []string{"*"}},
			{Resource: common.SettingsSectionResource(common.SettingsSectionSecurity), Verbs: []string{"*"}},
			{Resource: common.SettingsSectionResource(common.SettingsSectionAuthentication), Verbs: []string{"*"}},
		},
	}
	// DefaultViewerRole 只读管理员：全部 Kubernetes 资源（不含 secrets）、容器日志与
	// 控制台设置的只读查看。
	//
	// Resources 里显式列出 settings：设置族资源必须显式授权，通配 * 不覆盖它
	// （见 rbac.settingsRoleAllows），而父级 settings 的语义是「全部章节」——因此只读
	// 管理员能打开每个设置页面，但只拿到 get，任何章节都改不了。
	//
	// 代次 5 起在 get 之外多给了 `log`：容器日志是只读观测数据，只读管理员按定义就该
	// 看得到（docs/config/rbac-config.md 的样例角色也是 get + log）；此前只给 get，只读
	// 账号打开日志页签必然拿到 403。
	DefaultViewerRole = Role{
		Name:        "viewer",
		Description: "Read-only administrator: read access to Kubernetes resources, pod logs and console settings",
		IsSystem:    true,
		Clusters:    []string{"*"},
		Namespaces:  []string{"*"},
		Resources:   append([]string{"*", common.SystemSettingsResource}, denyPatterns("secrets")...),
		Verbs:       []string{string(common.VerbGet), string(common.VerbLog)},
	}
	// DefaultClusterAdminRole 集群管理员：被授权的 K8s 集群内全部资源（含 secrets）
	// 的全权操作，不持有任何控制台设置章节。
	//
	// 角色只定义「资源 × 操作」；生效范围是权限绑定组把它授出的那个集群，不是
	// 所有集群。与 admin 的差别是它没有 settings：集群管理员只管集群，管不了用户、
	// RBAC 与安全策略（settings 族资源必须显式授权，通配 * 不覆盖它，
	// 见 rbac.settingsRoleAllows），因此它进不了管理 API，也不参与三权分立。
	DefaultClusterAdminRole = Role{
		Name:        "cluster-admin",
		Description: "Cluster administrator: full access to all resources within the granted cluster, no console settings",
		IsSystem:    true,
		Clusters:    []string{"*"},
		Namespaces:  []string{"*"},
		Resources:   []string{"*"},
		Verbs:       []string{"*"},
	}
	// DefaultClusterViewerRole 集群只读管理员：被授权的 K8s 集群内全部资源（排除
	// secrets）的只读查看与容器日志，不持有任何控制台设置章节。
	//
	// 生效范围同样是权限绑定组授出的那个集群。与 viewer 的差别是 settings：它只
	// 观测集群，看不到控制台设置页面。secrets 的排除口径与 viewer 一致。
	DefaultClusterViewerRole = Role{
		Name:        "cluster-viewer",
		Description: "Cluster read-only administrator: read access to all resources within the granted cluster plus pod logs, no console settings",
		IsSystem:    true,
		Clusters:    []string{"*"},
		Namespaces:  []string{"*"},
		// 注意必须带裸 "*"：match() 的否定项（"!secrets"）只在命中时拒绝，
		// 列表里没有肯定项时永远匹配失败——只写 "!secrets" 的角色什么也放不了。
		Resources: append([]string{"*"}, denyPatterns("secrets")...),
		Verbs:     []string{string(common.VerbGet), string(common.VerbLog)},
	}
)

// denyPatterns 把资源名转成 match() 的否定模式（"!" 前缀）。
func denyPatterns(resources ...string) []string {
	patterns := make([]string, 0, len(resources))
	for _, resource := range resources {
		patterns = append(patterns, "!"+resource)
	}
	return patterns
}

// SuperRoleName 是已退休的内置超级角色名称（代次 3 起并入 DefaultAdminRole）。
//
// 它不再是系统角色，也不再参与权限判定；保留这个名称只为两件事：
//   - RetireSuperRole 在存量库里找到并删掉这个遗留角色行；
//   - 拒绝再次把角色命名为它（避免一个同名的自定义角色被误认为最高权限入口）。
const SuperRoleName = "super-admin"

// ProtectedRoleNames 是所有受保护的内置角色：系统管理员、安全管理员（授权）、
// 审计管理员（审计）、只读管理员、集群管理员与集群只读管理员。
//
// 前三个角色的权限集就是三权分立的支点（尤其 security-admin / auditor 把「安全授权」
// 与「审计」单独委派出去）；只读管理员、集群管理员与集群只读管理员虽不参与职责分离
// （后两者进不了任何设置章节），但其规则由代码维护、不应被误删或误改。因此控制台
// 只允许查看它们，不提供修改或删除入口；要修回正确定义只能靠 MigrateSystemRoleRules
// 或 RestoreSystemRoleDefaults。
var ProtectedRoleNames = []string{
	DefaultAdminRole.Name,
	DefaultSecurityAdminRole.Name,
	DefaultAuditorRole.Name,
	DefaultViewerRole.Name,
	DefaultClusterAdminRole.Name,
	DefaultClusterViewerRole.Name,
}

// IsProtectedRoleName 判断是否为受保护的内置角色（三员与只读管理员）。
func IsProtectedRoleName(name string) bool {
	for _, protected := range ProtectedRoleNames {
		if protected == name {
			return true
		}
	}
	return false
}

// MutuallyExclusiveRoleGroups 是职责分离（SoD）约束：同一组内的角色两两互斥，
// 不得由同一账号同时持有。
//
// 等保三级要求管理用户的权限分离：系统管理员、安全管理员（授权）、审计管理员（审计）
// 必须由不同人员担任，否则「审计管理员监督前两者」无从谈起。代价是：合并后的
// DefaultAdminRole 已经包含安全与审计章节，一旦某账号同时拿到 admin 与
// security-admin / auditor，管理面会整体拒绝（见 rbac.CanAccessAdminAPI）——这是有意
// 的硬约束，避免“既管授权又管审计”的账号存在。
var MutuallyExclusiveRoleGroups = [][]string{
	{
		DefaultAdminRole.Name,
		DefaultSecurityAdminRole.Name,
		DefaultAuditorRole.Name,
	},
}

// CurrentRoleRulesVersion 是内置角色规则定义的代次。
//
// 调整 SystemRoles() 里的规则时必须递增：启动时会把这些角色重写为代码里的定义
// （每代只做一次，见 MigrateSystemRoleRules）。
//
// 代次 1：等保三级三权分立——设置资源拆成章节（settings.<章节>），
// 系统管理员 / 安全管理员 / 审计管理员 的权限集互不相交。
// 代次 2：审计管理员获得 settings.audit 的 update，仅用于配置审计记录的存储策略
// （保留天数下限 30 天 + syslog 外发），审计日志本身仍然只读。
// 代次 3：内置超级角色（super-admin）并入系统管理员（admin）——admin 成为唯一的最高
// 权限角色（全部资源 + 全部设置章节），super-admin 角色被退休（见 RetireSuperRole）。
// 系统管理员因此重新掌握安全与审计章节，三权分立中的「系统管理员」定位发生变化，
// 需按新版等保方案重新评估；security-admin / auditor 仍然存在，用于把安全授权与
// 审计职责单独委派。
// 代次 4：只读管理员获得 settings 的 get（即全部设置章节的只读查看，没有 update）；
// 它不属于三员，职责分离不受影响。
// 代次 5：只读管理员获得 `log`（查看容器日志）——日志是只读观测数据，只读账号本该能看；
// 此前只给 get，导致只读账号打开日志页签必然 403。
// 代次 6：新增内置「集群管理员」（cluster-admin）与「集群只读管理员」（cluster-viewer）：
// 前者是所授权集群内全部资源（含 secrets）的全权操作，后者是所授权集群内全部资源
// （排除 secrets）的只读查看 + 容器日志；两者都不持有控制台设置章节，不参与职责分离。
// 代次 7：修正集群角色的描述与 cluster-viewer 的资源列表——生效范围是「被授权的那个
// 集群」（由权限绑定组决定），不是所有 K8s 集群；cluster-viewer 的资源列表必须带裸
// "*"（match() 只认肯定项），排除 secrets 用否定项收窄。
const CurrentRoleRulesVersion = 7

// SystemRoles 返回内置系统角色，顺序即界面展示顺序：
// 系统管理员 → 审计管理员 → 安全管理员 → 只读管理员 → 集群管理员 → 集群只读管理员。
// 系统角色的名称是权限判定的依据（例如 admin 用于放行管理接口），因此名称固定；
// 但角色内的规则（集群/命名空间/资源/动作）与描述允许在控制台调整。
func SystemRoles() []Role {
	return []Role{
		DefaultAdminRole,
		DefaultAuditorRole,
		DefaultSecurityAdminRole,
		DefaultViewerRole,
		DefaultClusterAdminRole,
		DefaultClusterViewerRole,
	}
}

// MigrateSystemRoleRules 把内置系统角色重写为当前代码里的定义。
//
// InitDefaultRole 只补齐缺失的角色、不碰已有配置（管理员在控制台调过的规则要保留），
// 所以内置角色的定义变更不会自动生效。这里用 GeneralSetting 里的代次标记做一次性
// 升级：只在代次提升时执行，之后再手工调整内置角色就不会被启动覆盖。
func MigrateSystemRoleRules() error {
	setting, err := GetGeneralSetting()
	if err != nil {
		return err
	}
	if setting.RoleRulesVersion >= CurrentRoleRulesVersion {
		return nil
	}
	if err := RestoreSystemRoleDefaults(); err != nil {
		return err
	}
	return DB.Model(&GeneralSetting{}).
		Where("id = ?", setting.ID).
		Update("role_rules_version", CurrentRoleRulesVersion).Error
}

// NormalizeRoleClusters 把存量角色统一成“全局”（clusters = "*"）。
//
// 角色不再带集群属性：它只定义资源与操作，生效范围（集群 + 命名空间）由权限绑定表达。
// 早期版本会把创建时所在集群写进 roles.clusters，升级时做一次归一化，否则这些角色
// 在数据层仍带着看不见的集群限制（界面已不再展示该字段）。
//
// 只做一次（GeneralSetting.RoleClustersNormalized 打标）且幂等；配置文件托管的
// RBAC（managedSections 含 rbac）由配置文件说了算，不动它，避免与每次启动的
// 配置回写互相覆盖。
func NormalizeRoleClusters() error {
	setting, err := GetGeneralSetting()
	if err != nil {
		return err
	}
	if setting.RoleClustersNormalized {
		return nil
	}
	if common.IsSectionManaged("rbac") {
		return nil
	}

	return DB.Transaction(func(tx *gorm.DB) error {
		// clusters 列存的是逗号分隔的纯文本（SliceString），"*" 即全局。
		if err := tx.Model(&Role{}).
			Where("clusters IS NULL OR clusters <> ?", "*").
			Update("clusters", "*").Error; err != nil {
			return err
		}
		return tx.Model(&GeneralSetting{}).Where("id = ?", setting.ID).
			Update("role_clusters_normalized", true).Error
	})
}

// RestoreSystemRoleDefaults 把一个（或全部，name 为空时）内置系统角色恢复成代码里的
// 默认定义。只影响 isSystem 角色，不碰自定义角色。
func RestoreSystemRoleDefaults(name ...string) error {
	wanted := make(map[string]struct{}, len(name))
	for _, n := range name {
		wanted[n] = struct{}{}
	}
	for _, role := range SystemRoles() {
		if len(wanted) > 0 {
			if _, ok := wanted[role.Name]; !ok {
				continue
			}
		}
		var existing Role
		err := DB.Where("name = ?", role.Name).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if err := DB.Create(&role).Error; err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		// 只改写规则与描述：ID 与分配关系保持不变。
		if err := DB.Model(&existing).Updates(map[string]interface{}{
			"description": role.Description,
			"clusters":    role.Clusters,
			"resources":   role.Resources,
			"namespaces":  role.Namespaces,
			"verbs":       role.Verbs,
			"grants":      role.Grants,
		}).Error; err != nil {
			return err
		}
	}
	return nil
}

// RetireSuperRole 把遗留在存量库里的内置超级角色并入系统管理员（代次 3）。
//
// 代次 3 起 super-admin 不再是系统角色，但老库里还留有这个角色行与它的分配关系；
// 它们的权限已经完全被 DefaultAdminRole 覆盖，所以直接删除角色行与引用。
//
// 只做一次（用 GeneralSetting.SuperRoleRemoved 做标记，与角色删除同一个事务），
// 而且不是“重建角色”而是一个**单向**迁移：系统里只会有一个最高权限角色。
func RetireSuperRole() error {
	if SuperRoleRemoved() {
		return nil
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var role Role
		err := tx.Where("name = ?", SuperRoleName).First(&role).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return SetSuperRoleRemovedTx(tx, true)
		}
		if err != nil {
			return err
		}
		if err := DeleteRoleReferences(tx, role.ID); err != nil {
			return err
		}
		if err := tx.Where("id = ?", role.ID).Delete(&Role{}).Error; err != nil {
			return err
		}
		return SetSuperRoleRemovedTx(tx, true)
	})
}

// IsSystemRoleName 判断名称是否为内置系统角色。
func IsSystemRoleName(name string) bool {
	for _, role := range SystemRoles() {
		if role.Name == name {
			return true
		}
	}
	return false
}

func GetRoleByName(name string) (*Role, error) {
	var role Role
	if err := DB.Where("name = ?", name).First(&role).Error; err != nil {
		return nil, err
	}
	return &role, nil
}

func AddRoleAssignment(roleName string, subjectType, subject string) error {
	role, err := GetRoleByName(roleName)
	if err != nil {
		return err
	}
	assignment := RoleAssignment{
		RoleID:      role.ID,
		SubjectType: subjectType,
		Subject:     subject,
	}
	return DB.Create(&assignment).Error
}

// EnsureRoleAssignment 幂等地创建角色分配：已存在时不重复插入。
func EnsureRoleAssignment(roleName string, subjectType, subject string) error {
	role, err := GetRoleByName(roleName)
	if err != nil {
		return err
	}
	var existing int64
	if err := DB.Model(&RoleAssignment{}).
		Where("role_id = ? AND subject_type = ? AND subject = ?", role.ID, subjectType, subject).
		Count(&existing).Error; err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	return DB.Create(&RoleAssignment{
		RoleID:      role.ID,
		SubjectType: subjectType,
		Subject:     subject,
	}).Error
}

func InitDefaultRole() error {
	// 只补齐缺失的系统角色，不覆盖已有配置：管理员调整过的系统角色规则必须保留。
	for _, role := range SystemRoles() {
		var existing Role
		err := DB.Where("name = ?", role.Name).First(&existing).Error
		if err == nil {
			continue
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err := DB.Create(&role).Error; err != nil {
			return err
		}
	}
	return nil
}

// DeleteRoleReferences 删除某个角色上的全部引用：直接分配的角色、以及权限绑定组里
// 以该角色授权的成员行。删除必须与“删角色”在同一个事务里发生：不做的话引用会指向
// 不存在的 role_id，重建后的新角色 ID 会让它们永久悬空。
func DeleteRoleReferences(tx *gorm.DB, roleID uint) error {
	if err := tx.Where("role_id = ?", roleID).Delete(&RoleAssignment{}).Error; err != nil {
		return err
	}
	return tx.Where("role_id = ?", roleID).Delete(&BindingGroupMember{}).Error
}

// SuperRoleRemoved 报告「内置超级角色退休迁移」是否已经执行过。
func SuperRoleRemoved() bool {
	setting, err := GetGeneralSetting()
	if err != nil {
		// 读不到设置时按「已执行」处理会引起补偿差异，所以保守地当作未执行：
		// 退休迁移是幂等的（角色不在则只写标记），多跑一次不会有害。
		klog.Warningf("failed to read super role retirement marker: %v", err)
		return false
	}
	return setting.SuperRoleRemoved
}

// SetSuperRoleRemovedTx 在给定事务里写退休迁移标记：它必须与删除角色同生共死。
//
// 这里只用事务自己的连接（不调 GetGeneralSetting）：设置行在启动时
// （MigrateSystemRoleRules）已经建好，而事务里再去用全局连接读写会与 SQLite 的写锁互等。
func SetSuperRoleRemovedTx(tx *gorm.DB, removed bool) error {
	var setting GeneralSetting
	if err := tx.Select("id").First(&setting, 1).Error; err != nil {
		return err
	}
	return tx.Model(&GeneralSetting{}).Where("id = ?", setting.ID).
		Update("super_role_removed", removed).Error
}
