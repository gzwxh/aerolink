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

// tokenIssuedBeforePasswordChange reports whether the presented token was
// minted before the account's most recent password change. Such a token no
// longer proves possession of the current credential, so it must neither grant
// access nor be refreshed into a new session.
func tokenIssuedBeforePasswordChange(user *model.User, claims *Claims) bool {
	if user == nil || user.PasswordUpdatedAt == nil || claims == nil || claims.IssuedAt == nil {
		return false
	}
	// NumericDate truncates to whole seconds while PasswordUpdatedAt keeps
	// sub-second precision; without the grace period a token minted in the
	// same second as the change would be wrongly revoked.
	return claims.IssuedAt.Time.Before(user.PasswordUpdatedAt.Add(-time.Second))
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

	// API keys are long-lived machine credentials: they must not be a way
	// around the step-up verification the security policy requires for
	// destructive calls and interactive shells.
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
			if after, ok := strings.CutPrefix(authHeader, "kite"); ok {
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
		// A token minted before the last password change no longer proves
		// possession of the current credential.
		if tokenIssuedBeforePasswordChange(user, claims) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "password changed, please sign in again"})
			setCookieSecure(c, "auth_token", "", -1)
			c.Abort()
			return
		}
		// Single-device policy: a newer sign-in invalidates older tokens.
		if activeSessions.superseded(uint64(user.ID), claims.SessionSeq) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "session was replaced by a newer sign-in"})
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

		user.Roles = rbac.GetUserRoles(*user)
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

// isSensitiveOperation reports whether a request needs a recent MFA verification:
// destructive calls and interactive shells.
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

// blockSensitiveOperation enforces the step-up verification for sensitive
// operations when the security policy enables MFA for them.
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

// mfaStepUpRequired reports whether this browser must re-verify an MFA code
// before the request may be served.
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

// RequireMFAStepUp gates routes that expose sensitive data (such as a stored
// cluster kubeconfig): browsers that have not recently verified an MFA code
// get a 403 mfa_verification_required, which the SPA turns into the MFA
// re-verification prompt and replays the request after success.
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

// mfaEnrollmentPaths stay reachable while the security policy forces the user to
// enroll in MFA, so the account is not locked out of the setup flow. Exact
// matches only: widening these to prefixes would also expose endpoints such as
// /api/users/me/password.
var mfaEnrollmentPaths = map[string]struct{}{
	"/api/users/me/mfa/setup":  {},
	"/api/users/me/mfa/enable": {},
	"/api/auth/logout":         {},
	"/api/auth/refresh":        {},
	"/api/auth/user":           {},
}

// blockForMFAEnrollment rejects API calls from users the policy requires to have
// MFA enabled before they finished the enrollment.
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

	// A policy can only force enrolment while the enrolment endpoints actually
	// accept requests. Blocking here with the feature switched off would lock
	// the account out with no way back in short of editing the database.
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
		if !rbac.UserHasRole(u, model.DefaultAdminRole.Name) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "Admin role required",
			})
			c.Abort()
			return
		}

		c.Next()
	}
}
