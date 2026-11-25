package settings

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gzwxh/aerolink/pkg/model"
)

// 品牌名称的字符上限钉在 **16**（列宽是 varchar(100)，但侧边栏只有 16rem 宽，
// 前端按两行折行也放不下更长的名字）。
//
// 断言里刻意写死数字而不是引用 maxSiteNameLength：用常量推导测试数据的话，
// 常量被改回 100 时用例照样通过（改数据的「反证」测不出任何东西）。
func TestUpdateGeneralSettingSiteNameLengthLimit(t *testing.T) {
	if maxSiteNameLength != 16 {
		t.Fatalf("maxSiteNameLength = %d, want 16（改这个上限时请同步 ui/src/lib/site-name.ts 的 SITE_NAME_MAX_LENGTH）", maxSiteNameLength)
	}

	setupGeneralSettingTestDB(t, "")
	router := generalSettingTestRouter()

	accepted := strings.Repeat("运", 16)
	response := performGeneralSettingRequest(t, router, http.MethodPut, `{"siteName":"`+accepted+`"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("16 个字符被拒：status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	var stored model.GeneralSetting
	if err := model.DB.First(&stored, 1).Error; err != nil {
		t.Fatalf("loading stored setting: %v", err)
	}
	if stored.SiteName != accepted {
		t.Fatalf("stored site name = %q, want %q", stored.SiteName, accepted)
	}

	rejected := strings.Repeat("运", 17)
	response = performGeneralSettingRequest(t, router, http.MethodPut, `{"siteName":"`+rejected+`"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("17 个字符被接受：status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	// 被拒的请求不能改动已存的值。
	if err := model.DB.First(&stored, 1).Error; err != nil {
		t.Fatalf("loading stored setting: %v", err)
	}
	if stored.SiteName != accepted {
		t.Fatalf("rejected update changed the stored site name: %q", stored.SiteName)
	}

	// 前后空白先裁剪再计数：16 个字符加空白仍然合法。
	padded := `{"siteName":"  ` + accepted + `  "}`
	if response := performGeneralSettingRequest(t, router, http.MethodPut, padded); response.Code != http.StatusOK {
		t.Fatalf("带空白前缀的 16 个字符被拒：status = %d: %s", response.Code, response.Body.String())
	}
}
