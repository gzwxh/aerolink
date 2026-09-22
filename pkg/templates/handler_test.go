package templates

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 删除模板的审计详情必须带模板名与 YAML 快照：模板里就是资源的初始清单，
// 删掉之后只能靠这条记录把内容追回来。
func TestDeleteTemplateRecordsAuditDetail(t *testing.T) {
	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	model.DB = db
	t.Cleanup(func() { model.DB = originalDB })
	if err := db.AutoMigrate(&model.ResourceTemplate{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}

	template := model.ResourceTemplate{Name: "Pod", Description: "basic", YAML: "kind: Pod"}
	if err := db.Create(&template).Error; err != nil {
		t.Fatalf("seeding template: %v", err)
	}

	var detail common.AdminAuditDetail
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.DELETE("/templates/:id", func(c *gin.Context) {
		DeleteTemplate(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/templates/%d", template.ID), nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if detail.ResourceName != "Pod" {
		t.Fatalf("audit resourceName = %q, want the template name", detail.ResourceName)
	}
	if !strings.Contains(detail.PreviousYAML, "kind: Pod") {
		t.Fatalf("audit snapshot must contain the template body, got %q", detail.PreviousYAML)
	}
}
