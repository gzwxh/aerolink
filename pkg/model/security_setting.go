package model

import (
	"errors"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
)

// securitySettingCacheTTL 是安全策略的读缓存时长。
//
// 鉴权中间件每个请求都要读它（来源限制、MFA 强制注册），没有缓存就是「每请求查库 +
// 解析一遍 JSON」。10 秒足够吸收这类重复读，设置一保存就清缓存，所以界面上改完立刻生效。
const securitySettingCacheTTL = 10 * time.Second

var (
	securitySettingMu    sync.RWMutex
	securitySettingEntry *SecuritySettingData
	securitySettingAt    time.Time
	securitySettingDB    *gorm.DB

	// generalSettingCache* 同理，服务通用设置（镜像、AI、密码登录开关等）。
	generalSettingMu    sync.RWMutex
	generalSettingEntry *GeneralSetting
	generalSettingAt    time.Time
	generalSettingDB    *gorm.DB
)

const (
	MFAPolicyDisabled = "disabled"
	MFAPolicyAll      = "all"
	MFAPolicyAdmin    = "admin"
)

// SecuritySettingData 是管理员可配置的安全策略。它以单个 JSON blob 存储，
// 这样新增策略项时不需要为每个字段都做一次迁移。
type SecuritySettingData struct {
	// 认证
	LoginCaptchaEnabled      bool   `json:"loginCaptchaEnabled"`
	InactiveUserDisableDays  int    `json:"inactiveUserDisableDays"`
	RemoteLoginNoticeEnabled bool   `json:"remoteLoginNoticeEnabled"`
	MFAPolicy                string `json:"mfaPolicy"`
	MFAThirdPartyEnabled     bool   `json:"mfaThirdPartyEnabled"`
	// MFAStepUpEnabled 控制敏感操作（删除、交互式终端）是否要求
	// 已注册 MFA 的用户再次验证。
	MFAStepUpEnabled    bool   `json:"mfaStepUpEnabled"`
	MFAVerifyTTLSeconds int    `json:"mfaVerifyTtlSeconds"`
	OTPIssuerName       string `json:"otpIssuerName"`
	OTPVerifyWindow     int    `json:"otpVerifyWindow"`

	// New user defaults（新建用户的默认状态）
	DefaultUserEnabled    bool `json:"defaultUserEnabled"`
	DefaultUserExpireDays int  `json:"defaultUserExpireDays"`

	// 登录限制
	UserLoginFailLimit    int      `json:"userLoginFailLimit"`
	UserLoginBlockMinutes int      `json:"userLoginBlockMinutes"`
	IPLoginFailLimit      int      `json:"ipLoginFailLimit"`
	IPLoginBlockMinutes   int      `json:"ipLoginBlockMinutes"`
	IPWhitelist           []string `json:"ipWhitelist"`
	IPBlacklist           []string `json:"ipBlacklist"`
	SingleDeviceLogin     bool     `json:"singleDeviceLogin"`

	// RejectUnknownUsers 对应「仅存在用户登录」：只允许本地已存在的账号登录。
	// 第三方身份源按用户名匹配本地账号，首次登录时把 sub 绑到那个账号上；
	// 两边都匹配不到就拒绝登录（见 model.FindWithSubOrUpsertUser）。
	//
	// 没有沿用早期的 existingUserOnly 字段名：那个字段此前从未被后端读取，却已经
	// 在库里存成 true。沿用旧名会让升级后的实例立刻开始拒绝所有未开通的第三方
	// 用户——等于升级即故障。改名让旧值作废，变更由管理员显式打开。
	RejectUnknownUsers bool `json:"rejectUnknownUsers"`

	// LoginSourceEnforced / LoginSourceAllowlist 对应「仅从指定来源登录」：
	// 启用且列表非空时，只有列表内的来源地址能访问管理面（登录与已登录请求都拦）。
	// 列表为空视为不限制；接口会拒绝把「启用 + 空列表」保存下来。
	//
	// 同样没有沿用 loginSourceRestricted：旧值也是库里存着的 true，沿用会把登录
	// 立刻限制到内置白名单里的两条 IP，等于全体被锁在外面。
	LoginSourceEnforced  bool     `json:"loginSourceEnforced"`
	LoginSourceAllowlist []string `json:"loginSourceAllowlist"`

	// 密码策略
	PasswordExpireDays       int  `json:"passwordExpireDays"`
	PasswordHistoryCount     int  `json:"passwordHistoryCount"`
	PasswordMinLength        int  `json:"passwordMinLength"`
	AdminPasswordMinLength   int  `json:"adminPasswordMinLength"`
	PasswordMinClasses       int  `json:"passwordMinClasses"`
	PasswordRequireUppercase bool `json:"passwordRequireUppercase"`
	PasswordRequireLowercase bool `json:"passwordRequireLowercase"`
	PasswordRequireDigit     bool `json:"passwordRequireDigit"`
	PasswordRequireSpecial   bool `json:"passwordRequireSpecial"`

	// 会话
	SessionExpireOnBrowserClose bool `json:"sessionExpireOnBrowserClose"`
	SessionMaxIdleMinutes       int  `json:"sessionMaxIdleMinutes"`
	SessionMaxHours             int  `json:"sessionMaxHours"`
}

type SecuritySetting struct {
	Model
	Data JSONField `json:"-" gorm:"column:data"`
}

// DefaultIPWhitelist 是内置的默认登录白名单：这些地址不会因为登录失败被锁定，
// 避免默认部署把运维入口 IP 拉黑而失去管理通道。
func DefaultIPWhitelist() []string {
	return []string{"10.100.117.5", "10.100.240.93"}
}

func DefaultSecuritySettingData() SecuritySettingData {
	return SecuritySettingData{
		// 默认关闭：一旦开启，所有客户端都要输入验证码，
		// 在它们更新之前会打断 API / 自动化方式的登录。
		LoginCaptchaEnabled:      false,
		InactiveUserDisableDays:  999,
		RemoteLoginNoticeEnabled: true,
		MFAPolicy:                MFAPolicyDisabled,
		MFAThirdPartyEnabled:     true,
		MFAStepUpEnabled:         true,
		MFAVerifyTTLSeconds:      60,
		OTPIssuerName:            "鸢联 AeroLink",
		// 新建用户默认「激活」，默认不过期。
		DefaultUserEnabled:    true,
		DefaultUserExpireDays: 0,
		OTPVerifyWindow:       2,

		UserLoginFailLimit:    7,
		UserLoginBlockMinutes: 30,
		IPLoginFailLimit:      5,
		IPLoginBlockMinutes:   30,
		IPWhitelist:           DefaultIPWhitelist(),
		IPBlacklist:           []string{},
		SingleDeviceLogin:     false,
		RejectUnknownUsers:    false,
		LoginSourceEnforced:   false,

		PasswordExpireDays:     900,
		PasswordHistoryCount:   5,
		PasswordMinLength:      8,
		AdminPasswordMinLength: 8,
		// 四类字符（小写/大写/数字/特殊）至少包含三类；0 表示按下方
		// 各字符类开关逐项全要求。
		PasswordMinClasses:       3,
		PasswordRequireUppercase: true,
		PasswordRequireLowercase: true,
		PasswordRequireDigit:     true,
		PasswordRequireSpecial:   true,

		SessionExpireOnBrowserClose: true,
		SessionMaxIdleMinutes:       600,
		SessionMaxHours:             24,
	}
}

func NormalizeMFAPolicy(policy string) string {
	switch strings.ToLower(strings.TrimSpace(policy)) {
	case MFAPolicyAll:
		return MFAPolicyAll
	case MFAPolicyAdmin:
		return MFAPolicyAdmin
	default:
		return MFAPolicyDisabled
	}
}

// MFARequiredFor 报告策略是否强制该用户注册 MFA。
// 已经开启 MFA 的用户在登录时会被挑战，与此项无关。
func (d *SecuritySettingData) MFARequiredFor(user *User) bool {
	if d == nil || user == nil {
		return false
	}
	// 创建用户时显式选择「MFA 级别：禁用」的账号不受策略强制。
	if user.MFADisabled {
		return false
	}
	// 绑定必须由本人在登录后完成，所以只对能自助绑定的账号（本地密码 / LDAP）生效。
	// OIDC 等外部身份源放在这里强制，就成了「要求用户完成一件做不到的事」：
	// 前端绑定向导索要当前密码、后端也会 403（见 pkg/users/handler.go），
	// 账号会被 pkg/auth 的 blockForMFAEnrollment 挡在全部 API 之外。
	// 这类账号的二次验证由 IdP 负责，需要收紧就在 IdP 侧收紧。
	if !user.CanSelfEnrollMFA() {
		return false
	}
	// 「LDAP 管理员强制绑定动态码」属于「谁必须绑定」的范畴，因此并到这里，
	// 让未绑定的 LDAP 管理员被引导去绑定。放在登录环节要求一个他还没有的动态码，
	// 只会让该账号彻底无法登录（动态码为空，任何验证都失败）。
	if d.MFAThirdPartyEnabled && user.Provider == AuthProviderLDAP && hasDefaultAdminRole(user) {
		return true
	}
	switch d.MFAPolicy {
	case MFAPolicyAll:
		return true
	case MFAPolicyAdmin:
		return hasDefaultAdminRole(user)
	}
	return false
}

// hasDefaultAdminRole 报告账号是否持有内置的系统管理员角色。
func hasDefaultAdminRole(user *User) bool {
	if user == nil {
		return false
	}
	for _, role := range user.Roles {
		if role.Name == DefaultAdminRole.Name {
			return true
		}
	}
	return false
}

// Normalize 让已存储的值落在界面与登录流程预期的范围内。
func (d *SecuritySettingData) Normalize() {
	clampInt(&d.InactiveUserDisableDays, 0, 3650)
	clampInt(&d.MFAVerifyTTLSeconds, 60, 86400)
	clampInt(&d.OTPVerifyWindow, 0, 10)
	clampInt(&d.UserLoginFailLimit, 0, 100)
	clampInt(&d.UserLoginBlockMinutes, 0, 1440)
	clampInt(&d.IPLoginFailLimit, 0, 100)
	clampInt(&d.IPLoginBlockMinutes, 0, 1440)
	clampInt(&d.PasswordExpireDays, 0, 3650)
	clampInt(&d.PasswordHistoryCount, 0, 100)
	clampInt(&d.DefaultUserExpireDays, 0, 3650)
	clampInt(&d.PasswordMinLength, 1, 64)
	clampInt(&d.AdminPasswordMinLength, 1, 64)
	clampInt(&d.PasswordMinClasses, 0, 4)
	clampInt(&d.SessionMaxIdleMinutes, 1, 43200)
	clampInt(&d.SessionMaxHours, 1, 8760)

	d.MFAPolicy = NormalizeMFAPolicy(d.MFAPolicy)
	d.OTPIssuerName = strings.TrimSpace(d.OTPIssuerName)
	d.IPWhitelist = normalizeIPEntries(d.IPWhitelist)
	d.IPBlacklist = normalizeIPEntries(d.IPBlacklist)
	d.LoginSourceAllowlist = normalizeIPEntries(d.LoginSourceAllowlist)
}

func clampInt(value *int, min int, max int) {
	if *value < min {
		*value = min
	}
	if *value > max {
		*value = max
	}
}

func normalizeIPEntries(entries []string) []string {
	if entries == nil {
		return []string{}
	}
	seen := make(map[string]struct{}, len(entries))
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

// GetSecuritySetting 返回安全策略（读路径，带 10 秒缓存）。
//
// 返回的是**副本**：调用方可以放心改（设置保存流程就是「读出来→按请求体覆盖→整份写回」）。
func GetSecuritySetting() (*SecuritySettingData, error) {
	securitySettingMu.RLock()
	cached, cachedAt, cachedDB := securitySettingEntry, securitySettingAt, securitySettingDB
	securitySettingMu.RUnlock()
	// cachedDB != DB 只会在测试替换内存库时出现（生产里 DB 不会换），
	// 把它当成未命中，免得上一套库的值被当成这一套库的。
	if cached != nil && cachedDB == DB && time.Since(cachedAt) < securitySettingCacheTTL {
		copied := *cached
		return &copied, nil
	}

	data, err := LoadSecuritySetting()
	if err != nil {
		return nil, err
	}
	securitySettingMu.Lock()
	securitySettingEntry, securitySettingAt, securitySettingDB = data, time.Now(), DB
	securitySettingMu.Unlock()

	copied := *data
	return &copied, nil
}

// LoadSecuritySetting 直接读库，不走缓存。
//
// 「读出来改完再整份写回」的流程必须用它：用可能过期的缓存会把别人刚保存的改动
// 静默覆盖掉（设置保存接口就是这种写法）。
func LoadSecuritySetting() (*SecuritySettingData, error) {
	var setting SecuritySetting
	err := DB.First(&setting, 1).Error
	if err == nil {
		data := DefaultSecuritySettingData()
		if len(setting.Data) > 0 {
			if err := setting.Data.Unmarshal(&data); err != nil {
				return nil, err
			}
		}
		// 存量库中白名单为空（从未维护过）时补齐内置默认值，让默认白名单对已部署实例
		// 同样生效；管理员自行添加过条目的库不受影响。
		if len(data.IPWhitelist) == 0 {
			data.IPWhitelist = DefaultIPWhitelist()
		}
		data.Normalize()
		return &data, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	data := DefaultSecuritySettingData()
	setting = SecuritySetting{Model: Model{ID: 1}}
	if err := setting.Data.Marshal(data); err != nil {
		return nil, err
	}
	if err := DB.Create(&setting).Error; err != nil {
		return nil, err
	}
	return &data, nil
}

// AfterSave / AfterDelete 让读缓存跟着任何写路径失效。
//
// 用模型钩子而不是在各写入点手动调用：设置行还有不经过 UpdateSecuritySetting 的写法
// （角色退休迁移、加密密钥重写等），漏掉任何一处都会让改完的设置在被保存后的 10 秒内
// 仍读到旧值。
func (s *SecuritySetting) AfterSave(*gorm.DB) error {
	InvalidateSecuritySettingCache()
	return nil
}

func (s *SecuritySetting) AfterDelete(*gorm.DB) error {
	InvalidateSecuritySettingCache()
	return nil
}

// InvalidateSecuritySettingCache 让下一次读取回源。
func InvalidateSecuritySettingCache() {
	securitySettingMu.Lock()
	securitySettingEntry, securitySettingAt, securitySettingDB = nil, time.Time{}, nil
	securitySettingMu.Unlock()
}

// ErrLoginSourceAllowlistRequired 表示「仅从指定来源登录」被启用但没有任何允许地址：
// 这种配置在界面上看起来是开着的，实际什么也拦不住，因此拒绝保存。
var ErrLoginSourceAllowlistRequired = errors.New("login source enforcement requires at least one allowed address")

func UpdateSecuritySetting(data SecuritySettingData) (*SecuritySettingData, error) {
	data.Normalize()
	if data.LoginSourceEnforced && len(data.LoginSourceAllowlist) == 0 {
		return nil, ErrLoginSourceAllowlistRequired
	}

	setting := SecuritySetting{Model: Model{ID: 1}}
	if err := setting.Data.Marshal(data); err != nil {
		return nil, err
	}
	if err := DB.Save(&setting).Error; err != nil {
		return nil, err
	}
	return &data, nil
}
