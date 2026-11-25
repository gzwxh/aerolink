package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/gzwxh/aerolink/pkg/model"
)

// sessionDeniedReason 是 bootstrap 与 RequireAuth 共用的「会话是否可用」口径。
//
// 这组用例锁住「已失效的会话必须被拒」：一旦 bootstrap 侧又变得比业务接口宽松，
// 前端就会出现首页与登录页互相整页跳转、无限刷新（bootstrap 认为已登录、
// 业务接口全部 401，每轮一次整页加载）。
func TestSessionDeniedReason(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// 判定里会读「仅从指定来源登录」的安全设置，需要先初始化测试库。
	setupAuthDBWithSecuritySetting(t)

	// 会话注册表是进程级全局状态，用一个大 ID 避免与其它测试互相污染。
	const userID = 987654321

	now := time.Now()
	expiredAt := now.Add(-time.Hour)
	passwordUpdatedAt := now.Add(-time.Minute)

	newContext := func() *gin.Context {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
		c.Request.RemoteAddr = "127.0.0.1:12345"
		return c
	}
	newUser := func() *model.User {
		return &model.User{Model: model.Model{ID: userID}, Enabled: true}
	}
	newClaims := func(issuedAt time.Time) *Claims {
		return &Claims{
			UserID:     userID,
			SessionSeq: 1,
			RegisteredClaims: jwt.RegisteredClaims{
				IssuedAt: jwt.NewNumericDate(issuedAt),
			},
		}
	}

	t.Run("禁用账号被拒", func(t *testing.T) {
		user := newUser()
		user.Enabled = false
		if got := sessionDeniedReason(newContext(), user, newClaims(now)); got == "" {
			t.Error("禁用账号必须被拒")
		}
	})

	t.Run("过期账号被拒", func(t *testing.T) {
		user := newUser()
		user.ExpiresAt = &expiredAt
		if got := sessionDeniedReason(newContext(), user, newClaims(now)); got != "user_expired" {
			t.Errorf("got %q, want user_expired", got)
		}
	})

	// 清库重建/改密之后，浏览器里的旧 cookie 正好是这一类：JWT 本身没过期，
	// 但签发时间早于密码更新时间，业务接口一律 401。
	t.Run("改密前签发的令牌被拒", func(t *testing.T) {
		user := newUser()
		user.PasswordUpdatedAt = &passwordUpdatedAt
		if got := sessionDeniedReason(newContext(), user, newClaims(now.Add(-time.Hour))); got != "password_changed" {
			t.Errorf("got %q, want password_changed", got)
		}
	})

	t.Run("有效会话放行", func(t *testing.T) {
		user := newUser()
		user.PasswordUpdatedAt = &passwordUpdatedAt
		if got := sessionDeniedReason(newContext(), user, newClaims(now)); got != "" {
			t.Errorf("有效会话不该被拒，got %q", got)
		}
	})
}
