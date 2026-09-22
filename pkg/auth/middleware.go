package auth

import (
	"crypto/subtle"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/mfa"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"k8s.io/klog/v2"
)

// tokenIssuedBeforePasswordChange 报告当前令牌是否签发于账号最近一次改密码之前。
// 这样的令牌不再能证明持有当前凭据，因此既不能放行，
// 也不能被刷新成一个新会话。
func tokenIssuedBeforePasswordChange(user *model.User, claims *Claims) bool {
	if user == nil || user.PasswordUpdatedAt == nil || claims == nil || claims.IssuedAt == nil {
		return false
	}
	// NumericDate 会被截断到整秒，而 PasswordUpdatedAt 保留亚秒精度；
	// 没有这段宽限期的话，与改密码发生在同一秒内签发的令牌
	// 会被错误地吊销。
	return claims.IssuedAt.Before(user.PasswordUpdatedAt.Add(-time.Second))
}

func (h *AuthHandler) RequireAPIKeyAuth(c *gin.Context, token string) {
	keyPart := strings.SplitN(token, "-", 2)
	if len(keyPart) < 2 {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid API key",
		})
		c.Abort()
		return
	}
	id := keyPart[0]
	key := keyPart[1]
	dbID, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid API key",
		})
		c.Abort()
		return
	}
	apikey, err := model.GetUserByIDCached(dbID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid API key",
		})
		c.Abort()
		return
	}
	if !apikey.Enabled || apikey.Provider != common.APIKeyProvider || key == "" || string(apikey.APIKey) == "" ||
		subtle.ConstantTimeCompare([]byte(key), []byte(apikey.APIKey)) != 1 {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid API key",
		})
		c.Abort()
		return
	}
	_ = model.LoginUser(apikey)
	apikey.Roles = rbac.GetUserRoles(*apikey)
	c.Set("user", *apikey)

	// API key 是长期有效的机器凭据：安全策略要求破坏性操作与交互式终端
	// 做二次验证，
	// API key 不能成为绕过它的通道。
	if h.blockSensitiveOperation(c, apikey) {
		return
	}
	c.Next()
}

func (h *AuthHandler) RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		if common.AnonymousUserEnabled {
			u := model.GetAnonymousUser()
			if u == nil {
				c.Set("user", model.AnonymousUser)
			} else {
				u.Roles = model.AnonymousUser.Roles
				c.Set("user", *u)
			}
			c.Next()
			return
		}
		authHeader := c.GetHeader("Authorization")
		if authHeader != "" {
			// 认新旧两种前缀（旧前缀是改名前的存量 key），见 model.APIKeyToken。
			if after, ok := model.APIKeyToken(authHeader); ok {
				h.RequireAPIKeyAuth(c, after)
				return
			}
		}
		tokenString, _ := c.Cookie("auth_token")
		if tokenString == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid or expired token",
			})
			c.Abort()
			return
		}

		claims, err := h.manager.ValidateJWT(tokenString)
		if err != nil {
			refreshedToken, refreshErr := h.manager.RefreshJWT(c, tokenString)
			if refreshErr != nil {
				c.JSON(http.StatusUnauthorized, gin.H{
					"error": "Invalid or expired token",
				})
				setCookieSecure(c, "auth_token", "", -1)
				c.Abort()
				return
			}
			setCookieSecure(c, "auth_token", refreshedToken, common.CookieExpirationSeconds)
			claims, err = h.manager.ValidateJWT(refreshedToken)
			if err != nil {
				c.JSON(http.StatusUnauthorized, gin.H{
					"error": "Failed to validate refreshed token",
				})
				setCookieSecure(c, "auth_token", "", -1)
				c.Abort()
				return
			}
		}
		user, err := model.GetUserByIDCached(uint64(claims.UserID))
		if err != nil || !user.Enabled {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "user not found",
			})
			setCookieSecure(c, "auth_token", "", -1)
			c.Abort()
			return
		}
		// 账号有效期：到期即停止放行。每日任务也会停用它，这里覆盖任务执行前的窗口。
		if user.IsExpired(time.Now()) {
			setCookieSecure(c, "auth_token", "", -1)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "account expired", "code": "user_expired"})
			c.Abort()
			return
		}
		// 「仅从指定来源登录」：已登录的请求同样受约束，否则在允许网段建立的会话
		// 可以被带到任意网络继续使用。这里不清 cookie：换回允许的网段即可继续。
		if !loginSourceAllowed(c.ClientIP()) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "login source is not allowed",
				"code":  loginSourceDeniedCode,
			})
			c.Abort()
			return
		}
		// 在最后一次改密码之前签发的令牌，
		// 不再能证明持有当前凭据。
		if tokenIssuedBeforePasswordChange(user, claims) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "password changed, please sign in again"})
			setCookieSecure(c, "auth_token", "", -1)
			c.Abort()
			return
		}
		// 单设备策略：更新的登录会让旧令牌失效。
		// 带 code 是为了让前端区分「被顶下线」与其他 401：前者要在页面上明确提示
		// 「账号在其他地方登录」，而不是静默跳登录页。
		if activeSessions.superseded(uint64(user.ID), claims.SessionSeq) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "session was replaced by a newer sign-in",
				"code":  "session_superseded",
			})
			setCookieSecure(c, "auth_token", "", -1)
			c.Abort()
			return
		}
		if activeSessions.expired(uint64(user.ID)) {
			activeSessions.forget(uint64(user.ID))
			setCookieSecure(c, "auth_token", "", -1)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "session expired, please sign in again"})
			c.Abort()
			return
		}
		activeSessions.touch(uint64(user.ID))

		// 请求上下文里的用户同样带上全局权限绑定组（超级权限绑定）带来的角色：
		// 授权判定本来就认它们（effectiveRoles / IsAdministrator），而中间件这层还有直接
		// 读 user.Roles 的地方（MFA 强制注册、审计留痕），漏掉会出现「判定放行、这里不认」。
		user.Roles = rbac.RolesForDisplay(*user)
		c.Set("user", *user)
		if blockForMFAEnrollment(c, user) {
			return
		}
		if h.blockSensitiveOperation(c, user) {
			return
		}
		c.Next()
	}
}

// isSensitiveOperation 报告某个请求是否需要最近的 MFA 验证：
// 破坏性操作与交互式终端。
func isSensitiveOperation(method string, path string) bool {
	if method == http.MethodDelete {
		return true
	}
	if !strings.HasSuffix(path, "/ws") {
		return false
	}
	return strings.Contains(path, "/terminal/") ||
		strings.Contains(path, "/node-terminal/") ||
		strings.Contains(path, "/kubectl-terminal/")
}

// blockSensitiveOperation 在安全策略为敏感操作启用 MFA 时，
// 强制这些操作做二次验证。
func (h *AuthHandler) blockSensitiveOperation(c *gin.Context, user *model.User) bool {
	if user == nil || !user.MFAEnabled {
		return false
	}
	if !isSensitiveOperation(c.Request.Method, c.Request.URL.Path) {
		return false
	}
	if !h.mfaStepUpRequired(c, user) {
		return false
	}
	c.JSON(http.StatusForbidden, gin.H{"error": "mfa_verification_required"})
	c.Abort()
	return true
}

// mfaStepUpRequired 报告该浏览器是否必须在请求被处理前重新验证一次 MFA 码。
func (h *AuthHandler) mfaStepUpRequired(c *gin.Context, user *model.User) bool {
	if user == nil || !user.MFAEnabled {
		return false
	}
	setting, err := model.GetSecuritySetting()
	if err != nil {
		klog.Warningf("step-up verification skipped: failed to load security setting: %v", err)
		return false
	}
	if !setting.MFAStepUpEnabled {
		return false
	}
	if mfa.IsTrusted(c, user.ID) {
		return false
	}
	return true
}

// RequireMFAStepUp 保护会暴露敏感数据的路由（例如已保存的集群 kubeconfig）：
// 最近没有验证过 MFA 码的浏览器会得到 403 mfa_verification_required，
// 前端据此弹出 MFA 二次验证提示，
// 并在验证成功后重放该请求。
func (h *AuthHandler) RequireMFAStepUp() gin.HandlerFunc {
	return func(c *gin.Context) {
		user := c.MustGet("user").(model.User)
		if h.mfaStepUpRequired(c, &user) {
			c.JSON(http.StatusForbidden, gin.H{"error": "mfa_verification_required"})
			c.Abort()
			return
		}
		c.Next()
	}
}

// 在安全策略强制用户注册 MFA 期间，mfaEnrollmentPaths 里的路径仍然可访问，
// 这样账号不会被挡在注册流程之外。这里只做精确匹配：
// 若放宽为前缀匹配，就会把 /api/users/me/password 之类的接口也暴露出去。
var mfaEnrollmentPaths = map[string]struct{}{
	"/api/users/me/mfa/setup":  {},
	"/api/users/me/mfa/enable": {},
	"/api/auth/logout":         {},
	"/api/auth/refresh":        {},
	"/api/auth/user":           {},
}

// blockForMFAEnrollment 拒绝来自尚未完成 MFA 注册、
// 而策略又要求其启用 MFA 的用户的 API 调用。
func blockForMFAEnrollment(c *gin.Context, user *model.User) bool {
	if user == nil || user.MFAEnabled {
		return false
	}
	setting, err := model.GetSecuritySetting()
	if err != nil {
		klog.Warningf("MFA enrollment enforcement skipped: failed to load security setting: %v", err)
		return false
	}
	if !setting.MFARequiredFor(user) {
		return false
	}

	// 策略只有在注册相关接口确实接受请求时才能强制注册。
	// 在功能关闭的情况下于此拦截，会让账号被锁死，
	// 除了直接改数据库没有别的补救办法。
	if general, err := model.GetGeneralSetting(); err != nil || general == nil || !general.EnableMFA {
		return false
	}

	path := strings.TrimPrefix(c.Request.URL.Path, strings.TrimSuffix(common.Base, "/"))
	if _, allowed := mfaEnrollmentPaths[strings.TrimSuffix(path, "/")]; allowed {
		return false
	}

	c.JSON(http.StatusForbidden, gin.H{"error": "mfa_setup_required"})
	c.Abort()
	return true
}

func (h *AuthHandler) RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, exists := c.Get("user")
		if !exists {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Not authenticated",
			})
			c.Abort()
			return
		}

		u := user.(model.User)
		if conflict, roles := rbac.SeparationOfDutiesConflict(u); conflict {
			// 职责分离冲突单独给错误码：否则管理员只看到「要求管理员角色」，
			// 不知道是三个互斥角色被同一个账号持有了。
			c.JSON(http.StatusForbidden, gin.H{
				"error": "this account holds mutually exclusive administrator roles",
				"code":  "role_conflict",
				"roles": roles,
			})
			c.Abort()
			return
		}
		if !rbac.CanAccessAdminAPI(u) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "Admin role required",
			})
			c.Abort()
			return
		}

		c.Next()
	}
}
