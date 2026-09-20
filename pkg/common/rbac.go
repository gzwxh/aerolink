package common

import "strings"

type Verb string

const (
	VerbGet    Verb = "get"
	VerbCreate Verb = "create"
	VerbUpdate Verb = "update"
	VerbDelete Verb = "delete"
	VerbLog    Verb = "log"
	VerbExec   Verb = "exec"
	// 容器文件权限：与 exec 分离，可在角色中单独勾选。
	VerbViewFile     Verb = "view-file"
	VerbDownloadFile Verb = "download-file"
	VerbUploadFile   Verb = "upload-file"
)

// SystemSettingsResource 是一个合成的 RBAC 资源，背后没有对应的
// Kubernetes API：它用于保护控制台的系统设置与权限管理
// 页面。系统设置是全局的，因此角色的集群与命名空间范围
// 对它不适用（见 rbac.CanManageSystemSettings）。
const SystemSettingsResource = "settings"

// SystemSettingsVerb 是角色为修改控制台系统设置与权限而必须在
// SystemSettingsResource 上授予的 verb（读权限还额外
// 接受 VerbGet，见 rbac.CanViewSystemSettings）。
const SystemSettingsVerb Verb = VerbUpdate

// SettingsSectionResourcePrefix 构成章节级资源名：settings.<章节>。
//
// 把控制台设置按页面拆成独立资源，是为了满足等保三级的三权分立要求：
// 「系统配置」（系统管理员）、「安全策略与授权」（安全管理员）、「审计日志」
// （审计管理员）必须能各自授予，而不能挤在同一个 settings 开关里。
const SettingsSectionResourcePrefix = SystemSettingsResource + "."

// 控制台设置章节。取值必须与前端 settings-sections.tsx 的 section value 一致。
const (
	SettingsSectionGeneral        = "general"
	SettingsSectionClusters       = "clusters"
	SettingsSectionNotification   = "notification"
	SettingsSectionTemplates      = "templates"
	SettingsSectionAPIKeys        = "apikeys"
	SettingsSectionAuthentication = "authentication"
	SettingsSectionUsers          = "users"
	SettingsSectionRBAC           = "rbac"
	SettingsSectionSecurity       = "security"
	SettingsSectionAudit          = "audit"
)

// SettingsSections 是全部设置章节（顺序与界面一致）。
var SettingsSections = []string{
	SettingsSectionGeneral,
	SettingsSectionClusters,
	SettingsSectionNotification,
	SettingsSectionTemplates,
	SettingsSectionAPIKeys,
	SettingsSectionAuthentication,
	SettingsSectionUsers,
	SettingsSectionRBAC,
	SettingsSectionSecurity,
	SettingsSectionAudit,
}

// SettingsSectionResource 返回章节对应的资源名；空章节返回父级 settings，
// 语义为「全部章节」。
func SettingsSectionResource(section string) string {
	if section == "" {
		return SystemSettingsResource
	}
	return SettingsSectionResourcePrefix + section
}

// IsSettingsResource 判断资源是否属于设置族（settings 或 settings.<章节>）。
// 判定时这类资源必须显式授权：通配 * 不覆盖它们，否则一个 * 角色就把
// 「系统配置 / 安全授权 / 审计」三员的权限并回一人。
func IsSettingsResource(resource string) bool {
	return resource == SystemSettingsResource || strings.HasPrefix(resource, SettingsSectionResourcePrefix)
}

// ResourceGrant 是角色里「资源 → 该资源上允许的操作」的一条授权。
type ResourceGrant struct {
	Resource string   `yaml:"resource" json:"resource"`
	Verbs    []string `yaml:"verbs" json:"verbs"`
}

type Role struct {
	Name        string   `yaml:"name" json:"name"`
	Description string   `yaml:"description" json:"-"`
	Clusters    []string `yaml:"clusters" json:"clusters"`
	Resources   []string `yaml:"resources" json:"resources"`
	Namespaces  []string `yaml:"namespaces" json:"namespaces"`
	Verbs       []string `yaml:"verbs" json:"verbs"`
	// Grants 按资源保存操作集合；为空时退回 Resources × Verbs 的笛卡尔积。
	Grants []ResourceGrant `yaml:"grants,omitempty" json:"grants,omitempty"`
}

type RoleMapping struct {
	Name       string   `yaml:"name" json:"name"`
	Users      []string `yaml:"users,omitempty" json:"users,omitempty"`
	OIDCGroups []string `yaml:"oidcGroups,omitempty" json:"oidcGroups,omitempty"`
}

type RolesConfig struct {
	Roles       []Role        `yaml:"roles"`
	RoleMapping []RoleMapping `yaml:"roleMapping"`
}
