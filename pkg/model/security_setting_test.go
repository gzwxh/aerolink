package model

import (
	"testing"

	"github.com/zxh326/kite/pkg/common"
)

func mfaTestUser(provider string, admin bool) *User {
	user := &User{Provider: provider}
	if admin {
		user.Roles = []common.Role{{Name: DefaultAdminRole.Name}}
	}
	return user
}

// 「谁必须绑定 MFA」只对能自助绑定的账号生效。
//
// 绑定必须由本人在登录后完成，而绑定向导需要一次再认证：本地密码账号提交当前密码，
// LDAP 账号要求在窗口内重新登录过。OIDC / 第三方身份源两样都没有，把它们算进强制
// 绑定范围会让账号卡在一个无法完成的向导上（后端还会用 mfa_setup_required 拦掉其它 API）。
// 匿名伪用户同理：它没有账号也没有口令，一旦被要求绑定就整片拦死匿名访问。
func TestMFARequiredForSkipsAccountsThatCannotSelfEnrollMFA(t *testing.T) {
	all := DefaultSecuritySettingData()
	all.MFAPolicy = MFAPolicyAll
	onlyAdmin := DefaultSecuritySettingData()
	onlyAdmin.MFAPolicy = MFAPolicyAdmin

	cases := []struct {
		name    string
		setting SecuritySettingData
		user    *User
		want    bool
	}{
		{"策略所有用户 + 历史遗留的本地密码账号（provider 为空）", all, mfaTestUser("", false), true},
		{"策略所有用户 + 本地密码账号", all, mfaTestUser(AuthProviderPassword, false), true},
		{"策略所有用户 + LDAP 账号", all, mfaTestUser(AuthProviderLDAP, false), true},
		{"策略所有用户 + OIDC 账号", all, mfaTestUser("oidc", false), false},
		{"策略所有用户 + 第三方 OAuth 账号", all, mfaTestUser("mockidp", false), false},
		{"策略所有用户 + 匿名伪用户", all, mfaTestUser("Anonymous", false), false},
		{"策略仅管理员 + 密码管理员", onlyAdmin, mfaTestUser(AuthProviderPassword, true), true},
		{"策略仅管理员 + OIDC 管理员", onlyAdmin, mfaTestUser("oidc", true), false},
		{"策略所有用户 + 账号显式关闭 MFA 强制", all, &User{Provider: AuthProviderPassword, MFADisabled: true}, false},
		{"策略未启用 + 密码账号", DefaultSecuritySettingData(), mfaTestUser(AuthProviderPassword, false), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.setting.MFARequiredFor(tc.user); got != tc.want {
				t.Fatalf("MFARequiredFor(%s) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

// 「LDAP 管理员强制绑定动态码」属于「谁必须绑定」：开启时未绑定的 LDAP 管理员会被
// 引导去绑定。它不能体现在登录环节——那时管理员还没有密钥，任何动态码都验不过，
// 只会让该账号彻底无法登录（见 pkg/auth/mfa_login_test.go 的挑战条件用例）。
func TestMFAThirdPartyForcesEnrollmentForLDAPAdmins(t *testing.T) {
	forced := DefaultSecuritySettingData()
	forced.MFAPolicy = MFAPolicyDisabled
	forced.MFAThirdPartyEnabled = true
	notForced := DefaultSecuritySettingData()
	notForced.MFAPolicy = MFAPolicyDisabled
	notForced.MFAThirdPartyEnabled = false

	cases := []struct {
		name    string
		setting SecuritySettingData
		user    *User
		want    bool
	}{
		{"开关开 + LDAP 管理员（策略未启用）", forced, mfaTestUser(AuthProviderLDAP, true), true},
		{"开关开 + LDAP 普通用户", forced, mfaTestUser(AuthProviderLDAP, false), false},
		{"开关开 + 密码管理员（只管 LDAP）", forced, mfaTestUser(AuthProviderPassword, true), false},
		{"开关开 + OIDC 管理员（不能自助绑定）", forced, mfaTestUser("oidc", true), false},
		{"开关关 + LDAP 管理员（策略未启用）", notForced, mfaTestUser(AuthProviderLDAP, true), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.setting.MFARequiredFor(tc.user); got != tc.want {
				t.Fatalf("MFARequiredFor(%s) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}
