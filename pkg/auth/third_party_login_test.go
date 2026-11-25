package auth

import (
	"net/http"
	"testing"

	"aerolink/pkg/model"
)

// 第三方（OIDC）登录必须与密码 / LDAP 登录一样留下登录日志。
//
// 此前只有 completePasswordLikeLogin 调用 notification.NotifyRemoteLogin，而回调与补验动态码
// 走的 completeThirdPartyLogin 整段没有记录，于是「审计管理 → 登录日志」里查不到任何身份源登录
// （等保三级安全审计要求登录成功与失败都留痕）。
func TestThirdPartyLoginWritesLoginRecord(t *testing.T) {
	rig := setupOIDCTestRig(t)
	// 共享测试库不迁审计表：缺表时写入会失败并被上层记日志，显式迁出来才能断言。
	if err := model.DB.AutoMigrate(&model.LoginRecord{}); err != nil {
		t.Fatalf("migrating login records: %v", err)
	}

	callback := performOIDCCallback(rig.router)
	if callback.Code != http.StatusFound || callback.Header().Get("Location") != "/" {
		t.Fatalf("callback = %d/%q, want a redirect to the app root", callback.Code, callback.Header().Get("Location"))
	}

	var records []model.LoginRecord
	if err := model.DB.Order("id").Find(&records).Error; err != nil {
		t.Fatalf("loading login records: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("login records = %d, want exactly one for the completed sign-in", len(records))
	}
	record := records[0]
	if record.UserID != rig.user.ID || record.Username != rig.user.Username {
		t.Errorf("record user = %d/%q, want %d/%q", record.UserID, record.Username, rig.user.ID, rig.user.Username)
	}
	if record.Provider != "mockidp" {
		t.Errorf("Provider = %q, want %q", record.Provider, "mockidp")
	}
	if record.Result != model.LoginResultSuccess {
		t.Errorf("Result = %q, want the success marker %q", record.Result, model.LoginResultSuccess)
	}
}
