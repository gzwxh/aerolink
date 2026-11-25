package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/model"
)

// setupAuthDBWithSecuritySetting 在共享测试库上补出 security_settings 表。
//
// 不在 setupAuthIntegrationDB 里加这张表：那个 helper 此前没有迁移它，于是
// GetSecuritySetting() 在那些用例里恒返回错误，登录路径会跳过全部安全策略分支。
// 把表补进去会改变既有用例的行为（例如 MFA 挑战），所以只在本文件里按需迁移。
func setupAuthDBWithSecuritySetting(t *testing.T) *model.User {
	t.Helper()
	user := setupAuthIntegrationDB(t)
	if err := model.DB.AutoMigrate(&model.SecuritySetting{}); err != nil {
		t.Fatalf("migrating security_settings: %v", err)
	}
	return user
}

func enableLoginSourceAllowlist(t *testing.T, entries ...string) {
	t.Helper()
	data := model.DefaultSecuritySettingData()
	data.LoginSourceEnforced = true
	data.LoginSourceAllowlist = entries
	if _, err := model.UpdateSecuritySetting(data); err != nil {
		t.Fatalf("enabling the login source allowlist: %v", err)
	}
}

// performAuthRequestFrom 与 performAuthRequest 相同，但可以指定来源地址。
func performAuthRequestFrom(router *gin.Engine, method, path, body, remoteAddr string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.RemoteAddr = remoteAddr
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	router.ServeHTTP(recorder, request)
	return recorder
}

// 「仅从指定来源登录」的判定口径：未启用或列表为空不限制；支持 CIDR、区间与单地址。
func TestLoginSourceAllowed(t *testing.T) {
	setupAuthDBWithSecuritySetting(t)

	allow := func(entries ...string) {
		t.Helper()
		data := model.DefaultSecuritySettingData()
		data.LoginSourceAllowlist = entries
		data.LoginSourceEnforced = len(entries) > 0
		if _, err := model.UpdateSecuritySetting(data); err != nil {
			t.Fatalf("updating security setting: %v", err)
		}
	}

	allow()
	if !loginSourceAllowed("203.0.113.9") {
		t.Error("an empty allowlist must not restrict anything")
	}

	allow("10.0.0.0/8", "192.168.1.1", "203.0.113.10-203.0.113.20")
	for _, ip := range []string{"10.1.2.3", "192.168.1.1", "203.0.113.15"} {
		if !loginSourceAllowed(ip) {
			t.Errorf("loginSourceAllowed(%q) = false, want true", ip)
		}
	}
	for _, ip := range []string{"11.1.2.3", "192.168.1.2", "203.0.113.21"} {
		if loginSourceAllowed(ip) {
			t.Errorf("loginSourceAllowed(%q) = true, want false", ip)
		}
	}
}

// 未在允许列表内的来源：登录被拒（并记录失败原因），已登录的会话也不再放行——
// 否则在允许网段建立的会话可以被带到任意网络继续使用。
func TestLoginSourceAllowlistBlocksLoginAndExistingSession(t *testing.T) {
	setupAuthDBWithSecuritySetting(t)
	enableLoginSourceAllowlist(t, "10.0.0.0/8")

	handler := NewAuthHandler()
	router := gin.New()
	router.POST("/login", handler.PasswordLogin)
	router.GET("/protected", handler.RequireAuth(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	outside := performAuthRequestFrom(router, http.MethodPost, "/login",
		`{"username":"alice","password":"correct-password"}`, "192.0.2.25:12345")
	if outside.Code != http.StatusForbidden || !strings.Contains(outside.Body.String(), loginSourceDeniedCode) {
		t.Fatalf("login from a disallowed source = %d/%s, want 403 with %s",
			outside.Code, outside.Body.String(), loginSourceDeniedCode)
	}

	inside := performAuthRequestFrom(router, http.MethodPost, "/login",
		`{"username":"alice","password":"correct-password"}`, "10.1.2.3:12345")
	if inside.Code != http.StatusNoContent {
		t.Fatalf("login from an allowed source = %d/%s, want 204", inside.Code, inside.Body.String())
	}
	var authCookie *http.Cookie
	for _, cookie := range inside.Result().Cookies() {
		if cookie.Name == "auth_token" {
			authCookie = cookie
			break
		}
	}
	if authCookie == nil {
		t.Fatal("login from an allowed source issued no auth cookie")
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/protected", nil)
	request.RemoteAddr = "192.0.2.25:12345"
	request.AddCookie(authCookie)
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized || !strings.Contains(recorder.Body.String(), loginSourceDeniedCode) {
		t.Fatalf("session used from a disallowed source = %d/%s, want 401 with %s",
			recorder.Code, recorder.Body.String(), loginSourceDeniedCode)
	}
}

// 「启用 + 空列表」看起来开着的、实际什么都不拦，必须拒绝保存。
func TestUpdateSecuritySettingRejectsEnforcementWithoutAllowlist(t *testing.T) {
	setupAuthDBWithSecuritySetting(t)

	data := model.DefaultSecuritySettingData()
	data.LoginSourceEnforced = true
	data.LoginSourceAllowlist = nil
	if _, err := model.UpdateSecuritySetting(data); err == nil {
		t.Fatal("saving enforcement without any allowed address should fail")
	}
}
