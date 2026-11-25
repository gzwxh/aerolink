package auth

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/model"
)

// 侧边栏布局的优先级：个人布局 > 管理员发布的全局布局 > 前端内置默认。
// 全局布局只是「还没自己配置过的账号」的初始值，不构成对个人配置的覆盖。
func TestApplyBootstrapSidebarPreferencePriority(t *testing.T) {
	global := `{"sections":["workloads"]}`
	personal := `{"sections":["custom"]}`

	user := func(preference string) *model.User {
		return &model.User{SidebarPreference: preference}
	}
	setting := func(preference string) *model.GeneralSetting {
		return &model.GeneralSetting{GlobalSidebarPreference: preference}
	}

	tests := []struct {
		name       string
		user       *model.User
		setting    *model.GeneralSetting
		want       string
		wantDetail string
	}{
		{
			name:       "personal preference wins over the global one",
			user:       user(personal),
			setting:    setting(global),
			want:       personal,
			wantDetail: "a user with a personal layout must keep it",
		},
		{
			name:       "global becomes the default for users without one",
			user:       user(""),
			setting:    setting(global),
			want:       global,
			wantDetail: "a user without a personal layout falls back to the global layout",
		},
		{
			name:       "whitespace-only personal preference still falls back",
			user:       user("   "),
			setting:    setting(global),
			want:       global,
			wantDetail: "a blank personal layout must not shadow the global layout",
		},
		{
			name:       "nothing configured leaves it empty for the built-in default",
			user:       user(""),
			setting:    setting(""),
			want:       "",
			wantDetail: "with neither personal nor global layout the client uses its built-in default",
		},
		{
			name:       "nil user is tolerated",
			user:       nil,
			setting:    setting(global),
			want:       "",
			wantDetail: "a nil user must not panic",
		},
		{
			name:       "nil setting is tolerated",
			user:       user(""),
			setting:    nil,
			want:       "",
			wantDetail: "a nil setting must not panic",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			applyBootstrapSidebarPreference(tt.user, tt.setting)
			if tt.user == nil {
				return
			}
			if tt.user.SidebarPreference != tt.want {
				t.Fatalf("SidebarPreference = %q, want %q: %s", tt.user.SidebarPreference, tt.want, tt.wantDetail)
			}
		})
	}
}

// 同一条口径也要在 /api/auth/user 的响应上成立：前端就是拿这份数据渲染侧边栏的。
func TestGetUserSidebarPreferencePriority(t *testing.T) {
	user := setupAuthIntegrationDB(t)
	if _, err := model.UpdateGeneralSetting(map[string]interface{}{
		"global_sidebar_preference": `{"sections":["workloads"]}`,
	}); err != nil {
		t.Fatalf("setting global sidebar preference: %v", err)
	}

	handler := &AuthHandler{}
	router := gin.New()
	// 每次请求都像鉴权中间件那样从库里取一次当前用户，
	// 否则保存个人布局后 context 里还是旧对象，测不到真实行为。
	router.GET("/api/auth/user", func(c *gin.Context) {
		current, err := model.GetUserByIDCached(uint64(user.ID))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.Set("user", *current)
		handler.GetUser(c)
	})

	type getUserResponse struct {
		User struct {
			SidebarPreference string `json:"sidebar_preference"`
		} `json:"user"`
		GlobalSidebarPreference string `json:"globalSidebarPreference"`
	}

	load := func(t *testing.T) getUserResponse {
		t.Helper()
		response := performAuthRequest(router, http.MethodGet, "/api/auth/user", "", nil)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
		}
		var parsed getUserResponse
		if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
			t.Fatalf("decoding response: %v", err)
		}
		return parsed
	}

	// 还没配过自己的布局：下发全局布局。
	inherited := load(t)
	if inherited.User.SidebarPreference != `{"sections":["workloads"]}` {
		t.Fatalf("inherited sidebar preference = %q", inherited.User.SidebarPreference)
	}
	if strings.TrimSpace(inherited.GlobalSidebarPreference) == "" {
		t.Fatal("the published global sidebar preference must still be reported")
	}

	// 保存了个人布局之后：全局布局仍然发布着，但用户看到的是自己的那份。
	stored, err := model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading the user: %v", err)
	}
	stored.SidebarPreference = `{"sections":["custom"]}`
	if err := model.UpdateUser(stored); err != nil {
		t.Fatalf("saving the personal sidebar preference: %v", err)
	}
	customized := load(t)
	if customized.User.SidebarPreference != `{"sections":["custom"]}` {
		t.Fatalf("personal sidebar preference = %q, want it to survive a published global layout", customized.User.SidebarPreference)
	}
}
