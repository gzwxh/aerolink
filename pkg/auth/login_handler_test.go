package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
)

func TestCredentialLoginLimiterBlocksLoopbackClientIP(t *testing.T) {
	setupAuthIntegrationDB(t)
	limiter := &credentialLoginAttemptLimiter{}
	limits := loginLimits{
		ipFailLimit:   3,
		ipBlock:       time.Minute,
		userFailLimit: 5,
		userBlock:     time.Minute,
	}

	clientIP := "127.0.0.1"
	username := "alice"
	// 达到配置阈值的那次尝试就是触发封锁的那次。
	for i := 1; i < limits.ipFailLimit; i++ {
		if limiter.recordFailure(clientIP, username, limits) {
			t.Fatalf("recordFailure() blocked after %d failures, want not blocked yet", i)
		}
	}
	if !limiter.recordFailure(clientIP, username, limits) {
		t.Fatalf("recordFailure() did not block loopback client IP")
	}
	if !limiter.blocked(clientIP, username, limits) {
		t.Fatalf("blocked() = false, want true for loopback client IP")
	}

	// 白名单中的 IP 不受失败尝试锁定影响。
	exempt := loginLimits{
		ipFailLimit: 1,
		ipBlock:     time.Minute,
		ipWhitelist: []string{"127.0.0.0/8"},
	}
	if limiter.recordFailure(clientIP, username, exempt) {
		t.Fatalf("recordFailure() blocked a whitelisted client IP")
	}
}

func TestSetCookieSecure(t *testing.T) {
	originalHost := common.Host
	t.Cleanup(func() {
		common.Host = originalHost
	})

	t.Run("secure when host is https", func(t *testing.T) {
		common.Host = "https://aerolink.example.com"
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest(http.MethodGet, "http://aerolink.local", nil)

		setCookieSecure(c, "auth_token", "value", 600)

		cookie := rec.Result().Cookies()[0]
		if !cookie.Secure {
			t.Fatalf("cookie.Secure = false, want true")
		}
		if !cookie.HttpOnly {
			t.Fatalf("cookie.HttpOnly = false, want true")
		}
		if cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("cookie.SameSite = %v, want %v", cookie.SameSite, http.SameSiteLaxMode)
		}
		if got := rec.Header().Get("Set-Cookie"); !strings.Contains(got, "SameSite=Lax") {
			t.Fatalf("Set-Cookie header = %q, want SameSite=Lax", got)
		}
	})

	t.Run("secure when forwarded proto is https", func(t *testing.T) {
		common.Host = ""
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		req := httptest.NewRequest(http.MethodGet, "http://aerolink.local", nil)
		req.Header.Set("X-Forwarded-Proto", "https")
		c.Request = req

		setCookieSecure(c, "auth_token", "value", 600)

		if !rec.Result().Cookies()[0].Secure {
			t.Fatalf("cookie.Secure = false, want true")
		}
	})

	t.Run("not secure on plain http", func(t *testing.T) {
		common.Host = ""
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest(http.MethodGet, "http://aerolink.local", nil)

		setCookieSecure(c, "auth_token", "value", 600)

		if rec.Result().Cookies()[0].Secure {
			t.Fatalf("cookie.Secure = true, want false")
		}
	})
}
