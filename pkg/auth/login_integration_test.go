package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/transportkey"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestPasswordLoginSessionIsRevokedWhenUserIsDisabled(t *testing.T) {
	user := setupAuthIntegrationDB(t)
	handler := NewAuthHandler()
	router := gin.New()
	router.POST("/login", handler.PasswordLogin)
	router.GET("/protected", handler.RequireAuth(), func(c *gin.Context) {
		current := c.MustGet("user").(model.User)
		c.JSON(http.StatusOK, gin.H{"userID": current.ID})
	})

	wrong := performAuthRequest(router, http.MethodPost, "/login", `{"username":"alice","password":"wrong"}`, nil)
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-password status = %d, want %d: %s", wrong.Code, http.StatusUnauthorized, wrong.Body.String())
	}
	if len(wrong.Result().Cookies()) != 0 {
		t.Fatal("wrong-password response issued a cookie")
	}

	success := performAuthRequest(router, http.MethodPost, "/login", `{"username":" alice ","password":"correct-password"}`, nil)
	if success.Code != http.StatusNoContent {
		t.Fatalf("login status = %d, want %d: %s", success.Code, http.StatusNoContent, success.Body.String())
	}
	var authCookie *http.Cookie
	for _, cookie := range success.Result().Cookies() {
		if cookie.Name == "auth_token" {
			authCookie = cookie
			break
		}
	}
	if authCookie == nil || authCookie.Value == "" || !authCookie.HttpOnly {
		t.Fatalf("auth cookie = %#v", authCookie)
	}
	claims, err := handler.manager.ValidateJWT(authCookie.Value)
	if err != nil || claims.UserID != user.ID {
		t.Fatalf("ValidateJWT() claims = %#v, error = %v", claims, err)
	}
	stored, err := model.GetUserByID(uint64(user.ID))
	if err != nil || stored.LastLoginAt == nil {
		t.Fatalf("successful login did not update LastLoginAt: user=%#v err=%v", stored, err)
	}

	protected := performAuthRequest(router, http.MethodGet, "/protected", "", authCookie)
	if protected.Code != http.StatusOK {
		t.Fatalf("protected status = %d, want %d: %s", protected.Code, http.StatusOK, protected.Body.String())
	}
	if err := model.SetUserEnabled(user.ID, false); err != nil {
		t.Fatalf("disabling user: %v", err)
	}
	revoked := performAuthRequest(router, http.MethodGet, "/protected", "", authCookie)
	if revoked.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session status = %d, want %d", revoked.Code, http.StatusUnauthorized)
	}
}

func TestPasswordLoginHonorsMFAAndGlobalDisable(t *testing.T) {
	t.Run("MFA code required", func(t *testing.T) {
		user := setupAuthIntegrationDB(t)
		if err := model.StoreMFASecret(user.ID, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"); err != nil {
			t.Fatalf("storing MFA secret: %v", err)
		}
		if err := model.EnableUserMFA(user.ID); err != nil {
			t.Fatalf("enabling MFA: %v", err)
		}
		handler := NewAuthHandler()
		router := gin.New()
		router.POST("/login", handler.PasswordLogin)

		response := performAuthRequest(router, http.MethodPost, "/login", `{"username":"alice","password":"correct-password"}`, nil)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
		}
		var body map[string]string
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("decoding response: %v", err)
		}
		if body["error"] != "mfa_required" {
			t.Fatalf("error = %q, want mfa_required", body["error"])
		}
	})

	t.Run("password login disabled", func(t *testing.T) {
		setupAuthIntegrationDB(t)
		if err := model.DB.Model(&model.GeneralSetting{}).Where("id = ?", 1).Update("password_login_disabled", true).Error; err != nil {
			t.Fatalf("disabling password login: %v", err)
		}
		handler := NewAuthHandler()
		router := gin.New()
		router.POST("/login", handler.PasswordLogin)

		response := performAuthRequest(router, http.MethodPost, "/login", `{"username":"alice","password":"correct-password"}`, nil)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
		}
	})
}

func setupAuthIntegrationDB(t *testing.T) *model.User {
	t.Helper()
	originalDB := model.DB
	originalEncryptKey := common.EncryptKey
	originalJWTSecret := common.JwtSecret
	originalRBACConfig := rbac.RBACConfig
	originalLimiter := credentialLoginAttempts

	common.EncryptKey = "auth-integration-test-key"
	common.JwtSecret = "auth-integration-test-jwt-secret"
	// 限流状态现在在数据库里，每个用例换新库即等于清空（见 login_attempt_limiter.go）。
	credentialLoginAttempts = &credentialLoginAttemptLimiter{}
	rbac.RBACConfig = &common.RolesConfig{
		Roles: []common.Role{{Name: "viewer"}},
		RoleMapping: []common.RoleMapping{{
			Name:  "viewer",
			Users: []string{"alice"},
		}},
	}

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	// 同 mfa_flow_test：后台 RBAC 同步 goroutine 会并发读全局 model.DB，内存库必须单连接，
	// 否则可能读到另一条连接上的空库。
	if sqlDB, dbErr := db.DB(); dbErr == nil {
		sqlDB.SetMaxOpenConns(1)
	}
	// UserSession 是登录时要写会话状态的表（多副本共享同一份，见 session_policy.go）。
	// 把它一起迁出来，登录类用例才走真实的数据库路径，而不是「表不存在→失败开放」的兜底。
	if err := db.AutoMigrate(
		&model.User{},
		&model.GeneralSetting{},
		&model.PasswordHistory{},
		&model.Role{},
		&model.RoleAssignment{},
		&model.UserSession{},
		&model.LoginAttempt{},
	); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	model.DB = db
	setting := model.GeneralSetting{
		Model:             model.Model{ID: 1},
		AIProvider:        model.DefaultGeneralAIProvider,
		AIModel:           model.DefaultGeneralAIModel,
		AIMaxTokens:       4096,
		KubectlEnabled:    true,
		KubectlImage:      model.DefaultGeneralKubectlImage,
		NodeTerminalImage: model.DefaultGeneralNodeTerminalImage,
		EnableMFA:         true,
		JWTSecret:         model.SecretString(common.JwtSecret),
	}
	if err := db.Create(&setting).Error; err != nil {
		t.Fatalf("creating general setting: %v", err)
	}
	user := &model.User{Username: "alice", Password: "correct-password", Provider: model.AuthProviderPassword, Enabled: true}
	if err := model.AddUser(user); err != nil {
		t.Fatalf("creating user: %v", err)
	}
	model.InvalidateUserCache(uint64(user.ID))
	gin.SetMode(gin.TestMode)

	t.Cleanup(func() {
		model.InvalidateUserCache(uint64(user.ID))
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
		model.DB = originalDB
		common.EncryptKey = originalEncryptKey
		common.JwtSecret = originalJWTSecret
		rbac.RBACConfig = originalRBACConfig
		credentialLoginAttempts = originalLimiter
	})
	return user
}

func performAuthRequest(router *gin.Engine, method string, path string, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.RemoteAddr = "192.0.2.25:12345"
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	router.ServeHTTP(recorder, request)
	return recorder
}

// 账号有效期到期后必须立即生效：登录不再放行，此前签发的会话也不再放行。
// 「账号有效期」此前没有任何执行点，设了也不生效。
func TestExpiredAccountIsRejectedAtLoginAndOnExistingSession(t *testing.T) {
	user := setupAuthIntegrationDB(t)
	handler := NewAuthHandler()
	router := gin.New()
	router.POST("/login", handler.PasswordLogin)
	router.GET("/protected", handler.RequireAuth(), func(c *gin.Context) {
		current := c.MustGet("user").(model.User)
		c.JSON(http.StatusOK, gin.H{"userID": current.ID})
	})

	login := performAuthRequest(router, http.MethodPost, "/login", `{"username":"alice","password":"correct-password"}`, nil)
	if login.Code != http.StatusNoContent {
		t.Fatalf("login status = %d, want %d: %s", login.Code, http.StatusNoContent, login.Body.String())
	}
	var authCookie *http.Cookie
	for _, cookie := range login.Result().Cookies() {
		if cookie.Name == "auth_token" {
			authCookie = cookie
			break
		}
	}
	if authCookie == nil {
		t.Fatal("login did not issue an auth cookie")
	}
	if response := performAuthRequest(router, http.MethodGet, "/protected", "", authCookie); response.Code != http.StatusOK {
		t.Fatalf("fresh session status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}

	// 把有效期设到过去：两条路径都必须立刻拒绝。
	expiredAt := time.Now().Add(-time.Minute)
	if err := model.DB.Model(&model.User{}).Where("id = ?", user.ID).
		Update("expires_at", expiredAt).Error; err != nil {
		t.Fatalf("setting expiry: %v", err)
	}
	model.InvalidateUserCache(uint64(user.ID))

	session := performAuthRequest(router, http.MethodGet, "/protected", "", authCookie)
	if session.Code != http.StatusUnauthorized || !strings.Contains(session.Body.String(), "user_expired") {
		t.Fatalf("expired session status/code = %d/%s, want 401 with user_expired", session.Code, session.Body.String())
	}

	relogin := performAuthRequest(router, http.MethodPost, "/login", `{"username":"alice","password":"correct-password"}`, nil)
	if relogin.Code != http.StatusForbidden || !strings.Contains(relogin.Body.String(), "user_expired") {
		t.Fatalf("expired re-login status/code = %d/%s, want 403 with user_expired", relogin.Code, relogin.Body.String())
	}
}

// 新前端只发密码密文（pkg/transportkey）：既能登录，密文被篡改时也不能退回明文校验。
func TestPasswordLoginAcceptsEncryptedPayload(t *testing.T) {
	user := setupAuthIntegrationDB(t)
	t.Setenv("AEROLINK_TRANSPORT_KEY_PATH", filepath.Join(t.TempDir(), "transport-key.pem"))

	handler := NewAuthHandler()
	router := gin.New()
	router.POST("/login", handler.PasswordLogin)

	token, err := transportkey.Default().EncryptFields(map[string]string{"password": "correct-password"})
	if err != nil {
		t.Fatalf("encrypting password: %v", err)
	}
	encrypted := fmt.Sprintf(`{"username":%q,"password_enc":%q}`, user.Username, token)
	success := performAuthRequest(router, http.MethodPost, "/login", encrypted, nil)
	if success.Code != http.StatusNoContent {
		t.Fatalf("encrypted login status = %d, want %d: %s", success.Code, http.StatusNoContent, success.Body.String())
	}

	tampered := encrypted[:len(encrypted)-6] + "AAAAA\"}"
	rejected := performAuthRequest(router, http.MethodPost, "/login", tampered, nil)
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("tampered payload status = %d, want %d: %s", rejected.Code, http.StatusBadRequest, rejected.Body.String())
	}
	if !strings.Contains(rejected.Body.String(), transportkey.CodeDecryptFailed) {
		t.Fatalf("tampered payload body = %s, want code %s", rejected.Body.String(), transportkey.CodeDecryptFailed)
	}
}

// 强制模式（AEROLINK_REQUIRE_ENCRYPTED_CREDENTIALS）下明文口令直接拒绝，密文照常登录。
func TestPasswordLoginRejectsPlaintextWhenEncryptionIsRequired(t *testing.T) {
	user := setupAuthIntegrationDB(t)
	t.Setenv("AEROLINK_TRANSPORT_KEY_PATH", filepath.Join(t.TempDir(), "transport-key.pem"))
	common.RequireEncryptedCredentials = true
	t.Cleanup(func() { common.RequireEncryptedCredentials = false })

	handler := NewAuthHandler()
	router := gin.New()
	router.POST("/login", handler.PasswordLogin)

	plaintext := fmt.Sprintf(`{"username":%q,"password":"correct-password"}`, user.Username)
	rejected := performAuthRequest(router, http.MethodPost, "/login", plaintext, nil)
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("plaintext login status = %d, want %d: %s", rejected.Code, http.StatusBadRequest, rejected.Body.String())
	}
	if !strings.Contains(rejected.Body.String(), transportkey.CodeCredentialRequired) {
		t.Fatalf("plaintext login body = %s, want code %s", rejected.Body.String(), transportkey.CodeCredentialRequired)
	}

	token, err := transportkey.Default().EncryptFields(map[string]string{"password": "correct-password"})
	if err != nil {
		t.Fatalf("encrypting password: %v", err)
	}
	encrypted := fmt.Sprintf(`{"username":%q,"password_enc":%q}`, user.Username, token)
	success := performAuthRequest(router, http.MethodPost, "/login", encrypted, nil)
	if success.Code != http.StatusNoContent {
		t.Fatalf("encrypted login status = %d, want %d: %s", success.Code, http.StatusNoContent, success.Body.String())
	}
}

// 第三方登录补验动态码（/auth/mfa/verify）同样只走密文：动态码在票据有效期内等于一次
// 临时口令，明文进了代理日志就等于把会话递出去。
func TestPendingMFAVerifyAcceptsEncryptedCode(t *testing.T) {
	user := setupAuthIntegrationDB(t)
	t.Setenv("AEROLINK_TRANSPORT_KEY_PATH", filepath.Join(t.TempDir(), "transport-key.pem"))
	if err := model.DB.AutoMigrate(&model.MFAPendingTicket{}); err != nil {
		t.Fatalf("migrating pending tickets: %v", err)
	}
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	if err := model.StoreMFASecret(user.ID, secret); err != nil {
		t.Fatalf("storing MFA secret: %v", err)
	}
	if err := model.EnableUserMFA(user.ID); err != nil {
		t.Fatalf("enabling MFA: %v", err)
	}
	model.InvalidateUserCache(uint64(user.ID))

	handler := NewAuthHandler()
	router := gin.New()
	router.POST("/mfa/verify", handler.VerifyPendingMFA)

	// 票据是一次性的，每个请求都得重新签一张。
	pendingBody := func() string {
		ticket, err := issueMFATicket(user.ID)
		if err != nil {
			t.Fatalf("issuing pending ticket: %v", err)
		}
		token, err := transportkey.Default().EncryptFields(map[string]string{"mfa_code": totpNow(secret)})
		if err != nil {
			t.Fatalf("encrypting mfa code: %v", err)
		}
		return fmt.Sprintf(`{"mfa_pending":%q,"mfa_code_enc":%q}`, ticket, token)
	}

	// 改掉密文里的一个 base64 字符，RSA-OAEP 就解不开：必须是 400，不能退回明文分支。
	tampered := pendingBody()
	offset := strings.Index(tampered, `"mfa_code_enc":"`) + len(`"mfa_code_enc":"`)
	replacement := "A"
	if tampered[offset:offset+1] == "A" {
		replacement = "B"
	}
	tampered = tampered[:offset] + replacement + tampered[offset+1:]
	rejected := performAuthRequest(router, http.MethodPost, "/mfa/verify", tampered, nil)
	if rejected.Code != http.StatusBadRequest || !strings.Contains(rejected.Body.String(), transportkey.CodeDecryptFailed) {
		t.Fatalf("tampered pending code = %d: %s, want 400 with %s",
			rejected.Code, rejected.Body.String(), transportkey.CodeDecryptFailed)
	}

	success := performAuthRequest(router, http.MethodPost, "/mfa/verify", pendingBody(), nil)
	if success.Code != http.StatusNoContent {
		t.Fatalf("pending verify status = %d, want %d: %s", success.Code, http.StatusNoContent, success.Body.String())
	}
}
