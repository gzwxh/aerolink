package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"k8s.io/klog/v2"
)

type bootstrapSetupState struct {
	Initialized bool `json:"initialized"`
	Step        int  `json:"step"`
}

type bootstrapAuthOptions struct {
	Providers           []string `json:"providers"`
	CredentialProviders []string `json:"credentialProviders"`
	OAuthProviders      []string `json:"oauthProviders"`
	LoginPrompt         string   `json:"loginPrompt"`
	// MFAAvailable 是「设置 → 通用 → 启用 MFA」这个功能闸的原始值，没和策略做与运算。
	// 界面用它决定「能不能提供绑定入口」：安全策略只管谁必须绑定，不影响自愿绑定。
	MFAAvailable        bool   `json:"mfaAvailable"`
	MFAPolicy           string `json:"mfaPolicy"`
	LoginCaptchaEnabled bool   `json:"loginCaptchaEnabled"`
}

type bootstrapCapabilities struct {
	AIEnabled      bool `json:"aiEnabled"`
	KubectlEnabled bool `json:"kubectlEnabled"`
}

// bootstrapSession 描述本次登录的会话：seq 是登录序号，superseded 表示这次登录把
// 之前仍有效的会话顶下线了（单点登录），前端据此在新设备上提示「其他设备已退出」。
type bootstrapSession struct {
	Seq        uint64 `json:"seq"`
	Superseded bool   `json:"superseded"`
}

// bootstrapBranding 是控制台的外观配置。它放在公开的 bootstrap 响应里，
// 未登录的登录页 / 初始化页才能与登录后的侧边栏用同一个 logo。
type bootstrapBranding struct {
	// LogoURL 是管理员配置的自定义 logo；空串表示由前端使用内置图标。
	LogoURL string `json:"logoUrl"`
	// SiteName 是控制台展示名称；空串表示由前端使用默认名 “Kite”。
	SiteName string `json:"siteName"`
}

type bootstrapResponse struct {
	Setup                   bootstrapSetupState   `json:"setup"`
	Auth                    bootstrapAuthOptions  `json:"auth"`
	Capabilities            bootstrapCapabilities `json:"capabilities"`
	Branding                bootstrapBranding     `json:"branding"`
	Session                 bootstrapSession      `json:"session"`
	User                    *model.User           `json:"user"`
	GlobalSidebarPreference string                `json:"globalSidebarPreference"`
}

func (h *AuthHandler) Bootstrap(c *gin.Context) {
	setting, err := model.GetGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load general setting"})
		return
	}

	setup := currentBootstrapSetup()
	var user *model.User
	if setup.Step == 0 && !setup.Initialized {
		c.SetCookie("auth_token", "", -1, "/", "", false, true)
	} else {
		user = h.bootstrapUser(c, setting)
	}

	globalSidebarPreference := strings.TrimSpace(setting.GlobalSidebarPreference)
	if user == nil {
		globalSidebarPreference = ""
	}

	session := bootstrapSession{}
	if user != nil {
		if state, ok := activeSessions.current(uint64(user.ID)); ok {
			session = bootstrapSession{Seq: state.seq, Superseded: state.tookOver}
		}
	}

	c.JSON(http.StatusOK, bootstrapResponse{
		Setup: setup,
		Auth:  h.bootstrapAuth(setting),
		Capabilities: bootstrapCapabilities{
			AIEnabled:      setting.AIAgentEnabled && strings.TrimSpace(string(setting.AIAPIKey)) != "",
			KubectlEnabled: setting.KubectlEnabled,
		},
		Branding: bootstrapBranding{
			LogoURL:  strings.TrimSpace(setting.LogoURL),
			SiteName: strings.TrimSpace(setting.SiteName),
		},
		Session:                 session,
		User:                    user,
		GlobalSidebarPreference: globalSidebarPreference,
	})
}

func currentBootstrapSetup() bootstrapSetupState {
	step := 0
	uc, _ := model.CountUsers()
	if uc == 0 && !common.AnonymousUserEnabled {
		return bootstrapSetupState{Initialized: false, Step: step}
	}
	if uc > 0 || common.AnonymousUserEnabled {
		step++
	}

	if common.IsSectionManaged("clusters") {
		step++
	} else {
		cc, _ := model.CountClusters()
		if cc > 0 {
			step++
		}
	}

	return bootstrapSetupState{Initialized: step == 2, Step: step}
}

func (h *AuthHandler) bootstrapAuth(setting *model.GeneralSetting) bootstrapAuthOptions {
	var credentialProviders []string
	loginPrompt := ""

	ldapEnabled := false
	ldapSetting, err := model.GetLDAPSetting()
	if err != nil {
		klog.Warningf("Failed to load ldap setting for providers: %v", err)
	} else {
		ldapEnabled = ldapSetting.Enabled
	}

	// 启用时 LDAP 是主要的凭据方式。本地密码登录
	// 保留为备用的应急通道，这样内置管理员始终可以登录并管理授权
	// （目录用户可能缺少管理员权限）。
	//
	if setting != nil && !setting.PasswordLoginDisabled {
		credentialProviders = append(credentialProviders, model.AuthProviderPassword)
	}
	if ldapEnabled {
		credentialProviders = append(credentialProviders, model.AuthProviderLDAP)
	}
	if setting != nil {
		loginPrompt = setting.LoginPrompt
	}

	oauthProviders := uniqueStrings(h.manager.GetAvailableProviders())

	credentialProviders = uniqueStrings(credentialProviders)
	providers := append(append([]string{}, credentialProviders...), oauthProviders...)

	loginCaptchaEnabled := false
	mfaPolicy := model.MFAPolicyDisabled
	if securitySetting, err := model.GetSecuritySetting(); err == nil && securitySetting != nil {
		loginCaptchaEnabled = securitySetting.LoginCaptchaEnabled
		mfaPolicy = securitySetting.MFAPolicy
	}

	// 只下发通用设置里的功能闸原值。以前这里下发的是「功能闸 且 策略不为未启用」的综合值，
	// 界面据此把「绑定 MFA」按钮置灰，于是策略为默认值「未启用」时用户根本没法自愿绑定
	// （后端本来是允许的）。策略只回答「谁必须绑定」，走 mfaRequired / mfa_required。
	mfaAvailable := setting == nil || setting.EnableMFA

	return bootstrapAuthOptions{
		Providers:           providers,
		CredentialProviders: credentialProviders,
		OAuthProviders:      oauthProviders,
		LoginPrompt:         loginPrompt,
		MFAAvailable:        mfaAvailable,
		MFAPolicy:           mfaPolicy,
		LoginCaptchaEnabled: loginCaptchaEnabled,
	}
}

func (h *AuthHandler) bootstrapUser(c *gin.Context, setting *model.GeneralSetting) *model.User {
	if common.AnonymousUserEnabled {
		u := model.GetAnonymousUser()
		if u == nil {
			anonymousUser := model.AnonymousUser
			applyBootstrapSidebarPreference(&anonymousUser, setting)
			return &anonymousUser
		}
		currentUser := *u
		currentUser.Roles = model.AnonymousUser.Roles
		applyBootstrapSidebarPreference(&currentUser, setting)
		return &currentUser
	}

	tokenString, _ := c.Cookie("auth_token")
	if tokenString == "" {
		return nil
	}

	claims, err := h.manager.ValidateJWT(tokenString)
	if err != nil {
		refreshedToken, refreshErr := h.manager.RefreshJWT(c, tokenString)
		if refreshErr != nil {
			return nil
		}
		setCookieSecure(c, "auth_token", refreshedToken, common.CookieExpirationSeconds)
		claims, err = h.manager.ValidateJWT(refreshedToken)
		if err != nil {
			return nil
		}
	}

	user, err := model.GetUserByIDCached(uint64(claims.UserID))
	if err != nil || !user.Enabled {
		return nil
	}

	currentUser := *user
	// 与 /api/auth/user 一致：全局权限绑定组带来的角色也要展示，否则仅由绑定组授权的
	// 账号能登录、却看不到系统设置入口（前端的管理入口就是由这份角色列表推导的）。
	currentUser.Roles = rbac.RolesForDisplay(currentUser)
	// 命名空间级权限绑定组的角色同样要下发：前端的用户对象来自 bootstrap（不是
	// /api/auth/user），漏掉这里会让绑定组用户看不到「创建 / 批量删除」这类入口，
	// 即使他在组内命名空间里确实有权限。
	currentUser.NamespaceScopedRoles = rbac.NamespaceScopedBindingGroupRoles(currentUser)
	applyBootstrapSidebarPreference(&currentUser, setting)
	if securitySetting, err := model.GetSecuritySetting(); err == nil {
		currentUser.MFARequired = securitySetting.MFARequiredFor(&currentUser)
	}

	return &currentUser
}

// applyBootstrapSidebarPreference 按优先级补上要下发给客户端的侧边栏布局：
// 用户自己的布局 > 管理员发布的全局布局 > 前端的内置默认。
//
// 也就是说全局布局是「新用户/没配过的人的默认样子」，不再强制覆盖已经自己配置过的
// 账号（以前非管理员会被强制套用全局布局，连保存自己的布局都会被拒绝）。
func applyBootstrapSidebarPreference(user *model.User, setting *model.GeneralSetting) {
	if user == nil || setting == nil {
		return
	}
	if strings.TrimSpace(user.SidebarPreference) != "" {
		return
	}
	if globalSidebarPreference := strings.TrimSpace(setting.GlobalSidebarPreference); globalSidebarPreference != "" {
		user.SidebarPreference = globalSidebarPreference
	}
}
