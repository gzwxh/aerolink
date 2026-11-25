package helm

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 删除 Helm 仓库的审计详情必须带仓库名与快照，且仓库口令（Password）绝不能进快照。
func TestDeleteRepositoryRecordsAuditDetail(t *testing.T) {
	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	model.DB = db
	t.Cleanup(func() { model.DB = originalDB })
	if err := db.AutoMigrate(&model.HelmRepository{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}

	repository := model.HelmRepository{
		Name:     "bitnami",
		URL:      "https://charts.example.com",
		Username: "ops",
		Password: "top-secret-password",
	}
	if err := db.Create(&repository).Error; err != nil {
		t.Fatalf("seeding repository: %v", err)
	}

	var detail common.AdminAuditDetail
	gin.SetMode(gin.TestMode)
	handler := NewHelmChartHandler()
	router := gin.New()
	router.DELETE("/charts/repositories/:id", func(c *gin.Context) {
		handler.DeleteRepository(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/charts/repositories/%d", repository.ID), nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if detail.ResourceName != "bitnami" {
		t.Fatalf("audit resourceName = %q, want the repository name", detail.ResourceName)
	}
	if !strings.Contains(detail.PreviousYAML, "https://charts.example.com") {
		t.Fatalf("audit snapshot must describe the repository, got %q", detail.PreviousYAML)
	}
	if strings.Contains(detail.PreviousYAML, "top-secret-password") {
		t.Fatalf("audit snapshot must not leak the repository password: %s", detail.PreviousYAML)
	}
}
