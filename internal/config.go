package internal

import (
	"crypto/sha256"
	"fmt"
	"os"
	"reflect"
	"strings"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/utils"
	"gopkg.in/yaml.v3"
	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

// KiteConfig 表示外部配置文件的结构。
type KiteConfig struct {
	SuperUser *SuperUserConfig `yaml:"superUser"`
	Clusters  []ClusterConfig  `yaml:"clusters"`
	OAuth     []OAuthConfig    `yaml:"oauth"`
	LDAP      *LDAPConfig      `yaml:"ldap"`
	RBAC      *RBACConfig      `yaml:"rbac"`
	// AuditSink 决定审计记录落到哪里（**五选一互斥**）：
	//
	//	database（默认）| parquet | elasticsearch | victorialogs | openobserve
	//
	// 它是**启动期决定**的（审计写入路径按它选择、运行期不变），所以界面只读；这与下面的
	// auditArchive 不同——那种是"播种值"，界面始终可改。多副本部署必须在每一份配置里写
	// 同一个值（否则不同副本把记录写到不同地方，任何一处都查不全）。
	AuditSink string `yaml:"auditSink"`
	// AuditArchive 是审计/访问日志归档的**播种值**：仅当数据库里还是默认归档配置时
	// 才写入，之后由管理员在「日志审计 → 审计设置 → 归档」里维护（区别于其它
	// section 的「配置文件接管、界面只读」语义）。
	AuditArchive *model.ArchiveSetting `yaml:"auditArchive"`
}

type AppliedSections map[string]bool

type SuperUserConfig struct {
	Username string `yaml:"username"`
	Password string `yaml:"password"`
}

type ClusterConfig struct {
	Name          string `yaml:"name"`
	Description   string `yaml:"description"`
	Config        string `yaml:"config"`
	PrometheusURL string `yaml:"prometheusURL"`
	InCluster     bool   `yaml:"inCluster"`
	Default       bool   `yaml:"default"`
}

type OAuthConfig struct {
	Name          string `yaml:"name"`
	ClientID      string `yaml:"clientId"`
	ClientSecret  string `yaml:"clientSecret"`
	AuthURL       string `yaml:"authUrl"`
	TokenURL      string `yaml:"tokenUrl"`
	UserInfoURL   string `yaml:"userInfoUrl"`
	Scopes        string `yaml:"scopes"`
	Issuer        string `yaml:"issuer"`
	Enabled       *bool  `yaml:"enabled"`
	UsernameClaim string `yaml:"usernameClaim"`
	GroupsClaim   string `yaml:"groupsClaim"`
	AllowedGroups string `yaml:"allowedGroups"`
}

type LDAPConfig struct {
	Enabled              bool   `yaml:"enabled"`
	ServerURL            string `yaml:"serverUrl"`
	UseStartTLS          bool   `yaml:"useStartTLS"`
	BindDN               string `yaml:"bindDn"`
	BindPassword         string `yaml:"bindPassword"`
	UserBaseDN           string `yaml:"userBaseDn"`
	UserFilter           string `yaml:"userFilter"`
	UsernameAttribute    string `yaml:"usernameAttribute"`
	DisplayNameAttribute string `yaml:"displayNameAttribute"`
	GroupBaseDN          string `yaml:"groupBaseDn"`
	GroupFilter          string `yaml:"groupFilter"`
	GroupNameAttribute   string `yaml:"groupNameAttribute"`
	AutoSync             *bool  `yaml:"autoSync"`
	SyncIntervalMinutes  int    `yaml:"syncIntervalMinutes"`
}

type RBACConfig struct {
	Roles       []RoleConfig        `yaml:"roles"`
	RoleMapping []RoleMappingConfig `yaml:"roleMapping"`
}

type RoleConfig struct {
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Clusters    []string `yaml:"clusters"`
	Namespaces  []string `yaml:"namespaces"`
	Resources   []string `yaml:"resources"`
	Verbs       []string `yaml:"verbs"`
}

type RoleMappingConfig struct {
	Name       string   `yaml:"name"`
	Users      []string `yaml:"users"`
	OIDCGroups []string `yaml:"oidcGroups"`
}

// LoadConfigFromFile 加载并应用给定文件路径的配置。
// 敏感值可以使用 ${ENV_VAR} 占位符，它们会从环境变量展开。
func LoadConfigFromFile(path string) {
	if path == "" {
		return
	}

	cfg, _, err := readConfigFile(path)
	if err != nil {
		klog.Fatalf("%v", err)
		return
	}

	sections := applyConfig(path, cfg)
	common.SetManagedSections(sections)
}

func readConfigFile(path string) (*KiteConfig, [sha256.Size]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, [sha256.Size]byte{}, fmt.Errorf("failed to read config file %s: %w", path, err)
	}
	hash := sha256.Sum256(data)

	// 从环境变量展开 ${ENV_VAR} 占位符
	expanded := os.ExpandEnv(string(data))

	var cfg KiteConfig
	if err := yaml.Unmarshal([]byte(expanded), &cfg); err != nil {
		return nil, hash, fmt.Errorf("failed to parse config file %s: %w", path, err)
	}

	return &cfg, hash, nil
}

func applyConfig(path string, cfg *KiteConfig) AppliedSections {
	sections := AppliedSections{}
	klog.Infof("Loading configuration from file: %s", path)

	if cfg.Clusters != nil {
		if err := applyClusters(cfg.Clusters); err != nil {
			klog.Errorf("Failed to apply cluster config: %v", err)
		} else {
			sections["clusters"] = true
			klog.Infof("Applied %d cluster(s) from config file", len(cfg.Clusters))
		}
	}

	if cfg.OAuth != nil {
		if err := applyOAuth(cfg.OAuth); err != nil {
			klog.Errorf("Failed to apply OAuth config: %v", err)
		} else {
			sections["oauth"] = true
			klog.Infof("Applied %d OAuth provider(s) from config file", len(cfg.OAuth))
		}
	}

	if cfg.LDAP != nil {
		if err := applyLDAP(cfg.LDAP); err != nil {
			klog.Errorf("Failed to apply LDAP config: %v", err)
		} else {
			sections["ldap"] = true
			klog.Info("Applied LDAP settings from config file")
		}
	}

	if cfg.RBAC != nil {
		if err := applyRBAC(cfg.RBAC); err != nil {
			klog.Errorf("Failed to apply RBAC config: %v", err)
		} else {
			sections["rbac"] = true
			klog.Infof("Applied RBAC config from config file (%d roles, %d mappings)",
				len(cfg.RBAC.Roles), len(cfg.RBAC.RoleMapping))
		}
	}

	// sink 必须在归档播种**之前**落定：播种会触发配置校验，而其中一条（parquet 作为唯一
	// 存储时 flush 间隔不得超过 5 分钟）依赖它。
	applyAuditSink(cfg.AuditSink)

	// 归档配置是「播种」而不是「接管」：只在数据库仍是默认值时写入。
	// 它不进 ManagedSections，界面始终可改。
	if cfg.AuditArchive != nil {
		if err := applyAuditArchive(cfg.AuditArchive); err != nil {
			klog.Errorf("Failed to seed audit archive config: %v", err)
		} else {
			klog.Info("Seeded audit archive settings from config file")
		}
	}

	// 在 RBAC 之后再应用超级用户，这样管理员角色分配
	// 不会被 applyRBAC 的「删除所有分配」步骤抹掉。
	if cfg.SuperUser != nil && cfg.SuperUser.Username != "" && cfg.SuperUser.Password != "" {
		if err := applySuperUser(cfg.SuperUser); err != nil {
			klog.Errorf("Failed to apply super user config: %v", err)
		} else {
			sections["superUser"] = true
			klog.Infof("Applied super user %q from config file", cfg.SuperUser.Username)
		}
	}

	return sections
}

// applyAuditSink 确定审计记录的落地方式（配置文件优先，其次 KITE_AUDIT_SINK 环境变量）。
//
// 取值非法时**直接启动失败**而不是回落 database：静默回落会让人以为配置生效了，
// 而实际上审计记录去了另一个地方——这种"看起来正常"的错误在审计场景里代价最高。
// 这与 DB_TYPE 的处理方式一致（见 pkg/common）。
// auditSinkResolved 记录 sink 是否已经确定。
//
// sink 是**启动期**决定的（写入与查询都按它选择，归档运行时也只是启动时按它建一次）；配置文件
// 热更新时绝不能改它：只改 `model.AuditSink` 而不重建运行时会得到一个**半生效**状态（写入还在旧
// 通道、查询已切走），例如 database→parquet 的热切换会把之后的审计记录直接丢掉。
// 所以这里只警告并保持原值，切换存储需要重启。
var auditSinkResolved bool

func applyAuditSink(value string) {
	if strings.TrimSpace(value) == "" {
		value = os.Getenv("KITE_AUDIT_SINK")
	}
	if strings.TrimSpace(value) == "" {
		return // 未配置：保持默认 database，行为与改造前一致。
	}

	sink, err := model.NormalizeAuditSink(value)
	if err != nil {
		klog.Fatalf("Invalid audit sink %q (set via auditSink or KITE_AUDIT_SINK): %v", value, err)
	}
	if auditSinkResolved && model.AuditSink != sink {
		klog.Warningf("Ignoring audit sink change %q -> %q from a config reload: "+
			"the sink is decided at startup, restart to switch storage", model.AuditSink, sink)
		return
	}
	model.AuditSink = sink
	auditSinkResolved = true
	klog.Infof("Audit sink: %s", sink)
}

// applyAuditArchive 把 config.yaml 的 auditArchive 播种进审计设置。
//
// 只在数据库里仍是**默认**归档配置时写入：管理员改过（或之前已播过种）就不动，
// 避免每次重启都把界面上的调整覆盖回去。
func applyAuditArchive(cfg *model.ArchiveSetting) error {
	current, err := model.GetAuditSetting()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(current.Archive, model.DefaultArchiveSetting()) {
		klog.Info("Audit archive settings already customized; config file seeding skipped")
		return nil
	}

	data := *current
	data.Archive = *cfg
	if err := data.Normalize(); err != nil {
		return err
	}
	_, err = model.UpdateAuditSetting(data)
	return err
}

func applySuperUser(cfg *SuperUserConfig) error {
	existing, err := model.GetUserByUsername(cfg.Username)
	if err == nil {
		// 用户已存在——更新密码并确保拥有管理员角色
		hash, err := utils.HashPassword(cfg.Password)
		if err != nil {
			return err
		}
		existing.Password = hash
		existing.IsSuperAdmin = true
		if err := model.DB.Save(existing).Error; err != nil {
			return err
		}
		if err := ensureAdminRole(cfg.Username); err != nil {
			return err
		}
		rbac.TriggerSync()
		return nil
	}

	// 用户不存在——创建
	u := &model.User{
		Username: cfg.Username,
		Password: cfg.Password,
	}
	if err := model.AddSuperUser(u); err != nil {
		return err
	}
	rbac.TriggerSync()
	return nil
}

// ensureAdminRole 确保用户拥有管理员角色分配（幂等）。
func ensureAdminRole(username string) error {
	adminRole, err := model.GetRoleByName("admin")
	if err != nil {
		return err
	}
	var count int64
	model.DB.Model(&model.RoleAssignment{}).
		Where("role_id = ? AND subject_type = ? AND subject = ?",
			adminRole.ID, model.SubjectTypeUser, username).
		Count(&count)
	if count > 0 {
		return nil
	}
	return model.DB.Create(&model.RoleAssignment{
		RoleID:      adminRole.ID,
		SubjectType: model.SubjectTypeUser,
		Subject:     username,
	}).Error
}

func applyClusters(clusters []ClusterConfig) error {
	return model.DB.Transaction(func(tx *gorm.DB) error {
		// 删除所有已有集群，然后按配置插入
		if err := tx.Where("1 = 1").Delete(&model.Cluster{}).Error; err != nil {
			return err
		}

		for _, c := range clusters {
			cluster := &model.Cluster{
				Name:          c.Name,
				Description:   c.Description,
				Config:        model.SecretString(c.Config),
				PrometheusURL: c.PrometheusURL,
				InCluster:     c.InCluster,
				IsDefault:     c.Default,
				Enable:        true,
			}
			if err := tx.Create(cluster).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func applyOAuth(providers []OAuthConfig) error {
	return model.DB.Transaction(func(tx *gorm.DB) error {
		// 删除所有已有 OAuth 提供方，然后按配置插入
		if err := tx.Where("1 = 1").Delete(&model.OAuthProvider{}).Error; err != nil {
			return err
		}

		for _, p := range providers {
			enabled := true
			if p.Enabled != nil {
				enabled = *p.Enabled
			}
			scopes := p.Scopes
			provider := &model.OAuthProvider{
				Name:          model.LowerCaseString(strings.TrimSpace(p.Name)),
				ClientID:      p.ClientID,
				ClientSecret:  model.SecretString(p.ClientSecret),
				AuthURL:       p.AuthURL,
				TokenURL:      p.TokenURL,
				UserInfoURL:   p.UserInfoURL,
				Scopes:        scopes,
				Issuer:        p.Issuer,
				Enabled:       enabled,
				UsernameClaim: p.UsernameClaim,
				GroupsClaim:   p.GroupsClaim,
				AllowedGroups: p.AllowedGroups,
			}
			if err := tx.Create(provider).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func applyLDAP(cfg *LDAPConfig) error {
	setting := &model.LDAPSetting{
		Enabled:              cfg.Enabled,
		ServerURL:            cfg.ServerURL,
		UseStartTLS:          cfg.UseStartTLS,
		BindDN:               cfg.BindDN,
		BindPassword:         model.SecretString(cfg.BindPassword),
		UserBaseDN:           cfg.UserBaseDN,
		UserFilter:           cfg.UserFilter,
		UsernameAttribute:    cfg.UsernameAttribute,
		DisplayNameAttribute: cfg.DisplayNameAttribute,
		GroupBaseDN:          cfg.GroupBaseDN,
		GroupFilter:          cfg.GroupFilter,
		GroupNameAttribute:   cfg.GroupNameAttribute,
		SyncIntervalMinutes:  cfg.SyncIntervalMinutes,
	}
	setting.AutoSync = true
	if cfg.AutoSync != nil {
		setting.AutoSync = *cfg.AutoSync
	}

	_, err := model.UpdateLDAPSetting(setting)
	return err
}

func applyRBAC(cfg *RBACConfig) error {
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		// 删除所有非系统角色及其分配
		if err := tx.Where("is_system = ?", false).Delete(&model.Role{}).Error; err != nil {
			return err
		}

		// 删除所有角色分配（包括系统角色分配，它们会按配置重新创建）
		if err := tx.Where("1 = 1").Delete(&model.RoleAssignment{}).Error; err != nil {
			return err
		}

		// 按配置 upsert 角色
		for _, r := range cfg.Roles {
			var existing model.Role
			if err := tx.Where("name = ?", r.Name).First(&existing).Error; err == nil {
				// 更新已有角色（通常是系统角色）
				existing.Description = r.Description
				existing.Clusters = r.Clusters
				existing.Namespaces = r.Namespaces
				existing.Resources = r.Resources
				existing.Verbs = r.Verbs
				if err := tx.Save(&existing).Error; err != nil {
					return err
				}
			} else {
				// 创建新角色
				role := &model.Role{
					Name:        r.Name,
					Description: r.Description,
					Clusters:    r.Clusters,
					Namespaces:  r.Namespaces,
					Resources:   r.Resources,
					Verbs:       r.Verbs,
				}
				if err := tx.Create(role).Error; err != nil {
					return err
				}
			}
		}

		// 应用角色映射
		for _, m := range cfg.RoleMapping {
			var role model.Role
			if err := tx.Where("name = ?", m.Name).First(&role).Error; err != nil {
				klog.Warningf("Role %q not found for mapping, skipping", m.Name)
				continue
			}
			for _, user := range m.Users {
				assignment := &model.RoleAssignment{
					RoleID:      role.ID,
					SubjectType: model.SubjectTypeUser,
					Subject:     user,
				}
				if err := tx.Create(assignment).Error; err != nil {
					return err
				}
			}
			for _, group := range m.OIDCGroups {
				assignment := &model.RoleAssignment{
					RoleID:      role.ID,
					SubjectType: model.SubjectTypeGroup,
					Subject:     group,
				}
				if err := tx.Create(assignment).Error; err != nil {
					return err
				}
			}
		}

		return nil
	})
	if err != nil {
		return err
	}

	// 触发 RBAC 同步以更新内存缓存（在事务之外）
	rbac.TriggerSync()
	return nil
}
