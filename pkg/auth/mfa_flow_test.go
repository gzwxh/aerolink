package auth

// 临时集成复现：跑完删除。复刻用户操作链路，定位绑定成功后仍被
// mfa_setup_required 拦截的问题。

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"aerolink/pkg/model"
	"aerolink/pkg/rbac"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"

	"aerolink/pkg/users"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupMFAFlow(t *testing.T) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	// ":memory:" 每条连接都是独立的库，而 rbac.InitRBAC 起的后台同步 goroutine 会并发
	// 访问全局 model.DB，池里一开第二条连接就会读到空库（no such table）。限制成单连接。
	if sqlDB, dbErr := db.DB(); dbErr == nil {
		sqlDB.SetMaxOpenConns(1)
	}
	for _, m := range []any{
		model.User{}, model.Role{}, model.RoleAssignment{},
		model.GeneralSetting{}, model.SecuritySetting{},
		model.PasswordHistory{}, model.PasswordChangeLog{},
		model.NotificationSetting{}, model.NotificationTemplate{}, model.Notification{},
	} {
		if err := db.AutoMigrate(m); err != nil {
			t.Fatalf("migrate %T: %v", m, err)
		}
	}
	old := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = old })

	if err := model.DB.Where("name = ?", model.DefaultAdminRole.Name).
		FirstOrCreate(&model.DefaultAdminRole).Error; err != nil {
		t.Fatalf("seed admin role: %v", err)
	}
	rbac.InitRBAC()

	engine := gin.New()
	h := NewAuthHandler()
	engine.POST("/api/auth/setup/create_super_user", h.CreateSuperUser)
	engine.POST("/api/auth/login/password", h.PasswordLogin)
	engine.GET("/api/v1/clusters", h.RequireAuth(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"items": []string{}})
	})
	engine.POST("/api/users/me/mfa/setup",
		h.RequireAuth(), users.SetupCurrentUserMFA)
	engine.POST("/api/users/me/mfa/enable",
		h.RequireAuth(), users.EnableCurrentUserMFA)

	server := httptest.NewServer(engine)
	t.Cleanup(server.Close)
	return server
}

func doMFAJSON(
	t *testing.T, server *httptest.Server, jar *cookiejar.Jar,
	method, path string, body any,
) (int, map[string]any) {
	t.Helper()
	var reader *strings.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		reader = strings.NewReader(string(raw))
	} else {
		reader = strings.NewReader("")
	}
	req, _ := http.NewRequest(method, server.URL+path, reader)
	req.Header.Set("Content-Type", "application/json")
	if jar != nil {
		for _, c := range jar.Cookies(req.URL) {
			req.AddCookie(c)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if jar != nil {
		for _, c := range resp.Cookies() {
			jar.SetCookies(req.URL, []*http.Cookie{c})
		}
	}
	defer func() { _ = resp.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func decodeBase32NoPad(s string) []byte {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	s = strings.ToUpper(strings.TrimRight(strings.TrimSpace(s), "="))
	var bits uint32
	var nbits uint
	var out []byte
	for _, r := range s {
		idx := strings.IndexRune(alphabet, r)
		if idx < 0 {
			return nil
		}
		bits = bits<<5 | uint32(idx)
		nbits += 5
		if nbits >= 8 {
			nbits -= 8
			out = append(out, byte(bits>>nbits))
		}
	}
	return out
}

func totpNow(secret string) string {
	key := decodeBase32NoPad(secret)
	if key == nil {
		return ""
	}
	counter := uint64(time.Now().Unix() / 30)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1000000)
}

func TestVerifyMFAEnrollmentFlow(t *testing.T) {
	server := setupMFAFlow(t)
	jar, _ := cookiejar.New(nil)

	code, createBody := doMFAJSON(t, server, nil, http.MethodPost,
		"/api/auth/setup/create_super_user",
		map[string]string{"username": "admin", "password": "Admin@12345678"})
	if code != http.StatusCreated {
		t.Fatalf("create super user = %d: %v", code, createBody)
	}

	code, _ = doMFAJSON(t, server, jar, http.MethodPost,
		"/api/auth/login/password",
		map[string]string{"username": "admin", "password": "Admin@12345678"})
	if code != http.StatusNoContent {
		t.Fatalf("login = %d", code)
	}

	// 管理员开启全局 MFA 策略（所有用户）——直接走 model 层，避免
	// 测试导入环（settings 包引用 auth）。
	data := model.DefaultSecuritySettingData()
	data.MFAPolicy = model.MFAPolicyAll
	if _, err := model.UpdateSecuritySetting(data); err != nil {
		t.Fatalf("set policy: %v", err)
	}

	// 此时访问 clusters 应被 mfa_setup_required 拦截
	code, body := doMFAJSON(t, server, jar, http.MethodGet, "/api/v1/clusters", nil)
	if code != http.StatusForbidden {
		t.Fatalf("clusters before enrollment = %d, want 403", code)
	}
	if body["error"] != "mfa_setup_required" {
		t.Fatalf("error = %v", body["error"])
	}

	// 绑定第一步：验证当前密码，获取二维码/密钥
	code, body = doMFAJSON(t, server, jar, http.MethodPost,
		"/api/users/me/mfa/setup", map[string]string{
			"current_password": "Admin@12345678",
		})
	if code != http.StatusOK {
		t.Fatalf("mfa setup = %d: %v", code, body["error"])
	}
	secret, _ := body["secret"].(string)
	if secret == "" {
		t.Fatalf("setup response missing secret: %v", body)
	}

	// 绑定第二步：提交动态码启用
	code, body = doMFAJSON(t, server, jar, http.MethodPost,
		"/api/users/me/mfa/enable", map[string]string{
			"code": totpNow(secret),
		})
	if code != http.StatusOK {
		t.Fatalf("mfa enable = %d: %v", code, body["error"])
	}

	// 绑定成功后再访问 clusters：不应再被拦截
	code, body = doMFAJSON(t, server, jar, http.MethodGet, "/api/v1/clusters", nil)
	if code != http.StatusOK {
		t.Fatalf("clusters after enrollment = %d: %v (BUG: user is still blocked)",
			code, body["error"])
	}
}
