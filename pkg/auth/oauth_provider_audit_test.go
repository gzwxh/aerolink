package auth

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

// 删除 OAuth 提供方的审计详情必须带提供方名与快照，且 clientSecret 绝不能进快照。
func TestDeleteOAuthProviderRecordsAuditDetail(t *testing.T) {
	originalDB := model.DB
	originalManaged := common.ManagedSections
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	model.DB = db
	common.SetManagedSections(nil)
	t.Cleanup(func() {
		model.DB = originalDB
		common.SetManagedSections(originalManaged)
	})
	if err := db.AutoMigrate(&model.OAuthProvider{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}

	provider := model.OAuthProvider{
		Name:         model.LowerCaseString("mockidp"),
		ClientID:     "client-id",
		ClientSecret: "top-secret-value",
		Issuer:       "https://idp.example.com",
		Enabled:      true,
	}
	if err := db.Create(&provider).Error; err != nil {
		t.Fatalf("seeding provider: %v", err)
	}

	var detail common.AdminAuditDetail
	gin.SetMode(gin.TestMode)
	handler := NewAuthHandler()
	router := gin.New()
	router.DELETE("/oauth-providers/:id", func(c *gin.Context) {
		handler.DeleteOAuthProvider(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/oauth-providers/%d", provider.ID), nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if detail.ResourceName != "mockidp" {
		t.Fatalf("audit resourceName = %q, want the provider name", detail.ResourceName)
	}
	if !strings.Contains(detail.PreviousYAML, "clientId: client-id") {
		t.Fatalf("audit snapshot must describe the provider, got %q", detail.PreviousYAML)
	}
	if strings.Contains(detail.PreviousYAML, "top-secret-value") {
		t.Fatalf("audit snapshot must not leak the client secret: %s", detail.PreviousYAML)
	}
}
