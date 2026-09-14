package auth

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/captcha"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/mfa"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/notification"
	"github.com/zxh326/kite/pkg/passkey"
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
	// The first account is an administrator, so the stricter admin password rule
	// applies.
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

// Captcha hands out a fresh login captcha: a signed id plus the rendered image.
// Nothing is stored server side; the id is only valid for a few minutes and can
// be verified without keeping the answer.
//
// 路由：GET /api/auth/captcha（无需登录）。
func (h *AuthHandler) Captcha(c *gin.Context) {
	idKey, image, err := captcha.Make()
	if err != nil {
		klog.Errorf("failed to generate captcha: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate captcha"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"idKey": idKey, "image": image})
}

func (h *AuthHandler) PasskeyLoginBegin(c *gin.Context) {
	enabled, err := passkey.Enabled()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load general setting"})
		return
	}
	if !enabled {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkey login is disabled"})
		return
	}
	assertion, err := passkey.BeginLogin(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start passkey login"})
		return
	}
	c.JSON(http.StatusOK, assertion)
}

func (h *AuthHandler) PasskeyLoginFinish(c *gin.Context) {
	enabled, err := passkey.Enabled()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load general setting"})
		return
	}
	if !enabled {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkey login is disabled"})
		return
	}
	user, err := passkey.FinishLogin(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid passkey"})
		return
	}
	h.completePasswordLikeLogin(c, user)
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
		c.JSON(http.StatusForbidden, gin.H{"error": "login from this IP is not allowed"})
		return
	}
	if _, blocked := credentialLoginAttempts.blockedUntil(clientIP, username, limits); blocked {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyCredentialLoginAttemptsError})
		return
	}

	securitySetting, settingErr := model.GetSecuritySetting()
	if settingErr != nil {
		klog.Warningf("Failed to load security setting for MFA policy: %v", settingErr)
	}

	// The captcha is checked before the credentials so a wrong answer never
	// counts as a failed password attempt.
	if securitySetting != nil && securitySetting.LoginCaptchaEnabled {
		switch {
		case strings.TrimSpace(req.CaptchaToken) == "" || strings.TrimSpace(req.CaptchaCode) == "":
			c.JSON(http.StatusBadRequest, gin.H{"error": "captcha_required"})
			return
		case !captcha.Verify(req.CaptchaToken, req.CaptchaCode):
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_captcha"})
			return
		}
	}

	user, err := authenticate(username, req.Password)
	if err != nil {
		errMsg := fmt.Sprintf("%s login failed for %s: %v", strings.ToUpper(provider), username, err)
		if errors.Is(err, errLDAPUserNotProvisioned) {
			klog.V(1).Infof("LDAP login denied for %s: user not provisioned locally", username)
			c.JSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
			return
		}
		if isCredentialFailure(err) {
			if shouldRecordCredentialLoginFailure(provider, err) && credentialLoginAttempts.recordFailure(clientIP, username, limits) {
				c.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyCredentialLoginAttemptsError})
				return
			}
			c.JSON(http.StatusUnauthorized, gin.H{"error": errMsg})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
		return
	}

	// Password logins always challenge enrolled users. Third-party logins (LDAP)
	// only do so when the policy enables MFA for third-party admins; the switch
	// covers admin sign-in and sensitive operations, not every directory user.
	thirdPartyMFARequired := provider == model.AuthProviderLDAP &&
		securitySetting != nil &&
		securitySetting.MFAThirdPartyEnabled &&
		rbac.UserHasRole(*user, model.DefaultAdminRole.Name)
	mfaChallengeRequired := user.MFAEnabled &&
		(provider == model.AuthProviderPassword || thirdPartyMFARequired)

	// A browser that verified a code within the validity window is not asked
	// again.
	if mfaChallengeRequired && !mfa.IsTrusted(c, user.ID) {
		code := strings.TrimSpace(req.MFACode)
		switch {
		case code == "":
			c.JSON(http.StatusUnauthorized, gin.H{"error": "mfa_required"})
			return
		case !mfa.Verify(string(user.MFASecret), code):
			if credentialLoginAttempts.recordFailure(clientIP, username, limits) {
				c.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyCredentialLoginAttemptsError})
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

func (h *AuthHandler) completePasswordLikeLogin(c *gin.Context, user *model.User) {
	if !user.Enabled {
		c.JSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
		return
	}

	roles := rbac.GetUserRoles(*user)
	if len(roles) == 0 {
		c.JSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
		return
	}

	// Track the session so the idle / absolute lifetime limits apply.
	activeSessions.start(uint64(user.ID))

	if err := model.LoginUser(user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed login"})
		return
	}

	// Records the sign-in and warns the account when the IP is new to it.
	notification.NotifyRemoteLogin(c, user)

	jwtToken, err := h.manager.GenerateJWT(user, "")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate JWT"})
		return
	}

	setCookieSecure(c, "auth_token", jwtToken, common.CookieExpirationSeconds)

	c.Status(http.StatusNoContent)
}

// authenticateLDAPUser verifies LDAP credentials and authorizes against the
// existing local record. Directory users are provisioned by the batch/periodic
// sync, not by logins, so no user record is created or updated here.
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

	if err := model.FindWithSubOrUpsertUser(user); err != nil {
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
	role := rbac.GetUserRoles(*user)
	if len(role) == 0 {
		klog.Warningf("OAuth Callback - Access denied for user: %s (provider: %s), Username: %s, Name: %s, Sub: %s, OIDCGroups: %v",
			user.Key(), provider, user.Username, user.Name, user.Sub, user.OIDCGroups)
		c.Redirect(http.StatusFound, base+"/login?error=insufficient_permissions&reason=insufficient_permissions&user="+user.Key()+"&provider="+provider)
		return
	}
	if !user.Enabled {
		c.Redirect(http.StatusFound, base+"/login?error=user_disabled&reason=user_disabled")
		return
	}

	jwtToken, err := h.manager.GenerateJWT(user, tokenResp.RefreshToken)
	if err != nil {
		c.Redirect(http.StatusFound, base+"/login?error=jwt_generation_failed&reason=jwt_generation_failed&user="+user.Key()+"&provider="+provider)
		return
	}

	setCookieSecure(c, "auth_token", jwtToken, common.CookieExpirationSeconds)

	c.Redirect(http.StatusFound, base+"/")
}

func (h *AuthHandler) Logout(c *gin.Context) {
	setCookieSecure(c, "auth_token", "", -1)
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
	isAdmin := rbac.UserHasRole(currentUser, model.DefaultAdminRole.Name)
	setting, err := model.GetGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": fmt.Sprintf("Failed to load general setting: %v", err),
		})
		return
	}

	globalSidebarPreference := strings.TrimSpace(setting.GlobalSidebarPreference)
	hasGlobalSidebarPreference := globalSidebarPreference != ""
	if hasGlobalSidebarPreference && (!isAdmin || strings.TrimSpace(currentUser.SidebarPreference) == "") {
		currentUser.SidebarPreference = globalSidebarPreference
	}

	c.JSON(http.StatusOK, gin.H{
		"user":                       currentUser,
		"hasGlobalSidebarPreference": hasGlobalSidebarPreference,
		"globalSidebarPreference":    globalSidebarPreference,
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

	// The session policy decides how long the auth cookie lives; a zero max age
	// turns it into a session cookie that the browser drops on close.
	if name == "auth_token" && maxAge > 0 {
		maxAge = authCookieMaxAge()
	}
	if maxAge > 0 {
		maxAge += 60 * 60
	}

	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(name, value, maxAge, "/", "", secure, true)
}
