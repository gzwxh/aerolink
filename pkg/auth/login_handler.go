package auth

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/captcha"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/mfa"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/notification"
	"github.com/zxh326/kite/pkg/rbac"
	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

func (h *AuthHandler) Login(c *gin.Context) {
	provider := c.Query("provider")
	if provider == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "Provider parameter is required",
		})
		return
	}

	oauthProvider, err := h.manager.GetProvider(c, provider)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": err.Error(),
		})
		return
	}

	state := h.manager.GenerateState()

	klog.V(1).Infof("OAuth Login - Provider: %s, State: %s", provider, state)

	setCookieSecure(c, "oauth_state", state, 600)
	setCookieSecure(c, "oauth_provider", provider, 600)

	authURL := oauthProvider.GetAuthURL(state)
	c.JSON(http.StatusOK, gin.H{
		"auth_url": authURL,
		"provider": provider,
	})
}

func (h *AuthHandler) PasswordLogin(c *gin.Context) {
	setting, err := model.GetGeneralSetting()
	if err == nil && setting.PasswordLoginDisabled {
		c.JSON(http.StatusForbidden, gin.H{"error": "Password login is disabled"})
		return
	}
	h.handleCredentialLogin(c, model.AuthProviderPassword, h.authenticatePasswordUser)
}

func (h *AuthHandler) CreateSuperUser(c *gin.Context) {
	var userreq struct {
		Username string `json:"username" binding:"required"`
		Password string `json:"password" binding:"required"`
		Name     string `json:"name"`
	}
	if err := c.ShouldBindJSON(&userreq); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	uc, err := model.CountUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count users"})
		return
	}

	if uc > 0 {
		c.JSON(http.StatusForbidden, gin.H{"error": "super user already exists"})
		return
	}
	// 第一个账号是管理员，因此适用更严格的管理员口令规则。
	//
	if err := model.ValidatePassword(userreq.Password, true); err != nil {
		c.JSON(http.StatusBadRequest, model.PasswordErrorPayload(err))
		return
	}
	user := &model.User{
		Username: userreq.Username,
		Password: userreq.Password,
		Name:     userreq.Name,
		Provider: "password",
	}

	if err := model.AddSuperUser(user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create super user"})
		return
	}
	// 初始化超级管理员的角色与权限绑定组（幂等）。
	if err := model.EnsureSuperAdminProvisioning(); err != nil {
		klog.Warningf("Failed to provision super administrator bindings: %v", err)
	}
	// 先登记会话再签发，这样令牌带有其序号。
	activeSessions.start(uint64(user.ID))

	jwtToken, err := h.manager.GenerateJWT(user, "")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate JWT"})
		return
	}
	setCookieSecure(c, "auth_token", jwtToken, common.CookieExpirationSeconds)
	rbac.TriggerSync()
	c.JSON(http.StatusCreated, user)
}

func (h *AuthHandler) LDAPLogin(c *gin.Context) {
	h.handleCredentialLogin(c, model.AuthProviderLDAP, h.authenticateLDAPUser)
}

// Captcha 发放一个新的登录验证码：一个带签名的 id 加上渲染好的图片。
// 服务端不保存任何内容；id 只有几分钟有效，
// 且无需保存答案即可校验。
//
// 请求按 IP 限流，避免这个未认证接口被反复调用
// 来消耗 CPU 或批量获取令牌。
//
// 路由：GET /api/auth/captcha（无需登录）。
func (h *AuthHandler) Captcha(c *gin.Context) {
	if !captchaIssuer.allow(c.ClientIP()) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many captcha requests, try again later"})
		return
	}
	idKey, image, err := captcha.Make()
	if err != nil {
		klog.Errorf("failed to generate captcha: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate captcha"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"idKey": idKey, "image": image})
}

// fixedWindowRateLimiter 是一个小的固定窗口限流器，用于验证码发放
// 以及对失败登录审计写入的节流。它沿用与登录尝试跟踪相同的
// 内存实现模式。
type fixedWindowRateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	limit  int
	hits   map[string][]time.Time
	lastGC time.Time
}

var captchaIssuer = newFixedWindowRateLimiter(30, time.Minute)

// loginFailureAuditLimiter 节流「失败登录」的审计写入：登录是未认证端点，
// 不限速的话刷账号名就能把审计表写成日志洪泛。被节流的尝试仍然照常拒绝登录，
// 只是不再新增审计记录（见 recordLoginFailure）。
var loginFailureAuditLimiter = newFixedWindowRateLimiter(30, time.Minute)

func newFixedWindowRateLimiter(limit int, window time.Duration) *fixedWindowRateLimiter {
	return &fixedWindowRateLimiter{
		window: window,
		limit:  limit,
		hits:   make(map[string][]time.Time),
	}
}

// allow 报告该 key 现在是否还能再做一次被计数的操作。
func (r *fixedWindowRateLimiter) allow(ip string) bool {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	// 偶尔清理过期条目，避免 map 无界增长。
	if now.Sub(r.lastGC) > r.window {
		for key, times := range r.hits {
			kept := times[:0]
			for _, t := range times {
				if now.Sub(t) <= r.window {
					kept = append(kept, t)
				}
			}
			if len(kept) == 0 {
				delete(r.hits, key)
			} else {
				r.hits[key] = kept
			}
		}
		r.lastGC = now
	}

	times := r.hits[ip]
	fresh := times[:0]
	for _, t := range times {
		if now.Sub(t) <= r.window {
			fresh = append(fresh, t)
		}
	}
	if len(fresh) >= r.limit {
		r.hits[ip] = fresh
		return false
	}
	r.hits[ip] = append(fresh, now)
	return true
}

func (h *AuthHandler) handleCredentialLogin(c *gin.Context, provider string, authenticate credentialAuthenticator) {
	var req common.PasswordLoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request payload"})
		return
	}

	username := strings.TrimSpace(req.Username)
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request payload"})
		return
	}
	clientIP := c.ClientIP()
	limits := loadLoginLimits()
	if limits.ipBlacklisted(clientIP) {
		klog.V(1).Infof("login denied for %s: IP is not allowed", clientIP)
		recordLoginFailure(c, username, provider, model.LoginResultIPDenied)
		c.JSON(http.StatusForbidden, gin.H{"error": "login from this IP is not allowed", "code": "login_ip_denied"})
		return
	}
	if credentialLoginAttempts.blocked(clientIP, username, limits) {
		recordLoginFailure(c, username, provider, model.LoginResultTooManyAttempts)
		c.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyCredentialLoginAttemptsError, "code": "login_too_many_attempts"})
		return
	}
	if !loginSourceAllowed(clientIP) {
		klog.Warningf("login denied for %s: source address is not allowed", clientIP)
		recordLoginFailure(c, username, provider, model.LoginResultSourceDenied)
		c.JSON(http.StatusForbidden, gin.H{
			"error": "login from this address is not allowed",
			"code":  loginSourceDeniedCode,
		})
		return
	}

	securitySetting, settingErr := model.GetSecuritySetting()
	if settingErr != nil {
		klog.Warningf("Failed to load security setting for MFA policy: %v", settingErr)
	}

	// 验证码先于凭据校验，这样答错时不会
	// 被计为一次口令失败尝试。
	if securitySetting != nil && securitySetting.LoginCaptchaEnabled {
		switch {
		case strings.TrimSpace(req.CaptchaToken) == "" || strings.TrimSpace(req.CaptchaCode) == "":
			c.JSON(http.StatusBadRequest, gin.H{"error": "captcha_required"})
			return
		case !captcha.Verify(req.CaptchaToken, req.CaptchaCode):
			recordLoginFailure(c, username, provider, model.LoginResultCaptchaInvalid)
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_captcha"})
			return
		}
	}

	user, err := authenticate(username, req.Password)
	if err != nil {
		errMsg := fmt.Sprintf("%s login failed for %s: %v", strings.ToUpper(provider), username, err)
		if errors.Is(err, errLDAPUserNotProvisioned) {
			klog.V(1).Infof("LDAP login denied for %s: user not provisioned locally", username)
			recordLoginFailure(c, username, provider, model.LoginResultNotProvisioned)
			c.JSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
			return
		}
		if isCredentialFailure(err) {
			recordLoginFailure(c, username, provider, model.LoginResultInvalidCredentials)
			if shouldRecordCredentialLoginFailure(provider, err) && credentialLoginAttempts.recordFailure(clientIP, username, limits) {
				c.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyCredentialLoginAttemptsError, "code": "login_too_many_attempts"})
				return
			}
			// 不要把内部错误文本回传给客户端；它保留在
			// 日志里供运维查看。
			klog.V(1).Infof("login failed for %s from %s: %s", username, clientIP, errMsg)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials", "code": "login_invalid_credentials"})
			return
		}
		klog.Errorf("login error for %s from %s: %s", username, clientIP, errMsg)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "login failed", "code": "login_failed"})
		return
	}

	mfaChallengeRequired := mfaChallengeRequiredFor(provider, user)

	// 在有效期内已校验过一次验证码的浏览器不会再被要求输入。
	//
	if mfaChallengeRequired && !mfa.IsTrusted(c, user.ID) {
		code := strings.TrimSpace(req.MFACode)
		switch {
		case code == "":
			c.JSON(http.StatusUnauthorized, gin.H{"error": "mfa_required"})
			return
		case !mfa.Verify(string(user.MFASecret), code):
			recordLoginFailure(c, username, provider, model.LoginResultMFAInvalid)
			if credentialLoginAttempts.recordFailure(clientIP, username, limits) {
				c.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyCredentialLoginAttemptsError, "code": "login_too_many_attempts"})
				return
			}
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid_mfa_code"})
			return
		default:
			mfa.MarkTrusted(c, user.ID)
		}
	}

	credentialLoginAttempts.clear(clientIP, username)
	h.completePasswordLikeLogin(c, user)
}

// mfaChallengeRequiredFor 报告这次凭据登录是否需要动态码。
//
// 口径是「绑定即使用」：全局策略（`MFAPolicy`）回答的是「谁必须绑定 MFA」
// （见 model.SecuritySettingData.MFARequiredFor），而不是「绑定之后是否使用」。
// 所以只要账号绑定过动态码，表单类登录（密码 / LDAP）就必须验码——不看策略。
//
// 此前这里会在策略为 disabled 时整体跳过挑战，结果是自愿绑定了动态码的账号登录不再
// 验码，但敏感操作（删除、终端）仍要求验码：前后矛盾，而且让只掌握口令的一方拿到一个
// 完整会话（可读全部有权资源，只是不能删除/开终端）。
//
// 第三方登录（OIDC 等）是重定向流，无法在这个请求里收动态码，因此不在这里挑战：
// 回调改为签发票据、由登录页补验（见 VerifyPendingMFA）。
//
// 这里没有「尚未绑定也要求验码」的分支：那种要求永远无法满足（密钥为空，任何动态码都
// 验不过），只会把账号彻底锁在登录之外。「LDAP 管理员强制绑定」由
// model.SecuritySettingData.MFARequiredFor 的 `MFAThirdPartyEnabled` 表达，
// 未绑定的管理员走的是绑定向导（见 pkg/auth/middleware.go 的 blockForMFAEnrollment）。
func mfaChallengeRequiredFor(provider string, user *model.User) bool {
	if user == nil || !user.MFAEnabled {
		return false
	}
	return provider == model.AuthProviderPassword || provider == model.AuthProviderLDAP
}

func shouldRecordCredentialLoginFailure(provider string, err error) bool {
	switch provider {
	case model.AuthProviderPassword:
		return errors.Is(err, errInvalidCredentials)
	case model.AuthProviderLDAP:
		return errors.Is(err, ErrLDAPInvalidCredentials)
	default:
		return false
	}
}

// recordLoginFailure 把一次失败的登录尝试写入审计日志（等保三级安全审计）：
// 登录日志不再只有成功登录，失败尝试、被封的 IP、错误的动态码都会留痕。
//
// 写入按来源 IP 限速（loginFailureAuditLimiter）：登录是未认证端点，不限速的话
// 换账号名持续尝试就能把审计表刷成日志洪泛；被限速的尝试仍然照常返回拒绝结果。
func recordLoginFailure(c *gin.Context, username, provider, reason string) {
	if model.DB == nil {
		return
	}
	ip := c.ClientIP()
	if !loginFailureAuditLimiter.allow(ip) {
		klog.V(1).Infof("login failure audit throttled for %s (reason %s)", ip, reason)
		return
	}
	if err := model.RecordLoginFailure(username, provider, ip, c.Request.UserAgent(), reason); err != nil {
		klog.Errorf("failed to record login failure for %s: %v", username, err)
	}
}

func (h *AuthHandler) completePasswordLikeLogin(c *gin.Context, user *model.User) {
	if !user.Enabled {
		recordLoginFailure(c, user.Username, user.Provider, model.LoginResultNoPermission)
		c.JSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
		return
	}
	if user.IsExpired(time.Now()) {
		recordLoginFailure(c, user.Username, user.Provider, model.LoginResultAccountExpired)
		c.JSON(http.StatusForbidden, gin.H{"error": "account expired", "code": "user_expired"})
		return
	}

	roles := rbac.GetUserRoles(*user)
	// 仅通过权限绑定组获得授权的账号同样可以登录（绑定组本身就是授权来源）。
	if len(roles) == 0 && !rbac.HasBindingGroupMembership(*user) {
		recordLoginFailure(c, user.Username, user.Provider, model.LoginResultNoPermission)
		c.JSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
		return
	}

	// Track the session so the idle / absolute lifetime limits apply. 返回值表示这次登录
	// 把之前仍有效的会话顶下线了（单点登录），需要通知本人与管理员。
	if activeSessions.start(uint64(user.ID)) {
		notification.NotifySessionTakeover(*user, c.ClientIP(), c.GetHeader("User-Agent"))
	}

	if err := model.LoginUser(user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed login"})
		return
	}

	// 记录本次登录，并在该 IP 对账号是新的时候提醒账号。
	notification.NotifyRemoteLogin(c, user)

	jwtToken, err := h.manager.GenerateJWT(user, "")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate JWT"})
		return
	}

	setCookieSecure(c, "auth_token", jwtToken, common.CookieExpirationSeconds)

	c.Status(http.StatusNoContent)
}

// authenticateLDAPUser 校验 LDAP 凭据，并依据已有的本地记录做授权。
// 目录用户由批量/周期性同步开通，而不是由登录开通，
// 因此这里不会创建或更新用户记录。
func (h *AuthHandler) authenticateLDAPUser(username, password string) (*model.User, error) {
	setting, err := model.GetLDAPSetting()
	if err != nil {
		return nil, err
	}

	ldapUser, err := h.ldap.Authenticate(setting, username, password)
	if err != nil {
		return nil, err
	}

	localUser, err := model.GetLDAPUserByUsername(ldapUser.Username)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errLDAPUserNotProvisioned
		}
		return nil, err
	}
	return localUser, nil
}

func (h *AuthHandler) authenticatePasswordUser(username, password string) (*model.User, error) {
	user, err := model.GetUserByUsername(username)
	switch {
	case err == nil:
		if user.Provider != "" && user.Provider != model.AuthProviderPassword {
			return nil, errInvalidCredentials
		}
		if !model.CheckPassword(user.Password, password) {
			return nil, errInvalidCredentials
		}
		return user, nil
	case errors.Is(err, gorm.ErrRecordNotFound):
		return nil, errInvalidCredentials
	default:
		return nil, err
	}
}

func (h *AuthHandler) Callback(c *gin.Context) {
	base := common.Base
	if !loginSourceAllowed(c.ClientIP()) {
		klog.Warningf("OAuth Callback - login denied for %s: source address is not allowed", c.ClientIP())
		c.Redirect(http.StatusFound, base+"/login?error="+loginSourceDeniedCode+"&reason="+loginSourceDeniedCode)
		return
	}
	code := c.Query("code")
	provider, err := c.Cookie("oauth_provider")
	if err != nil {
		klog.Error("OAuth Callback - No provider found in cookie: ", err)
		c.Redirect(http.StatusFound, base+"/login?error=missing_provider&reason=no_provider_in_cookie")
		return
	}

	stateParam := c.Query("state")
	cookieState, stateErr := c.Cookie("oauth_state")

	klog.V(1).Infof("OAuth Callback - Using provider: %s\n", provider)

	if stateErr != nil || stateParam == "" || cookieState == "" || stateParam != cookieState {
		klog.Warningf("OAuth Callback - state mismatch or missing (cookieState=%v, stateParam=%v, err=%v)", cookieState, stateParam, stateErr)
		setCookieSecure(c, "oauth_state", "", -1)
		setCookieSecure(c, "oauth_provider", "", -1)
		c.Redirect(http.StatusFound, base+"/login?error=invalid_state&reason=state_mismatch")
		return
	}

	setCookieSecure(c, "oauth_state", "", -1)
	setCookieSecure(c, "oauth_provider", "", -1)

	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Authorization code not provided",
		})
		return
	}

	oauthProvider, err := h.manager.GetProvider(c, provider)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Provider not found: " + provider,
		})
		return
	}

	klog.V(1).Infof("OAuth Callback - Exchanging code for token with provider: %s", provider)
	tokenResp, err := oauthProvider.ExchangeCodeForToken(code)
	if err != nil {
		c.Redirect(http.StatusFound, base+"/login?error=token_exchange_failed&reason=token_exchange_failed&provider="+provider)
		return
	}

	klog.V(1).Infof("OAuth Callback - Getting user info with provider: %s", provider)
	user, err := oauthProvider.GetUserInfo(tokenResp.AccessToken)
	if err != nil {
		if errors.Is(err, ErrNotInAllowedGroups) {
			c.Redirect(http.StatusFound, base+"/login?error=insufficient_permissions&reason=not_in_allowed_groups&provider="+provider)
			return
		}
		c.Redirect(http.StatusFound, base+"/login?error=user_info_failed&reason=user_info_failed&provider="+provider)
		return
	}

	if user.Sub == "" {
		c.Redirect(http.StatusFound, base+"/login?error=user_info_failed&reason=user_info_failed&provider="+provider)
		return
	}

	setting, settingErr := model.GetSecuritySetting()
	if settingErr != nil {
		klog.Warningf("OAuth Callback - failed to load security setting: %v", settingErr)
	}
	if err := model.FindWithSubOrUpsertUser(user, setting != nil && setting.RejectUnknownUsers); err != nil {
		if errors.Is(err, model.ErrUserNotProvisioned) {
			klog.Warningf("OAuth Callback - Access denied for user: %s (provider: %s): no local account is provisioned",
				user.Key(), provider)
			c.Redirect(http.StatusFound, base+"/login?error=user_not_provisioned&reason=user_not_provisioned&user="+user.Key()+"&provider="+provider)
			return
		}
		if errors.Is(err, model.ErrUserProviderConflict) {
			klog.Warningf("OAuth Callback - Provider conflict for user: %s (provider: %s), username already used by another auth source",
				user.Key(), provider)
			c.Redirect(http.StatusFound, base+"/login?error=user_provider_conflict&reason=user_provider_conflict&user="+user.Key()+"&provider="+provider)
			return
		}
		c.Redirect(http.StatusFound, base+"/login?error=user_upsert_failed&reason=user_upsert_failed&provider="+provider)
		return
	}
	klog.V(1).Infof("OAuth Callback - User details: Username=%s, Name=%s, Sub=%s, Email=%s, OIDCGroups=%v",
		user.Username, user.Name, user.Sub, user.Username, user.OIDCGroups)
	// 仅通过权限绑定组获得授权的账号同样可以登录（与密码登录路径保持一致，
	// 否则用新页签授予的账号走 OIDC 登录会被直接拒绝）。
	roles := rbac.GetUserRoles(*user)
	if len(roles) == 0 && !rbac.HasBindingGroupMembership(*user) {
		klog.Warningf("OAuth Callback - Access denied for user: %s (provider: %s), Username: %s, Name: %s, Sub: %s, OIDCGroups: %v",
			user.Key(), provider, user.Username, user.Name, user.Sub, user.OIDCGroups)
		c.Redirect(http.StatusFound, base+"/login?error=insufficient_permissions&reason=insufficient_permissions&user="+user.Key()+"&provider="+provider)
		return
	}
	if !user.Enabled {
		c.Redirect(http.StatusFound, base+"/login?error=user_disabled&reason=user_disabled")
		return
	}
	if user.IsExpired(time.Now()) {
		c.Redirect(http.StatusFound, base+"/login?error=user_expired&reason=user_expired")
		return
	}

	// 提权信任不能由这次登录继承：它不是这次登录建立的，否则刚验证过的可信窗口会被
	// 沿用，敏感操作就跳过了二次验证。无论下面走哪条分支都先清掉。
	mfa.ClearTrusted(c)

	// 账号绑定过动态码就必须验码。第三方回调是重定向流，没法在这里收动态码，
	// 所以**不签发会话**，只给浏览器一张 5 分钟、一次性、HMAC 签名的票据，
	// 由登录页补验（见 VerifyPendingMFA）。
	//
	// MFAEnabled 但没有密钥属于数据不一致：此时无法验证任何动态码，
	// 拒绝登录会把这个人彻底锁在外面，所以只记日志并照常签发会话。
	if user.MFAEnabled {
		if strings.TrimSpace(string(user.MFASecret)) == "" {
			klog.Errorf("OAuth Callback - user %s has MFA enabled but no secret stored, skipping the MFA challenge", user.Key())
		} else {
			ticket, err := issueMFATicket(user.ID)
			if err != nil {
				klog.Errorf("OAuth Callback - failed to issue an MFA ticket for %s: %v", user.Key(), err)
				c.Redirect(http.StatusFound, base+"/login?error=callback_failed&reason=callback_failed&provider="+provider)
				return
			}
			klog.V(1).Infof("OAuth Callback - user %s must verify an MFA code before a session is created", user.Key())
			c.Redirect(http.StatusFound, base+"/login?mfa_pending="+url.QueryEscape(ticket))
			return
		}
	}

	if err := h.completeThirdPartyLogin(c, user, tokenResp.RefreshToken); err != nil {
		c.Redirect(http.StatusFound, base+"/login?error=jwt_generation_failed&reason=jwt_generation_failed&user="+user.Key()+"&provider="+provider)
		return
	}

	c.Redirect(http.StatusFound, base+"/")
}

// completeThirdPartyLogin 在第三方登录确认身份（必要时再加上动态码校验）之后签发会话：
// 先登记会话，让空闲/生存期限制与单设备策略生效——必须在签发之前，因为令牌要携带
// 新的会话序号——然后签发 JWT 并写入 cookie。
//
// refreshToken 只有回调路径拿得到（来自 IdP 的令牌响应），补验动态码的路径传空。
func (h *AuthHandler) completeThirdPartyLogin(c *gin.Context, user *model.User, refreshToken string) error {
	if activeSessions.start(uint64(user.ID)) {
		notification.NotifySessionTakeover(*user, c.ClientIP(), c.GetHeader("User-Agent"))
	}

	jwtToken, err := h.manager.GenerateJWT(user, refreshToken)
	if err != nil {
		return err
	}
	setCookieSecure(c, "auth_token", jwtToken, common.CookieExpirationSeconds)
	return nil
}

// MFAPendingVerifyRequest 是第三方登录补验动态码的请求体。
type MFAPendingVerifyRequest struct {
	Ticket string `json:"mfa_pending"`
	Code   string `json:"mfa_code"`
}

// VerifyPendingMFA 用回调阶段签发的票据 + 动态码换取会话。
//
// 票据只证明「身份源认证已通过」，它本身换不到任何权限；动态码校验通过后票据才作废
// （一次性）。失败按凭据登录的同一套限流计数，所以猜码会在若干次后被锁定。
func (h *AuthHandler) VerifyPendingMFA(c *gin.Context) {
	var req MFAPendingVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}

	respondInvalidTicket := func() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "mfa_pending_invalid", "code": "mfa_pending_invalid"})
	}

	payload, err := validateMFATicket(strings.TrimSpace(req.Ticket), time.Now())
	if err != nil {
		respondInvalidTicket()
		return
	}

	user, err := model.GetUserByID(uint64(payload.UserID))
	if err != nil || !user.MFAEnabled || strings.TrimSpace(string(user.MFASecret)) == "" {
		respondInvalidTicket()
		return
	}

	// 票据有效期内账号可能被停用、过期，或换到不允许的来源网段。会话签发前再确认一次，
	// 与回调、凭据登录用同一套判定（fail-closed）。
	if !loginSourceAllowed(c.ClientIP()) {
		recordLoginFailure(c, user.Username, user.Provider, model.LoginResultSourceDenied)
		c.JSON(http.StatusForbidden, gin.H{
			"error": "login from this address is not allowed",
			"code":  loginSourceDeniedCode,
		})
		return
	}
	if !user.Enabled {
		recordLoginFailure(c, user.Username, user.Provider, model.LoginResultNoPermission)
		c.JSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
		return
	}
	if user.IsExpired(time.Now()) {
		recordLoginFailure(c, user.Username, user.Provider, model.LoginResultAccountExpired)
		c.JSON(http.StatusForbidden, gin.H{"error": "account expired", "code": "user_expired"})
		return
	}

	clientIP := c.ClientIP()
	limits := loadLoginLimits()
	if credentialLoginAttempts.blocked(clientIP, user.Username, limits) {
		recordLoginFailure(c, user.Username, user.Provider, model.LoginResultTooManyAttempts)
		c.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyCredentialLoginAttemptsError, "code": "login_too_many_attempts"})
		return
	}

	if !mfa.Verify(string(user.MFASecret), strings.TrimSpace(req.Code)) {
		recordLoginFailure(c, user.Username, user.Provider, model.LoginResultMFAInvalid)
		if credentialLoginAttempts.recordFailure(clientIP, user.Username, limits) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyCredentialLoginAttemptsError, "code": "login_too_many_attempts"})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid_mfa_code"})
		return
	}

	// 动态码通过之后才作废票据：输错一次不该逼用户重新走一遍身份源登录。
	if err := consumeMFATicket(payload, time.Now()); err != nil {
		respondInvalidTicket()
		return
	}

	credentialLoginAttempts.clear(clientIP, user.Username)
	mfa.MarkTrusted(c, user.ID)

	if err := h.completeThirdPartyLogin(c, user, ""); err != nil {
		klog.Errorf("failed to complete the third-party login for %s after MFA verification: %v", user.Key(), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate JWT"})
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *AuthHandler) Logout(c *gin.Context) {
	setCookieSecure(c, "auth_token", "", -1)
	// 提权信任标记不能比会话活得更久，否则
	// 同一个浏览器上的下一次登录会跳过 MFA 二次验证。
	mfa.ClearTrusted(c)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Logged out successfully",
	})
}

func (h *AuthHandler) GetUser(c *gin.Context) {
	user, exists := c.Get("user")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Not authenticated",
		})
		return
	}

	currentUser := user.(model.User)
	// 全局作用域权限绑定组（超级权限绑定）带来的角色对所有集群与命名空间生效，
	// 按用户自身角色一并展示，使控制台的管理入口与权限判定保持一致。
	currentUser.Roles = rbac.RolesForDisplay(currentUser)
	// 命名空间级权限绑定组的角色单独下发：前端据此在绑定组范围外隐藏创建 / 批量删除等
	// 不受单个命名空间约束的入口。刻意不并入 Roles，避免影响 IsAdministrator 判定。
	currentUser.NamespaceScopedRoles = rbac.NamespaceScopedBindingGroupRoles(currentUser)
	setting, err := model.GetGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": fmt.Sprintf("Failed to load general setting: %v", err),
		})
		return
	}

	// 优先级：用户自己的布局 > 管理员发布的全局布局 > 前端内置默认。
	applyBootstrapSidebarPreference(&currentUser, setting)

	c.JSON(http.StatusOK, gin.H{
		"user":                    currentUser,
		"globalSidebarPreference": strings.TrimSpace(setting.GlobalSidebarPreference),
	})
}

func (h *AuthHandler) RefreshToken(c *gin.Context) {
	tokenString, err := c.Cookie("auth_token")
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "No token found",
		})
		return
	}

	newToken, err := h.manager.RefreshJWT(c, tokenString)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Failed to refresh token",
		})
		return
	}

	setCookieSecure(c, "auth_token", newToken, common.CookieExpirationSeconds)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Token refreshed successfully",
	})
}

func setCookieSecure(c *gin.Context, name, value string, maxAge int) {
	secure := strings.HasPrefix(common.Host, "https://") || (c.Request != nil && (c.Request.TLS != nil || strings.EqualFold(c.Request.Header.Get("X-Forwarded-Proto"), "https")))

	// 会话策略决定 auth cookie 的存活时长；max age 为零时
	// 它变成会话 cookie，浏览器关闭即丢弃。
	// 额外的一小时宽限只作用于 auth cookie：
	// oauth_state 之类的临时值必须保持调用方要求的 TTL。
	if name == "auth_token" && maxAge > 0 {
		maxAge = authCookieMaxAge()
		if maxAge > 0 {
			maxAge += 60 * 60
		}
	}

	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(name, value, maxAge, "/", "", secure, true)
}
