package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/auth"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/helm"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/version"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 审计记录不可删除、审核员查询可追溯（等保三级安全审计）：审计相关接口必须全部是
// GET。这条守卫测试看的是真实路由表，任何给它加上写方法的改动都会在这里失败。
func TestAuditRoutesAreReadOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	// 只登记路由，不需要可用的集群管理器：方法值不会解引用接收者。
	registerAdminRoutes(&r.RouterGroup, auth.NewAuthHandler(), new(cluster.ClusterManager), helm.NewHelmChartHandler())

	expected := map[string]bool{
		"/api/v1/admin/audit-logs":           false,
		"/api/v1/admin/login-logs":           false,
		"/api/v1/admin/password-change-logs": false,
	}
	for _, route := range r.Routes() {
		matched := ""
		for path := range expected {
			// 前缀匹配：子路由（例如 /audit-logs/:id）也一并把关。
			if route.Path == path || strings.HasPrefix(route.Path, path+"/") {
				matched = path
				break
			}
		}
		if matched == "" {
			continue
		}
		expected[matched] = true
		if route.Method != http.MethodGet && route.Method != http.MethodHead {
			t.Fatalf("%s %s: audit endpoints must stay read-only", route.Method, route.Path)
		}
	}
	for path, found := range expected {
		if !found {
			t.Fatalf("no audit endpoint registered at %s; update this guard", path)
		}
	}
}

func TestRegisterBaseRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)

	oldVersion := version.Version
	oldBuildDate := version.BuildDate
	oldCommitID := version.CommitID
	oldEnableVersionCheck := common.EnableVersionCheck.Load()
	defer func() {
		version.Version = oldVersion
		version.BuildDate = oldBuildDate
		version.CommitID = oldCommitID
		common.EnableVersionCheck.Store(oldEnableVersionCheck)
	}()

	version.Version = "v1.2.3"
	version.BuildDate = "2026-03-27"
	version.CommitID = "abc123"
	common.EnableVersionCheck.Store(false)

	r := gin.New()
	registerBaseRoutes(&r.RouterGroup)

	t.Run("healthz", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		if got := strings.TrimSpace(rec.Body.String()); got != `{"status":"ok"}` {
			t.Fatalf("body = %q, want %q", got, `{"status":"ok"}`)
		}
	})

	t.Run("version", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/version", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}

		var got map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("json.Unmarshal() error = %v", err)
		}
		if got["version"] != "v1.2.3" || got["buildDate"] != "2026-03-27" || got["commitId"] != "abc123" {
			t.Fatalf("unexpected version payload: %#v", got)
		}
	})
}

func TestConfigureTrustedProxiesIgnoresForwardedForFromUntrustedPeerByDefault(t *testing.T) {
	if got := clientIPForForwardedRequest(t, nil, "198.51.100.10:12345", "127.0.0.1"); got == "127.0.0.1" {
		t.Fatalf("ClientIP() trusted X-Forwarded-For from untrusted peer: got %q", got)
	}
}

func TestConfigureTrustedProxiesUsesForwardedForFromDefaultPrivateProxy(t *testing.T) {
	if got := clientIPForForwardedRequest(t, nil, "192.168.1.10:12345", "203.0.113.9"); got != "203.0.113.9" {
		t.Fatalf("ClientIP() = %q, want forwarded client IP from default private proxy", got)
	}
}

func TestConfigureTrustedProxiesUsesForwardedForFromTrustedProxy(t *testing.T) {
	if got := clientIPForForwardedRequest(t, []string{"192.0.2.0/24"}, "192.0.2.10:12345", "203.0.113.9"); got != "203.0.113.9" {
		t.Fatalf("ClientIP() = %q, want forwarded client IP", got)
	}
}

func clientIPForForwardedRequest(t *testing.T, trustedProxies []string, remoteAddr, forwardedFor string) string {
	t.Helper()

	gin.SetMode(gin.TestMode)

	oldTrustedProxies := common.TrustedProxies
	t.Cleanup(func() {
		common.TrustedProxies = oldTrustedProxies
	})
	if trustedProxies != nil {
		common.TrustedProxies = trustedProxies
	}

	r := gin.New()
	configureTrustedProxies(r)
	r.GET("/client-ip", func(c *gin.Context) {
		c.String(http.StatusOK, c.ClientIP())
	})

	req := httptest.NewRequest(http.MethodGet, "/client-ip", nil)
	req.RemoteAddr = remoteAddr
	req.Header.Set("X-Forwarded-For", forwardedFor)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	return strings.TrimSpace(rec.Body.String())
}

func TestSetupStatic(t *testing.T) {
	gin.SetMode(gin.TestMode)

	oldBase := common.Base
	oldEnableAnalytics := common.EnableAnalytics.Load()
	defer func() {
		common.Base = oldBase
		common.EnableAnalytics.Store(oldEnableAnalytics)
	}()

	common.Base = "/kite"
	common.EnableAnalytics.Store(true)

	r := gin.New()
	setupStatic(r)

	t.Run("redirects root to base", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusFound {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusFound)
		}
		if location := rec.Header().Get("Location"); location != "/kite/" {
			t.Fatalf("Location = %q, want %q", location, "/kite/")
		}
	})

	t.Run("serves index for ui routes with base and analytics injected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/kite/overview", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		body := rec.Body.String()
		if !strings.Contains(body, `<script src="/kite/config.js"></script>`) {
			t.Fatalf("body missing external dynamic base script")
		}
		if strings.Contains(body, "window.__dynamic_base__") {
			t.Fatalf("inline dynamic base script must not be served (blocked by CSP)")
		}
		if !strings.Contains(body, "cloud.umami.is/script.js") {
			t.Fatalf("body missing analytics injection")
		}
	})

	t.Run("serves config.js with the runtime base", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/kite/config.js", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		if got := rec.Body.String(); got != `window.__dynamic_base__="/kite";` {
			t.Fatalf("config.js body = %q", got)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/javascript") {
			t.Fatalf("Content-Type = %q, want application/javascript", ct)
		}
	})

	t.Run("returns api 404 for missing api route", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/kite/api/missing", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
		}
		if got := strings.TrimSpace(rec.Body.String()); got != `{"error":"API endpoint not found"}` {
			t.Fatalf("body = %q, want %q", got, `{"error":"API endpoint not found"}`)
		}
	})
}

// 从内置密钥切到 KITE_ENCRYPT_KEY 的首次启动必须能直接起来：存库的 jwt_secret 要先
// 由密钥迁移重写、再被重新读回来，否则 initializeApp 的哨兵检查会 Fatalf
// （表现为切换密钥后必须重启一次）。
func TestLoadGeneralSettingReadsStoredJWTSecretAfterKeyMigration(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&model.GeneralSetting{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}

	originalDB := model.DB
	originalKey := common.KiteEncryptKey
	originalSecret := common.JwtSecret
	originalAnalytics := common.EnableAnalytics.Load()
	originalVersionCheck := common.EnableVersionCheck.Load()
	model.DB = db
	t.Cleanup(func() {
		model.DB = originalDB
		common.KiteEncryptKey = originalKey
		common.JwtSecret = originalSecret
		common.EnableAnalytics.Store(originalAnalytics)
		common.EnableVersionCheck.Store(originalVersionCheck)
	})

	// 内置密钥生效期间落库：此时生成并存储了随机会话密钥。
	common.KiteEncryptKey = common.DefaultKiteEncryptKey
	common.JwtSecret = common.DefaultJWTSecret
	if _, err := model.GetGeneralSetting(); err != nil {
		t.Fatalf("seeding general setting: %v", err)
	}
	stored := common.JwtSecret
	if stored == "" || stored == common.DefaultJWTSecret {
		t.Fatalf("expected a stored JWT secret, got %q", stored)
	}

	// 运维配置了 KITE_ENCRYPT_KEY 后重启：新进程里会话密钥回到哨兵值。
	common.KiteEncryptKey = "production-key-0123456789"
	common.JwtSecret = common.DefaultJWTSecret

	loadGeneralSettingAfterKeyMigration()

	if common.JwtSecret != stored {
		t.Fatalf("JwtSecret = %q, want the stored secret %q", common.JwtSecret, stored)
	}
}
