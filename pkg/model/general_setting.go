package model

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/gzwxh/aerolink/pkg/common"
	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

const DefaultGeneralAIModel = "gpt-4o-mini"
const DefaultGeneralAnthropicModel = "claude-sonnet-4-5"

// DefaultGeneralKubectlImage 是默认的 kubectl 镜像。默认镜像都来自公司镜像仓库
// （SWR，命名空间 “gzwxh”）。
const DefaultGeneralKubectlImage = "swr.cn-south-1.myhuaweicloud.com/gzwxh/kubectl:latest"
const DefaultGeneralNodeTerminalImage = "swr.cn-south-1.myhuaweicloud.com/gzwxh/busybox:latest"
const DefaultGeneralClusterAgentImage = "swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:latest"

const GeneralAIProviderOpenAI = "openai"
const GeneralAIProviderAnthropic = "anthropic"
const DefaultGeneralAIProvider = GeneralAIProviderOpenAI

func DefaultGeneralNodeTerminalImageValue() string {
	image := strings.TrimSpace(common.NodeTerminalImage)
	if image == "" {
		return DefaultGeneralNodeTerminalImage
	}
	return image
}

func DefaultGeneralKubectlImageValue() string {
	image := strings.TrimSpace(common.KubectlTerminalImage)
	if image == "" {
		return DefaultGeneralKubectlImage
	}
	return image
}

func DefaultGeneralClusterAgentImageValue() string {
	image := strings.TrimSpace(common.ClusterAgentImage)
	if image == "" {
		return DefaultGeneralClusterAgentImage
	}
	return image
}

type GeneralSetting struct {
	Model
	AIAgentEnabled        bool         `json:"aiAgentEnabled" gorm:"column:ai_agent_enabled;type:boolean;not null;default:false"`
	AIProvider            string       `json:"aiProvider" gorm:"column:ai_provider;type:varchar(50);not null;default:'openai'"`
	AIModel               string       `json:"aiModel" gorm:"column:ai_model;type:varchar(255);not null;default:'gpt-4o-mini'"`
	AIAPIKey              SecretString `json:"aiApiKey" gorm:"column:ai_api_key;type:text"`
	AIBaseURL             string       `json:"aiBaseUrl" gorm:"column:ai_base_url;type:varchar(500)"`
	AIMaxTokens           int          `json:"aiMaxTokens" gorm:"column:ai_max_tokens;type:integer;default:16384"`
	KubectlEnabled        bool         `json:"kubectlEnabled" gorm:"column:kubectl_enabled;type:boolean;not null;default:true"`
	KubectlImage          string       `json:"kubectlImage" gorm:"column:kubectl_image;type:varchar(255);not null;default:'swr.cn-south-1.myhuaweicloud.com/gzwxh/kubectl:latest'"`
	NodeTerminalImage     string       `json:"nodeTerminalImage" gorm:"column:node_terminal_image;type:varchar(255);not null;default:'swr.cn-south-1.myhuaweicloud.com/gzwxh/busybox:latest'"`
	ClusterAgentImage     string       `json:"clusterAgentImage" gorm:"column:cluster_agent_image;type:varchar(255);not null;default:'swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:latest'"`
	PasswordLoginDisabled bool         `json:"passwordLoginDisabled" gorm:"column:password_login_disabled;type:boolean;not null;default:false"`
	EnableMFA             bool         `json:"enableMFA" gorm:"column:enable_mfa;type:boolean;not null;default:true"`
	LoginPrompt           string       `json:"loginPrompt" gorm:"column:login_prompt;type:text"`
	// LogoURL 是控制台的自定义 logo（http(s) 或 data: 地址）。为空时前端用内置图标。
	// 它通过公开的 bootstrap 接口下发，以便登录页也能显示同一个 logo。
	LogoURL string `json:"logoUrl" gorm:"column:logo_url;type:text"`
	// SiteName 是控制台在侧边栏、登录页与浏览器标签上展示的名称。为空时前端用默认名
	// “鸢联 AeroLink”（与 logoUrl 一样由公开的 bootstrap 接口下发）。
	SiteName string `json:"siteName" gorm:"column:site_name;type:varchar(100)"`
	// HelpURL 是帮助文档站的地址（通常是自建/内网的文档站，例如
	// https://aerolink-docs.gcongo.cn/）。与 logoUrl、siteName 一样由公开的 bootstrap
	// 接口下发，因此未登录的登录页也能打开它。空串表示未配置，界面不显示入口。
	HelpURL   string       `json:"helpUrl" gorm:"column:help_url;type:varchar(500)"`
	JWTSecret SecretString `json:"-" gorm:"column:jwt_secret;type:text"`
	// EncryptKeyFingerprint 记录数据库中已有行是用哪个 AEROLINK_ENCRYPT_KEY 加密的，
	// 这样从内置默认密钥切换出去时可以走迁移，
	// 而不是把所有已存密钥悄悄弄坏。
	EncryptKeyFingerprint   string `json:"-" gorm:"column:encrypt_key_fingerprint;type:varchar(64)"`
	GlobalSidebarPreference string `json:"-" gorm:"column:global_sidebar_preference;type:text"`
	// RoleRulesVersion 记录已应用到数据库的内置角色规则代次（等保三权分立升级用），
	// 避免每次启动都覆盖管理员在内置角色上做的手工调整。
	RoleRulesVersion int `json:"-" gorm:"column:role_rules_version;type:integer;not null;default:0"`
	// SuperRoleRemoved 记录「内置超级角色退休迁移是否已执行」（代次 3：超级角色并入
	// 系统管理员，见 RetireSuperRole）。
	//
	// 这是一个**单向**迁移标记：老库里的 super-admin 角色行只会被删除，不会被重建。
	// 系统里因此永远只有一个最高权限角色（admin）；「超级管理员」退化为账号级概念，
	// 由 users.is_super_admin 与受保护的「超级权限绑定」组表达。
	SuperRoleRemoved bool `json:"-" gorm:"column:super_role_removed;type:boolean;not null;default:false"`
	// SuperAdminFlagged 记录存量库的「超级管理员补标」判别是否已经执行过。
	//
	// 只做一次：管理员删掉超级管理员账号之后，如果每次启动都重新判别，标记会落到
	// 「第一个仍直接持有 admin 角色的账号」身上——等于凭空长出一个删不掉的影子
	// 超级管理员，并把超级角色灌回给它（见 flagExistingSuperAdmin）。
	SuperAdminFlagged bool `json:"-" gorm:"column:super_admin_flagged;type:boolean;not null;default:false"`
	// RoleClustersNormalized 记录「角色集群属性归一化」是否已经执行过。
	//
	// 角色是全局的：只定义资源与操作，生效范围（集群 + 命名空间）由权限绑定表达。
	// 早期版本会把创建时的集群写进 roles.clusters，升级时统一归一化成 ["*"]，
	// 见 NormalizeRoleClusters。
	RoleClustersNormalized bool `json:"-" gorm:"column:role_clusters_normalized;type:boolean;not null;default:false"`
}

func NormalizeGeneralAIProvider(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case GeneralAIProviderAnthropic:
		return GeneralAIProviderAnthropic
	default:
		return GeneralAIProviderOpenAI
	}
}

func IsGeneralAIProviderSupported(provider string) bool {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	return normalized == GeneralAIProviderOpenAI || normalized == GeneralAIProviderAnthropic
}

func DefaultGeneralAIModelByProvider(provider string) string {
	switch NormalizeGeneralAIProvider(provider) {
	case GeneralAIProviderAnthropic:
		return DefaultGeneralAnthropicModel
	default:
		return DefaultGeneralAIModel
	}
}

// GetGeneralSetting 返回通用设置（读路径，带 10 秒缓存）。
//
// 它出现在鉴权、权限判定、AI、终端等不少热路径上，没有缓存就是「每个请求查一次库」。
// 设置为「读出来→改几个键→按请求体写回」的流程设计，那种流程请用 LoadGeneralSetting。
func GetGeneralSetting() (*GeneralSetting, error) {
	generalSettingMu.RLock()
	cached, cachedAt, cachedDB := generalSettingEntry, generalSettingAt, generalSettingDB
	generalSettingMu.RUnlock()
	// cachedDB != DB 只会在测试替换内存库时出现（生产里 DB 不会换）。
	if cached != nil && cachedDB == DB && time.Since(cachedAt) < securitySettingCacheTTL {
		copied := *cached
		return &copied, nil
	}

	setting, err := LoadGeneralSetting()
	if err != nil {
		return nil, err
	}
	generalSettingMu.Lock()
	generalSettingEntry, generalSettingAt, generalSettingDB = setting, time.Now(), DB
	generalSettingMu.Unlock()

	copied := *setting
	return &copied, nil
}

// LoadGeneralSetting 直接读库，不走缓存（写路径与需要确定性的场景用它）。
func LoadGeneralSetting() (*GeneralSetting, error) {
	var setting GeneralSetting
	err := DB.First(&setting, 1).Error
	if err == nil {
		updates := map[string]interface{}{}
		if setting.AIProvider == "" {
			setting.AIProvider = DefaultGeneralAIProvider
			updates["ai_provider"] = DefaultGeneralAIProvider
		} else {
			normalizedProvider := NormalizeGeneralAIProvider(setting.AIProvider)
			if setting.AIProvider != normalizedProvider {
				setting.AIProvider = normalizedProvider
				updates["ai_provider"] = normalizedProvider
			}
		}
		if setting.AIModel == "" {
			setting.AIModel = DefaultGeneralAIModelByProvider(setting.AIProvider)
			updates["ai_model"] = setting.AIModel
		}
		if setting.KubectlImage == "" {
			setting.KubectlImage = DefaultGeneralKubectlImageValue()
			updates["kubectl_image"] = setting.KubectlImage
		}
		if setting.NodeTerminalImage == "" {
			setting.NodeTerminalImage = DefaultGeneralNodeTerminalImageValue()
			updates["node_terminal_image"] = setting.NodeTerminalImage
		}
		if setting.ClusterAgentImage == "" {
			setting.ClusterAgentImage = DefaultGeneralClusterAgentImageValue()
			updates["cluster_agent_image"] = setting.ClusterAgentImage
		}
		if err := ensureJWTSecret(&setting, updates); err != nil {
			return nil, err
		}
		if len(updates) > 0 {
			if err := DB.Model(&setting).Updates(updates).Error; err != nil {
				return nil, err
			}
		}
		return &setting, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	setting = GeneralSetting{
		Model:             Model{ID: 1},
		AIAgentEnabled:    false,
		AIProvider:        DefaultGeneralAIProvider,
		AIModel:           DefaultGeneralAIModel,
		AIMaxTokens:       16384,
		KubectlEnabled:    true,
		KubectlImage:      DefaultGeneralKubectlImageValue(),
		NodeTerminalImage: DefaultGeneralNodeTerminalImageValue(),
		ClusterAgentImage: DefaultGeneralClusterAgentImageValue(),
		EnableMFA:         true,
	}
	if err := ensureJWTSecret(&setting, nil); err != nil {
		return nil, err
	}
	if err := DB.Create(&setting).Error; err != nil {
		return nil, err
	}
	return &setting, nil
}

// AfterSave / AfterDelete 让读缓存跟着任何写路径失效（含不经过 UpdateGeneralSetting
// 的直接写库，例如角色退休迁移与加密密钥重写）。见 SecuritySetting 上的同款钩子。
func (g *GeneralSetting) AfterSave(*gorm.DB) error {
	InvalidateGeneralSettingCache()
	return nil
}

func (g *GeneralSetting) AfterDelete(*gorm.DB) error {
	InvalidateGeneralSettingCache()
	return nil
}

// InvalidateGeneralSettingCache 让下一次读取回源。
func InvalidateGeneralSettingCache() {
	generalSettingMu.Lock()
	generalSettingEntry, generalSettingAt, generalSettingDB = nil, time.Time{}, nil
	generalSettingMu.Unlock()
}

func UpdateGeneralSetting(updates map[string]interface{}) (*GeneralSetting, error) {
	// 读的是库里的最新值：这一层要做字段归一化，用缓存里的旧值会让归一化结果过期。
	setting, err := LoadGeneralSetting()
	if err != nil {
		return nil, err
	}
	if err := DB.Model(setting).Updates(updates).Error; err != nil {
		return nil, err
	}
	if err := DB.First(setting, setting.ID).Error; err != nil {
		return nil, err
	}
	return setting, nil
}

func ensureJWTSecret(setting *GeneralSetting, updates map[string]interface{}) error {
	storedSecret := strings.TrimSpace(string(setting.JWTSecret))
	configuredSecret := strings.TrimSpace(common.JwtSecret)

	switch {
	case configuredSecret != "" && configuredSecret != common.DefaultJWTSecret:
		if storedSecret != configuredSecret {
			setting.JWTSecret = SecretString(configuredSecret)
			if updates != nil {
				updates["jwt_secret"] = setting.JWTSecret
			}
		}
		common.JwtSecret = configuredSecret
		return nil
	case storedSecret != "" && storedSecret != common.DefaultJWTSecret:
		common.JwtSecret = storedSecret
		return nil
	default:
		generatedSecret, err := generateJWTSecret()
		if err != nil {
			return err
		}
		setting.JWTSecret = SecretString(generatedSecret)
		common.JwtSecret = generatedSecret
		if updates != nil {
			updates["jwt_secret"] = setting.JWTSecret
		}
		klog.Warningf("JWT secret is using the insecure default value, generated a random secret and stored it in general setting")
		return nil
	}
}

func generateJWTSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
