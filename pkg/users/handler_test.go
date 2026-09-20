package users

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// TestChangeCurrentUserPasswordVerifiesCurrentPassword 覆盖自助改密的核心约束：
// 原密码错误时返回 400，且数据库里已存的哈希保持不变；
// 原密码正确时才把密码替换为新值。
func TestChangeCurrentUserPasswordVerifiesCurrentPassword(t *testing.T) {
	user := setupUserHandlerTestDB(t)
	router := gin.New()
	router.PUT("/password", func(c *gin.Context) {
		c.Set("user", *user)
		ChangeCurrentUserPassword(c)
	})

	wrong := performUserRequest(router, http.MethodPut, "/password", `{"current_password":"wrong","new_password":"new-secret"}`)
	if wrong.Code != http.StatusBadRequest {
		t.Fatalf("wrong-password status = %d, want %d", wrong.Code, http.StatusBadRequest)
	}
	stored, err := model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading user after rejected change: %v", err)
	}
	if !model.CheckPassword(stored.Password, "old-secret") || model.CheckPassword(stored.Password, "new-secret") {
		t.Fatal("rejected password change modified the stored password")
	}

	success := performUserRequest(router, http.MethodPut, "/password", `{"current_password":"old-secret","new_password":"new-secret"}`)
	if success.Code != http.StatusOK {
		t.Fatalf("successful status = %d, want %d: %s", success.Code, http.StatusOK, success.Body.String())
	}
	stored, err = model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading user after password change: %v", err)
	}
	if !model.CheckPassword(stored.Password, "new-secret") || model.CheckPassword(stored.Password, "old-secret") {
		t.Fatal("successful password change did not replace the stored hash")
	}
}

// TestUpdateCurrentUserLocalUserProfile 覆盖本地密码用户的自助资料更新：
// 四个字段都会被写入并落库，响应体回传更新后的用户；
// 邮箱格式非法时返回 400，且一个字段都不会被改动。
func TestUpdateCurrentUserLocalUserProfile(t *testing.T) {
	user := setupUserHandlerTestDB(t)
	router := updateCurrentUserRouter(t, uint64(user.ID))

	response := performUserRequest(router, http.MethodPut, "/me",
		`{"name":" Alice A ","email":" alice@example.com ","phone":"12345678","avatar_url":"https://example.com/a.png"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"email":"alice@example.com"`) {
		t.Fatalf("response does not carry the updated user: %s", response.Body.String())
	}
	stored := loadStoredUser(t, uint64(user.ID))
	if stored.Name != "Alice A" || stored.Email != "alice@example.com" || stored.Phone != "12345678" ||
		stored.AvatarURL != "https://example.com/a.png" {
		t.Fatalf("stored profile = %#v", stored)
	}

	// 邮箱写不进去就等于通知发不出去，必须在落库前拒绝，且其他字段也不能被顺带改掉。
	invalid := performUserRequest(router, http.MethodPut, "/me",
		`{"name":"Changed","email":"not-an-email","phone":"999","avatar_url":"https://example.com/b.png"}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid email status = %d, want %d: %s", invalid.Code, http.StatusBadRequest, invalid.Body.String())
	}
	if body := invalid.Body.String(); !strings.Contains(body, "email is not a valid email address") {
		t.Fatalf("invalid email error is not readable: %s", body)
	}
	after := loadStoredUser(t, uint64(user.ID))
	if after.Name != "Alice A" || after.Email != "alice@example.com" || after.Phone != "12345678" ||
		after.AvatarURL != "https://example.com/a.png" {
		t.Fatalf("rejected update modified the stored profile: %#v", after)
	}
}

// TestUpdateCurrentUserFieldLimits 校验自服务字段的长度边界：
// 溢出模型列宽时返回 400 而不是静默截断，恰好等于列宽时正常写入。
func TestUpdateCurrentUserFieldLimits(t *testing.T) {
	user := setupUserHandlerTestDB(t)
	router := updateCurrentUserRouter(t, uint64(user.ID))

	overlong := []struct {
		field string
		body  string
	}{
		{"name", fmt.Sprintf(`{"name":%q}`, strings.Repeat("a", maxProfileNameLength+1))},
		{"phone", fmt.Sprintf(`{"phone":%q}`, strings.Repeat("1", maxProfilePhoneLength+1))},
		{"avatar_url", fmt.Sprintf(`{"avatar_url":%q}`, strings.Repeat("u", maxProfileAvatarLength+1))},
	}
	for _, tc := range overlong {
		response := performUserRequest(router, http.MethodPut, "/me", tc.body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("overlong %s status = %d, want %d: %s", tc.field, response.Code, http.StatusBadRequest, response.Body.String())
		}
		if stored := loadStoredUser(t, uint64(user.ID)); stored.Name != "" || stored.Phone != "" || stored.AvatarURL != "" {
			t.Fatalf("overlong %s still modified the stored profile: %#v", tc.field, stored)
		}
	}

	// 长度上限本身是允许的，避免把边界算成溢出。
	boundary := fmt.Sprintf(`{"name":%q}`, strings.Repeat("a", maxProfileNameLength))
	allowed := performUserRequest(router, http.MethodPut, "/me", boundary)
	if allowed.Code != http.StatusOK {
		t.Fatalf("boundary name status = %d, want %d: %s", allowed.Code, http.StatusOK, allowed.Body.String())
	}
	if stored := loadStoredUser(t, uint64(user.ID)); len(stored.Name) != maxProfileNameLength {
		t.Fatalf("boundary name length = %d, want %d", len(stored.Name), maxProfileNameLength)
	}
}

// TestUpdateCurrentUserDirectoryUserOnlyChangesAvatar 覆盖目录同步账号的字段归属：
// 昵称 / 邮箱 / 联系方式由源系统掌管，传入后被静默忽略，只有本地头像生效，
// 整体返回 200——旧实现对这类用户直接返回 403。
func TestUpdateCurrentUserDirectoryUserOnlyChangesAvatar(t *testing.T) {
	setupUserHandlerTestDB(t)
	directoryUser := &model.User{
		Username: "ldap-alice",
		Name:     "Directory Name",
		Email:    "directory@example.com",
		Phone:    "10086",
		Provider: model.AuthProviderLDAP,
		Enabled:  true,
	}
	if err := model.DB.Create(directoryUser).Error; err != nil {
		t.Fatalf("creating directory user: %v", err)
	}
	router := updateCurrentUserRouter(t, uint64(directoryUser.ID))

	response := performUserRequest(router, http.MethodPut, "/me",
		`{"name":"Local Override","email":"local@example.com","phone":"000","avatar_url":"data:image/png;base64,AAAA"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("directory user status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	stored := loadStoredUser(t, uint64(directoryUser.ID))
	if stored.Name != "Directory Name" || stored.Email != "directory@example.com" ||
		stored.Phone != "10086" {
		t.Fatalf("source-controlled fields were overwritten: %#v", stored)
	}
	if stored.AvatarURL != "data:image/png;base64,AAAA" {
		t.Fatalf("avatar not updated for directory user: %q", stored.AvatarURL)
	}
}

// TestUpdateCurrentUserCanClearOptionalFields 传空字符串表示清空可选字段，
// 而不是「未提交」；未出现在请求里的字段则保持不变。
func TestUpdateCurrentUserCanClearOptionalFields(t *testing.T) {
	user := setupUserHandlerTestDB(t)
	router := updateCurrentUserRouter(t, uint64(user.ID))

	seeded := performUserRequest(router, http.MethodPut, "/me",
		`{"name":"Alice","email":"alice@example.com","phone":"12345678"}`)
	if seeded.Code != http.StatusOK {
		t.Fatalf("seeding profile status = %d: %s", seeded.Code, seeded.Body.String())
	}

	cleared := performUserRequest(router, http.MethodPut, "/me", `{"email":""}`)
	if cleared.Code != http.StatusOK {
		t.Fatalf("clearing email status = %d, want %d: %s", cleared.Code, http.StatusOK, cleared.Body.String())
	}
	stored := loadStoredUser(t, uint64(user.ID))
	if stored.Email != "" {
		t.Fatalf("email not cleared: %q", stored.Email)
	}
	if stored.Name != "Alice" || stored.Phone != "12345678" {
		t.Fatalf("fields absent from the request were modified: %#v", stored)
	}
}

// TestCurrentUserMFALifecycle 走完整条 TOTP 生命周期：
// setup 只写入「待确认」密钥且 MFA 仍未启用 → enable 校验动态码后正式启用 →
// disable 再校验一次动态码，随后连同密钥一起清除。
func TestCurrentUserMFALifecycle(t *testing.T) {
	user := setupUserHandlerTestDB(t)
	router := gin.New()
	router.POST("/mfa/setup", func(c *gin.Context) {
		current, err := model.GetUserByID(uint64(user.ID))
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Set("user", *current)
		SetupCurrentUserMFA(c)
	})
	router.POST("/mfa/enable", func(c *gin.Context) {
		current, err := model.GetUserByID(uint64(user.ID))
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Set("user", *current)
		EnableCurrentUserMFA(c)
	})
	router.POST("/mfa/disable", func(c *gin.Context) {
		current, err := model.GetUserByID(uint64(user.ID))
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Set("user", *current)
		DisableCurrentUserMFA(c)
	})

	setup := performUserRequest(router, http.MethodPost, "/mfa/setup", `{"current_password":"old-secret"}`)
	if setup.Code != http.StatusOK {
		t.Fatalf("setup status = %d, want %d: %s", setup.Code, http.StatusOK, setup.Body.String())
	}
	var setupBody struct {
		Secret     string `json:"secret"`
		OTPAuthURL string `json:"otpauth_url"`
		QRCode     string `json:"qr_code"`
	}
	if err := json.Unmarshal(setup.Body.Bytes(), &setupBody); err != nil {
		t.Fatalf("decoding setup response: %v", err)
	}
	if setupBody.Secret == "" || !strings.Contains(setupBody.OTPAuthURL, setupBody.Secret) || !strings.HasPrefix(setupBody.QRCode, "data:image/png;base64,") {
		t.Fatalf("invalid MFA setup response: %#v", setupBody)
	}
	pending, err := model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading pending MFA user: %v", err)
	}
	if pending.MFAEnabled || string(pending.MFASecret) != setupBody.Secret {
		t.Fatalf("pending MFA state = enabled:%v secret:%q", pending.MFAEnabled, pending.MFASecret)
	}

	code := currentTOTPCode(t, setupBody.Secret)
	enable := performUserRequest(router, http.MethodPost, "/mfa/enable", fmt.Sprintf(`{"code":%q}`, code))
	if enable.Code != http.StatusOK {
		t.Fatalf("enable status = %d, want %d: %s", enable.Code, http.StatusOK, enable.Body.String())
	}
	enabled, err := model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading enabled MFA user: %v", err)
	}
	if !enabled.MFAEnabled || string(enabled.MFASecret) != setupBody.Secret {
		t.Fatalf("enabled MFA state = enabled:%v secret:%q", enabled.MFAEnabled, enabled.MFASecret)
	}

	disable := performUserRequest(router, http.MethodPost, "/mfa/disable", fmt.Sprintf(`{"code":%q}`, currentTOTPCode(t, setupBody.Secret)))
	if disable.Code != http.StatusOK {
		t.Fatalf("disable status = %d, want %d: %s", disable.Code, http.StatusOK, disable.Body.String())
	}
	disabled, err := model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading disabled MFA user: %v", err)
	}
	if disabled.MFAEnabled || disabled.MFASecret != "" {
		t.Fatalf("disabled MFA state = enabled:%v secret:%q", disabled.MFAEnabled, disabled.MFASecret)
	}
}

// mfaSetupRouter 构造一个只挂 MFA 自助绑定接口（setup + enable）的路由，
// 每个请求都像鉴权中间件那样重新从数据库读取当前用户放进 context。
func mfaSetupRouter(t *testing.T, id uint64) *gin.Engine {
	t.Helper()
	router := gin.New()
	withCurrentUser := func(handler gin.HandlerFunc) gin.HandlerFunc {
		return func(c *gin.Context) {
			current, err := model.GetUserByID(id)
			if err != nil {
				c.Status(http.StatusInternalServerError)
				return
			}
			c.Set("user", *current)
			handler(c)
		}
	}
	router.POST("/mfa/setup", withCurrentUser(SetupCurrentUserMFA))
	router.POST("/mfa/enable", withCurrentUser(EnableCurrentUserMFA))
	return router
}

// addDirectoryUser 建一个目录账号（LDAP 或 OIDC），用来验证 provider 维度的门禁：
// 能自助绑定的只有本地密码账号与 LDAP 账号。
func addDirectoryUser(t *testing.T, username, provider string) *model.User {
	t.Helper()
	user := &model.User{Username: username, Provider: provider, Enabled: true}
	if err := model.AddUser(user); err != nil {
		t.Fatalf("creating %s user: %v", provider, err)
	}
	return user
}

// OIDC / 第三方身份源的二次验证由 IdP 负责：Kite 里既没有可校验的口令，
// 也不该提供绑定入口，否则用户会卡在一个走不完的绑定向导里。
func TestSetupCurrentUserMFADeniesAccountsThatCannotSelfEnroll(t *testing.T) {
	setupUserHandlerTestDB(t)
	user := addDirectoryUser(t, "oidc-user", "oidc")
	router := mfaSetupRouter(t, uint64(user.ID))

	response := performUserRequest(router, http.MethodPost, "/mfa/setup", `{}`)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusForbidden, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "mfa_not_self_enrollable") {
		t.Fatalf("response lacks the machine-readable code: %s", response.Body.String())
	}
}

// LDAP 账号在 Kite 侧没有可校验的口令，再认证改用「近期重新登录过」：
// 登录时间就是 user_sessions.started_at，只有真正走完登录流程才会刷新。
func TestSetupCurrentUserMFAForLDAPRequiresARecentSignIn(t *testing.T) {
	setupUserHandlerTestDB(t)
	// 用不同 provider 的两个账号，避免把「无会话记录」误判成「provider 判定」。
	user := addDirectoryUser(t, "ldap-user", model.AuthProviderLDAP)
	router := mfaSetupRouter(t, uint64(user.ID))

	// 没有任何会话记录（例如登录发生在这套机制之前）：失败关闭，要求重新登录。
	noSession := performUserRequest(router, http.MethodPost, "/mfa/setup", `{}`)
	if noSession.Code != http.StatusForbidden || !strings.Contains(noSession.Body.String(), "mfa_reauth_required") {
		t.Fatalf("without a session: status/body = %d/%s, want 403 with mfa_reauth_required",
			noSession.Code, noSession.Body.String())
	}

	// 会话存在但已超出 5 分钟窗口：同样要求重新登录。
	if _, err := model.StartUserSession(user.ID, time.Now().Add(-10*time.Minute)); err != nil {
		t.Fatalf("recording a stale session: %v", err)
	}
	stale := performUserRequest(router, http.MethodPost, "/mfa/setup", `{}`)
	if stale.Code != http.StatusForbidden || !strings.Contains(stale.Body.String(), "mfa_reauth_required") {
		t.Fatalf("stale session: status/body = %d/%s, want 403 with mfa_reauth_required",
			stale.Code, stale.Body.String())
	}

	// 刚刚重新登录过：不需要口令即可拿到密钥（口令字段对目录账号没有意义），
	// 但仍然只是「待确认」状态，必须再提交一次动态码才算绑定完成。
	if _, err := model.StartUserSession(user.ID, time.Now()); err != nil {
		t.Fatalf("recording a fresh session: %v", err)
	}
	fresh := performUserRequest(router, http.MethodPost, "/mfa/setup", `{}`)
	if fresh.Code != http.StatusOK {
		t.Fatalf("fresh session: status = %d, want %d: %s", fresh.Code, http.StatusOK, fresh.Body.String())
	}
	pending := loadStoredUser(t, uint64(user.ID))
	if pending.MFAEnabled || strings.TrimSpace(string(pending.MFASecret)) == "" {
		t.Fatalf("pending MFA state = enabled:%v secret:%q", pending.MFAEnabled, pending.MFASecret)
	}

	// 第二步必须在目录账号上也能走通（改前这里会 403，绑定到一半就断）。
	enable := performUserRequest(router, http.MethodPost, "/mfa/enable",
		fmt.Sprintf(`{"code":%q}`, currentTOTPCode(t, string(pending.MFASecret))))
	if enable.Code != http.StatusOK {
		t.Fatalf("enable status = %d, want %d: %s", enable.Code, http.StatusOK, enable.Body.String())
	}
	if enabled := loadStoredUser(t, uint64(user.ID)); !enabled.MFAEnabled {
		t.Fatal("directory account is still not marked as MFA enabled")
	}
}

// 本地密码账号仍然必须提交当前密码：会话新鲜度不是口令的替代品
// （令牌被盗时，攻击者拿不到口令就绑不了自己的身份验证器）。
func TestSetupCurrentUserMFAForPasswordUserRequiresTheCurrentPassword(t *testing.T) {
	user := setupUserHandlerTestDB(t)
	if _, err := model.StartUserSession(user.ID, time.Now()); err != nil {
		t.Fatalf("recording a fresh session: %v", err)
	}
	router := mfaSetupRouter(t, uint64(user.ID))

	missing := performUserRequest(router, http.MethodPost, "/mfa/setup", `{}`)
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing password status = %d, want %d: %s", missing.Code, http.StatusBadRequest, missing.Body.String())
	}
	// 空口令要报「必填」而不是「密码错误」：后者会让用户以为输错了口令。
	if body := missing.Body.String(); !strings.Contains(body, "current password is required") {
		t.Fatalf("missing password is not reported as required: %s", body)
	}
	wrong := performUserRequest(router, http.MethodPost, "/mfa/setup", `{"current_password":"wrong-secret"}`)
	if wrong.Code != http.StatusBadRequest {
		t.Fatalf("wrong password status = %d, want %d: %s", wrong.Code, http.StatusBadRequest, wrong.Body.String())
	}
	if stored := loadStoredUser(t, uint64(user.ID)); strings.TrimSpace(string(stored.MFASecret)) != "" {
		t.Fatalf("rejected requests stored a secret: %q", stored.MFASecret)
	}
}

// TestSetupCurrentUserMFAHonorsGlobalSetting 验证全局关闭 MFA 时，
// setup 会被 403 挡下，不会生成或保存任何密钥。
func TestSetupCurrentUserMFAHonorsGlobalSetting(t *testing.T) {
	user := setupUserHandlerTestDB(t)
	if err := model.DB.Model(&model.GeneralSetting{}).Where("id = ?", 1).Update("enable_mfa", false).Error; err != nil {
		t.Fatalf("disabling MFA setting: %v", err)
	}
	router := gin.New()
	router.POST("/mfa/setup", func(c *gin.Context) {
		c.Set("user", *user)
		SetupCurrentUserMFA(c)
	})

	response := performUserRequest(router, http.MethodPost, "/mfa/setup", `{"current_password":"old-secret"}`)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

// TestUpdateSidebarPreferenceHonorsGlobalPolicy 验证全局侧边栏只作为默认值：
// 已设置全局布局时，普通用户仍然可以保存自己的布局并落库；
// 管理员同样可以保存自己的偏好。
func TestUpdateSidebarPreferenceHonorsGlobalPolicy(t *testing.T) {
	user := setupUserHandlerTestDB(t)
	if _, err := model.UpdateGeneralSetting(map[string]interface{}{
		"global_sidebar_preference": `{"sections":["workloads"]}`,
	}); err != nil {
		t.Fatalf("setting global sidebar preference: %v", err)
	}

	user.Roles = []common.Role{}
	userRouter := gin.New()
	userRouter.PUT("/sidebar", func(c *gin.Context) {
		c.Set("user", *user)
		UpdateSidebarPreference(c)
	})
	saved := performUserRequest(userRouter, http.MethodPut, "/sidebar", `{"sidebar_preference":"{\"sections\":[\"custom\"]}"}`)
	if saved.Code != http.StatusOK {
		t.Fatalf("non-admin status = %d, want %d: %s", saved.Code, http.StatusOK, saved.Body.String())
	}
	stored, err := model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading user: %v", err)
	}
	if stored.SidebarPreference != `{"sections":["custom"]}` {
		t.Fatalf("non-admin preference = %q", stored.SidebarPreference)
	}

	admin := *user
	admin.Roles = []common.Role{{Name: model.DefaultAdminRole.Name}}
	adminRouter := gin.New()
	adminRouter.PUT("/sidebar", func(c *gin.Context) {
		c.Set("user", admin)
		UpdateSidebarPreference(c)
	})
	allowed := performUserRequest(adminRouter, http.MethodPut, "/sidebar", `{"sidebar_preference":"{\"sections\":[\"admin\"]}"}`)
	if allowed.Code != http.StatusOK {
		t.Fatalf("admin status = %d, want %d: %s", allowed.Code, http.StatusOK, allowed.Body.String())
	}
	stored, err = model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading admin user: %v", err)
	}
	if stored.SidebarPreference != `{"sections":["admin"]}` {
		t.Fatalf("admin preference = %q", stored.SidebarPreference)
	}
}

// updateCurrentUserRouter 构造一个只挂 UpdateCurrentUser 的路由。
// 每个请求都像鉴权中间件那样，从数据库重新读取当前用户放进 context。
func updateCurrentUserRouter(t *testing.T, id uint64) *gin.Engine {
	t.Helper()
	router := gin.New()
	router.PUT("/me", func(c *gin.Context) {
		current, err := model.GetUserByID(id)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Set("user", *current)
		UpdateCurrentUser(c)
	})
	return router
}

// loadStoredUser 从数据库读取用户，用于断言请求是否真的落库。
func loadStoredUser(t *testing.T, id uint64) *model.User {
	t.Helper()
	user, err := model.GetUserByID(id)
	if err != nil {
		t.Fatalf("loading user %d: %v", id, err)
	}
	return user
}

// setupUserHandlerTestDB 为每个用例准备一套隔离的测试环境：
// 打开内存 SQLite 并迁移 User / GeneralSetting 表，写入默认全局设置
// （打开 MFA）和本地密码用户 alice，最后用 t.Cleanup 还原
// 被替换的全局状态（model.DB、加密密钥、JWT 密钥）并关闭连接。
func setupUserHandlerTestDB(t *testing.T) *model.User {
	t.Helper()
	originalDB := model.DB
	originalEncryptKey := common.KiteEncryptKey
	originalJWTSecret := common.JwtSecret
	common.KiteEncryptKey = "users-handler-test-key"
	common.JwtSecret = "users-handler-test-jwt-secret"

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	// UserSession 是「近期重新登录过」的判定依据（目录账号自助绑定走这条，见
	// pkg/users/handler.go 的 recentlyAuthenticated）；不迁它就只能落到「查不到会话」
	// 的失败关闭分支，测不出通过路径。
	if err := db.AutoMigrate(&model.User{}, &model.GeneralSetting{}, &model.PasswordHistory{}, &model.UserSession{}); err != nil {
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
	user := &model.User{Username: "alice", Password: "old-secret", Provider: model.AuthProviderPassword, Enabled: true}
	if err := model.AddUser(user); err != nil {
		t.Fatalf("creating user: %v", err)
	}
	gin.SetMode(gin.TestMode)

	t.Cleanup(func() {
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
		model.DB = originalDB
		common.KiteEncryptKey = originalEncryptKey
		common.JwtSecret = originalJWTSecret
	})
	return user
}

// performUserRequest 构造一次 application/json 请求并同步执行，
// 返回录制的响应，方便断言状态码与响应体。
func performUserRequest(router *gin.Engine, method string, path string, body string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	return recorder
}

// currentTOTPCode 按 RFC 6238（SHA-1、30 秒步长、6 位数字）在本地算出当前动态码，
// 使测试无需依赖真实认证器 App。
func currentTOTPCode(t *testing.T, secret string) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		t.Fatalf("decoding TOTP secret: %v", err)
	}
	var message [8]byte
	binary.BigEndian.PutUint64(message[:], uint64(time.Now().Unix()/30))
	hash := hmac.New(sha1.New, key)
	_, _ = hash.Write(message[:])
	sum := hash.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1000000)
}
