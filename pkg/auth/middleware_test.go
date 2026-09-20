package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

// 强制绑定只对能自助绑定的账号生效。
//
// OIDC 账号在 Kite 里既没有可校验的口令，也没有绑定入口，一旦被 mfa_setup_required
// 拦下就只能卡在绑定向导里（改前策略设「所有用户」会锁死全部 OIDC 账号）。
func TestBlockForMFAEnrollmentSkipsAccountsThatCannotSelfEnroll(t *testing.T) {
	user := setupAuthDBWithSecuritySetting(t)

	data := model.DefaultSecuritySettingData()
	data.MFAPolicy = model.MFAPolicyAll
	if _, err := model.UpdateSecuritySetting(data); err != nil {
		t.Fatalf("setting MFA policy: %v", err)
	}

	cases := []struct {
		name        string
		provider    string
		wantBlocked bool
	}{
		{"本地密码账号仍需绑定", model.AuthProviderPassword, true},
		{"LDAP 账号仍需绑定", model.AuthProviderLDAP, true},
		{"OIDC 账号不被拦截", "mockidp", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target := model.User{
				Model:    model.Model{ID: user.ID},
				Provider: tc.provider,
			}
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/api/v1/clusters", nil)

			blocked := blockForMFAEnrollment(ctx, &target)
			if blocked != tc.wantBlocked {
				t.Fatalf("blockForMFAEnrollment(%s) = %v, want %v (status %d, body %s)",
					tc.name, blocked, tc.wantBlocked, recorder.Code, recorder.Body.String())
			}
			if !tc.wantBlocked && recorder.Body.Len() != 0 {
				t.Fatalf("not-blocked request still got a body: %s", recorder.Body.String())
			}
		})
	}
}
