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

// setupTemplateTestDB 把包级 model.DB 换成一个一次性内存库，测试结束自动还原。
func setupTemplateTestDB(t *testing.T) *gorm.DB {
	t.Helper()
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
	return db
}

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

// 回归（缺陷 D-121）：模板只存不校验，`this is :: not valid yaml [[[` 也能 201 入库，
// 直到有人选中它去创建资源才暴露——存进去的是一份永远用不了的模板。
func TestCreateTemplateRejectsUnparsableYAML(t *testing.T) {
	setupTemplateTestDB(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/templates", CreateTemplate)

	recorder := httptest.NewRecorder()
	body := `{"name":"broken","yaml":"this is :: not valid yaml [[[ "}`
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/templates", strings.NewReader(body)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusUnprocessableEntity, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), invalidTemplateYAMLCode) {
		t.Fatalf("响应必须带机器可读码 %s, got %s", invalidTemplateYAMLCode, recorder.Body.String())
	}

	var count int64
	if err := model.DB.Model(&model.ResourceTemplate{}).Count(&count).Error; err != nil {
		t.Fatalf("counting templates: %v", err)
	}
	if count != 0 {
		t.Fatalf("非法模板不应入库, got %d 行", count)
	}
}

// 多文档模板是正常用法（一次下发多个资源），校验不能把它误拒。
func TestCreateTemplateAcceptsMultiDocumentYAML(t *testing.T) {
	setupTemplateTestDB(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/templates", CreateTemplate)

	recorder := httptest.NewRecorder()
	body := `{"name":"pair","yaml":"apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n"}`
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/templates", strings.NewReader(body)))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
}

// 更新同样要把住：非法内容不能覆盖掉一份原本可用的模板。
func TestUpdateTemplateRejectsUnparsableYAML(t *testing.T) {
	db := setupTemplateTestDB(t)
	template := model.ResourceTemplate{Name: "Pod", Description: "basic", YAML: "kind: Pod"}
	if err := db.Create(&template).Error; err != nil {
		t.Fatalf("seeding template: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.PUT("/templates/:id", UpdateTemplate)

	recorder := httptest.NewRecorder()
	body := `{"description":"edited","yaml":"a: [}"}`
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, fmt.Sprintf("/templates/%d", template.ID), strings.NewReader(body)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusUnprocessableEntity, recorder.Body.String())
	}

	var stored model.ResourceTemplate
	if err := db.First(&stored, template.ID).Error; err != nil {
		t.Fatalf("reading template: %v", err)
	}
	if stored.YAML != "kind: Pod" {
		t.Fatalf("原模板内容不应被非法提交覆盖, got %q", stored.YAML)
	}
}
