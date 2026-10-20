package settings

import (
	"net/http"
	"strings"
	"testing"

	"github.com/zxh326/kite/pkg/model"
)

// 帮助文档地址会随公开的 bootstrap 接口下发给未登录的登录页并渲染成外链，
// 所以只放行 http(s) 绝对地址。这里把「放行什么、拒绝什么」以及「被拒不改动已存值」钉住。
func TestUpdateGeneralSettingHelpURL(t *testing.T) {
	setupGeneralSettingTestDB(t, "")
	router := generalSettingTestRouter()

	store := func() model.GeneralSetting {
		t.Helper()
		var stored model.GeneralSetting
		if err := model.DB.First(&stored, 1).Error; err != nil {
			t.Fatalf("loading stored setting: %v", err)
		}
		return stored
	}

	const accepted = "https://aerolink-docs.gcongo.cn/"
	response := performGeneralSettingRequest(t, router, http.MethodPut, `{"helpUrl":"  `+accepted+`  "}`)
	if response.Code != http.StatusOK {
		t.Fatalf("合法地址被拒：status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	// 前后空白先裁剪再入库。
	if got := store().HelpURL; got != accepted {
		t.Fatalf("stored help url = %q, want %q", got, accepted)
	}

	for _, rejected := range []string{
		"javascript:alert(1)",
		"data:text/html;base64,PHNjcmlwdD4=",
		"https://",
		"/guide/installation",
		"https://" + strings.Repeat("a", maxHelpURLLength),
	} {
		response := performGeneralSettingRequest(t, router, http.MethodPut, `{"helpUrl":"`+rejected+`"}`)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("地址 %q 被接受：status = %d, want %d", rejected, response.Code, http.StatusBadRequest)
		}
		// 被拒的请求不能改动已存的值。
		if got := store().HelpURL; got != accepted {
			t.Fatalf("被拒的请求改动了已存地址：%q", got)
		}
	}

	// 空串 = 清除入口（界面随之不再显示「帮助文档」）。
	if response := performGeneralSettingRequest(t, router, http.MethodPut, `{"helpUrl":""}`); response.Code != http.StatusOK {
		t.Fatalf("清空被拒：status = %d: %s", response.Code, response.Body.String())
	}
	if got := store().HelpURL; got != "" {
		t.Fatalf("清空后 stored help url = %q, want empty", got)
	}
}