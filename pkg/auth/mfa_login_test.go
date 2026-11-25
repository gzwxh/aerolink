package auth

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/mfa"
	"github.com/gzwxh/aerolink/pkg/model"
)

// rfc6238TestSecret 是 RFC 6238 附录 B 用的密钥（ASCII "12345678901234567890" 的 base32）。
const rfc6238TestSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func totpCode(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(secret))
	if err != nil {
		t.Fatalf("decoding TOTP secret: %v", err)
	}
	message := make([]byte, 8)
	binary.BigEndian.PutUint64(message, uint64(at.Unix()/30))
	mac := hmac.New(sha1.New, key)
	mac.Write(message)
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := int64(binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff)
	return fmt.Sprintf("%06d", value%1000000)
}

// 用 RFC 6238 附录 B 的向量自检生成器本身，避免它算错却让下面的用例通过。
func TestTOTPHelperMatchesRFC6238Vector(t *testing.T) {
	if got := totpCode(t, rfc6238TestSecret, time.Unix(59, 0)); got != "287082" {
		t.Fatalf("totpCode() = %q, want 287082 (RFC 6238 vector)", got)
	}
}

// 挑战条件的口径：策略只管「谁必须绑定」（见 model.SecuritySettingData.MFARequiredFor），
// 绑定之后一律要验码；LDAP 与密码一样是表单登录，因此同样适用；
// 重定向类（OIDC）不在这里挑战，由回调发票据、登录页补验。
//
// 未绑定的账号在这里一律不挑战：动态码密钥为空，任何码都验不过，挑战等于把人锁在门外。
// 「LDAP 管理员强制绑定」因此改挂在 MFARequiredFor 上，由绑定向导完成
// （见 pkg/model/security_setting_test.go 的同名判定）。
func TestMFAChallengeRequiredForCredentialLogin(t *testing.T) {
	bind := func(enabled bool) *model.User { return &model.User{MFAEnabled: enabled} }
	unboundLDAPAdmin := &model.User{
		// GetUserRoles 直接返回 user.Roles；admin 是内置角色名。
		Roles: []common.Role{{Name: model.DefaultAdminRole.Name}},
	}

	cases := []struct {
		name     string
		provider string
		user     *model.User
		want     bool
	}{
		{"密码 + 已绑定", model.AuthProviderPassword, bind(true), true},
		{"密码 + 未绑定", model.AuthProviderPassword, bind(false), false},
		{"LDAP 普通用户 + 已绑定", model.AuthProviderLDAP, bind(true), true},
		{"LDAP 普通用户 + 未绑定", model.AuthProviderLDAP, bind(false), false},
		{"LDAP 管理员 + 未绑定", model.AuthProviderLDAP, unboundLDAPAdmin, false},
		{"对端身份源（OIDC）+ 已绑定", "mockidp", bind(true), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := mfaChallengeRequiredFor(tc.provider, tc.user); got != tc.want {
				t.Fatalf("mfaChallengeRequiredFor(%s) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

// setupBoundMFAUser 用给定策略建库，并给 alice 绑定动态码。
func setupBoundMFAUser(t *testing.T, policy string) {
	t.Helper()
	user := setupAuthDBWithSecuritySetting(t)

	data := model.DefaultSecuritySettingData()
	data.MFAPolicy = policy
	if _, err := model.UpdateSecuritySetting(data); err != nil {
		t.Fatalf("setting MFA policy: %v", err)
	}
	if err := model.StoreMFASecret(user.ID, rfc6238TestSecret); err != nil {
		t.Fatalf("storing MFA secret: %v", err)
	}
	if err := model.EnableUserMFA(user.ID); err != nil {
		t.Fatalf("enabling MFA: %v", err)
	}
	model.InvalidateUserCache(uint64(user.ID))
}

// 全局策略只决定「谁必须绑定 MFA」，不是「绑定之后是否使用」：
// 策略为 disabled（默认值）时，已绑定动态码的账号登录也必须验码。
// 此前这里会整体跳过挑战，于是只掌握口令的一方可以拿到一个完整会话。
func TestPasswordLoginChallengesBoundMFAEvenWhenPolicyDisabled(t *testing.T) {
	setupBoundMFAUser(t, model.MFAPolicyDisabled)

	handler := NewAuthHandler()
	router := gin.New()
	router.POST("/login", handler.PasswordLogin)

	response := performAuthRequest(router, http.MethodPost, "/login",
		`{"username":"alice","password":"correct-password"}`, nil)
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "mfa_required") {
		t.Fatalf("status/body = %d/%s, want 401 with mfa_required", response.Code, response.Body.String())
	}
}

// 挑战开启后必须能用正确的动态码登录（这条路径此前没有任何测试覆盖）。
func TestPasswordLoginAcceptsValidMFACode(t *testing.T) {
	setupBoundMFAUser(t, model.MFAPolicyDisabled)

	handler := NewAuthHandler()
	router := gin.New()
	router.POST("/login", handler.PasswordLogin)

	code := totpCode(t, rfc6238TestSecret, time.Now())
	response := performAuthRequest(router, http.MethodPost, "/login",
		fmt.Sprintf(`{"username":"alice","password":"correct-password","mfa_code":%q}`, code), nil)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", response.Code, response.Body.String())
	}
}

// 第三方登录无法在这里校验动态码，因此不能沿用上一次会话在浏览器上留下的提权信任
// （否则敏感操作会跳过二次验证）。顺带覆盖「仅存在用户登录」按用户名绑定预开通账号。
// oidcTestRig 是一套假的身份源：内存库 + 一个返回固定身份的假 IdP + 已登记好的 provider。
type oidcTestRig struct {
	router *gin.Engine
	user   *model.User
}

// setupOIDCTestRig 起一套 OIDC 回调环境。安全设置打开「仅存在用户登录」，
// 这样 alice（本地密码账号）会被身份源按用户名绑定，而不是新建一个账号。
func setupOIDCTestRig(t *testing.T) *oidcTestRig {
	t.Helper()

	user := setupAuthDBWithSecuritySetting(t)
	// 身份源登录会走目录组成员关系写回（group_members / groups），共享测试库没有这两张表，
	// 缺表会让 FindWithSubOrUpsertUser 报错并被归入 user_upsert_failed，走不到回调收尾。
	if err := model.DB.AutoMigrate(
		&model.OAuthProvider{},
		&model.LocalGroup{},
		&model.GroupMember{},
		&model.MFAPendingTicket{},
	); err != nil {
		t.Fatalf("migrating oauth_providers, group and pending ticket tables: %v", err)
	}

	data := model.DefaultSecuritySettingData()
	data.RejectUnknownUsers = true
	if _, err := model.UpdateSecuritySetting(data); err != nil {
		t.Fatalf("enabling rejectUnknownUsers: %v", err)
	}

	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/token":
			_, _ = w.Write([]byte(`{"access_token":"token-1","token_type":"bearer"}`))
		case "/userinfo":
			_, _ = w.Write([]byte(`{"sub":"sub-1","preferred_username":"alice","name":"Alice"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(idp.Close)

	provider := model.OAuthProvider{
		Name:         "mockidp",
		ClientID:     "client-id",
		ClientSecret: model.SecretString("client-secret"),
		AuthURL:      idp.URL + "/authorize",
		TokenURL:     idp.URL + "/token",
		UserInfoURL:  idp.URL + "/userinfo",
		Enabled:      true,
	}
	if err := model.DB.Create(&provider).Error; err != nil {
		t.Fatalf("creating oauth provider: %v", err)
	}

	handler := NewAuthHandler()
	router := gin.New()
	router.GET("/callback", handler.Callback)
	router.POST("/mfa/verify", handler.VerifyPendingMFA)
	return &oidcTestRig{router: router, user: user}
}

// performOIDCCallback 走一遍身份源回调（cookie 与查询参数固定），extraCookies 会被额外带上。
func performOIDCCallback(router *gin.Engine, extraCookies ...*http.Cookie) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/callback?code=code-1&state=state-1", nil)
	request.AddCookie(&http.Cookie{Name: "oauth_provider", Value: "mockidp"})
	request.AddCookie(&http.Cookie{Name: "oauth_state", Value: "state-1"})
	for _, cookie := range extraCookies {
		request.AddCookie(cookie)
	}
	router.ServeHTTP(recorder, request)
	return recorder
}

func performMFAPendingVerify(router *gin.Engine, ticket, code string) *httptest.ResponseRecorder {
	body, err := json.Marshal(MFAPendingVerifyRequest{Ticket: ticket, Code: code})
	if err != nil {
		panic(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/mfa/verify", strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	return recorder
}

func mfaPendingTicketFrom(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parsing redirect location %q: %v", location, err)
	}
	ticket := parsed.Query().Get("mfa_pending")
	if ticket == "" {
		t.Fatalf("no mfa_pending ticket in redirect %q", location)
	}
	return ticket
}

func setCookieValue(recorder *httptest.ResponseRecorder, name string) string {
	for _, header := range recorder.Result().Header.Values("Set-Cookie") {
		if strings.HasPrefix(header, name+"=") {
			return header
		}
	}
	return ""
}

func TestOIDCCallbackClearsStepUpTrustAndBindsPreProvisionedAccount(t *testing.T) {
	rig := setupOIDCTestRig(t)

	recorder := performOIDCCallback(rig.router, &http.Cookie{Name: mfa.TrustCookieName, Value: "stale-trust"})

	if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != "/" {
		t.Fatalf("callback = %d/%q, want a redirect to the app root", recorder.Code, recorder.Header().Get("Location"))
	}

	if cleared := setCookieValue(recorder, mfa.TrustCookieName); !strings.Contains(cleared, "Max-Age=0") {
		t.Fatalf("the callback must clear the step-up trust cookie, Set-Cookie=%v",
			recorder.Result().Header.Values("Set-Cookie"))
	}

	var after model.User
	if err := model.DB.First(&after, rig.user.ID).Error; err != nil {
		t.Fatalf("reloading user: %v", err)
	}
	if after.Sub != "sub-1" {
		t.Errorf("Sub = %q, want the identity bound to the pre-provisioned account", after.Sub)
	}
}

// 第三方回调是重定向流，收不到动态码，所以已绑定动态码的账号**不能**在回调里拿到会话：
// 回调只发一张短时票据，登录页补验动态码之后才签发会话（见 VerifyPendingMFA）。
func TestOIDCCallbackDefersSessionUntilPendingMFACodeIsVerified(t *testing.T) {
	rig := setupOIDCTestRig(t)
	if err := model.StoreMFASecret(rig.user.ID, rfc6238TestSecret); err != nil {
		t.Fatalf("storing MFA secret: %v", err)
	}
	if err := model.EnableUserMFA(rig.user.ID); err != nil {
		t.Fatalf("enabling MFA: %v", err)
	}
	model.InvalidateUserCache(uint64(rig.user.ID))

	callback := performOIDCCallback(rig.router)
	if callback.Code != http.StatusFound {
		t.Fatalf("callback status = %d, want %d: %s", callback.Code, http.StatusFound, callback.Body.String())
	}
	if location := callback.Header().Get("Location"); !strings.HasPrefix(location, "/login?mfa_pending=") {
		t.Fatalf("callback redirected to %q, want the login page carrying an mfa_pending ticket", location)
	}
	if session := setCookieValue(callback, "auth_token"); session != "" {
		t.Fatalf("the callback created a session before the MFA code was verified: %s", session)
	}

	ticket := mfaPendingTicketFrom(t, callback)

	// 输错一次不能作废票据，否则用户打错一位就得重新走一遍身份源登录。
	wrong := performMFAPendingVerify(rig.router, ticket, "000000")
	if wrong.Code != http.StatusUnauthorized || !strings.Contains(wrong.Body.String(), "invalid_mfa_code") {
		t.Fatalf("wrong code = %d/%s, want 401 with invalid_mfa_code", wrong.Code, wrong.Body.String())
	}
	if session := setCookieValue(wrong, "auth_token"); session != "" {
		t.Fatalf("a wrong MFA code created a session: %s", session)
	}

	code := totpCode(t, rfc6238TestSecret, time.Now())
	verified := performMFAPendingVerify(rig.router, ticket, code)
	if verified.Code != http.StatusNoContent {
		t.Fatalf("verify status = %d, want %d: %s", verified.Code, http.StatusNoContent, verified.Body.String())
	}
	if session := setCookieValue(verified, "auth_token"); session == "" {
		t.Fatal("verifying the MFA code did not create a session")
	}
	// 验证成功同时要标记提权信任，敏感操作的二次验证窗口才与密码登录一致。
	if trust := setCookieValue(verified, mfa.TrustCookieName); trust == "" || strings.Contains(trust, "Max-Age=0") {
		t.Fatalf("a successful verification must mark the browser trusted, Set-Cookie=%v",
			verified.Result().Header.Values("Set-Cookie"))
	}

	// 一次性：同一张票据不能换第二个会话。
	replay := performMFAPendingVerify(rig.router, ticket, code)
	if replay.Code != http.StatusUnauthorized || !strings.Contains(replay.Body.String(), "mfa_pending_invalid") {
		t.Fatalf("replay = %d/%s, want 401 with mfa_pending_invalid", replay.Code, replay.Body.String())
	}
	if session := setCookieValue(replay, "auth_token"); session != "" {
		t.Fatalf("a replayed ticket created a second session: %s", session)
	}
}
