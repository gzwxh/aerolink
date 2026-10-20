package apikeys

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/auth"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestAPIKeyLifecycleControlsAuthentication(t *testing.T) {
	setupAPIKeyTestDB(t)
	passwordUser := model.User{Username: "person", Provider: model.AuthProviderPassword, Enabled: true}
	if err := model.DB.Create(&passwordUser).Error; err != nil {
		t.Fatalf("creating password user: %v", err)
	}

	router := gin.New()
	router.POST("/apikeys", CreateAPIKey)
	router.GET("/apikeys", ListAPIKeys)
	router.DELETE("/apikeys/:id", DeleteAPIKey)

	createResponse := performAPIKeyRequest(router, http.MethodPost, "/apikeys", `{"name":"ci-deploy"}`)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want %d: %s", createResponse.Code, http.StatusCreated, createResponse.Body.String())
	}
	var created struct {
		APIKey struct {
			ID       uint   `json:"id"`
			Username string `json:"username"`
			Key      string `json:"key"`
		} `json:"apiKey"`
	}
	if err := json.Unmarshal(createResponse.Body.Bytes(), &created); err != nil {
		t.Fatalf("decoding create response: %v", err)
	}
	if created.APIKey.ID == 0 || created.APIKey.Username != "ci-deploy" {
		t.Fatalf("created API key = %#v", created.APIKey)
	}
	wantPrefix := fmt.Sprintf("%s%d-", model.APIKeyPrefix, created.APIKey.ID)
	fullKey := created.APIKey.Key
	if !strings.HasPrefix(fullKey, wantPrefix) || len(fullKey) != len(wantPrefix)+32 {
		t.Fatalf("created key = %q, want %q followed by a 32-char secret", fullKey, wantPrefix)
	}
	secret := strings.TrimPrefix(fullKey, wantPrefix)

	listResponse := performAPIKeyRequest(router, http.MethodGet, "/apikeys", "")
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d, want %d: %s", listResponse.Code, http.StatusOK, listResponse.Body.String())
	}
	// 列表响应里不能有可用密钥：客户端拿不到 secret，抓包/代理日志留存的也只是前缀。
	if strings.Contains(listResponse.Body.String(), secret) {
		t.Fatalf("list response leaked the key secret: %s", listResponse.Body.String())
	}
	var listed struct {
		APIKeys []struct {
			ID           uint   `json:"id"`
			APIKeyPrefix string `json:"apiKeyPrefix"`
		} `json:"apiKeys"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decoding list response: %v", err)
	}
	if len(listed.APIKeys) != 1 || listed.APIKeys[0].ID != created.APIKey.ID {
		t.Fatalf("listed API keys = %#v", listed.APIKeys)
	}
	if listed.APIKeys[0].APIKeyPrefix != wantPrefix {
		t.Fatalf("listed prefix = %q, want %q", listed.APIKeys[0].APIKeyPrefix, wantPrefix)
	}

	authHandler := auth.NewAuthHandler()
	authRecorder := httptest.NewRecorder()
	authContext, _ := gin.CreateTestContext(authRecorder)
	authContext.Request = httptest.NewRequest(http.MethodGet, "/protected", nil)
	keyToken, ok := model.APIKeyToken(fullKey)
	if !ok {
		t.Fatalf("APIKeyToken(%q) did not accept the issued key", fullKey)
	}
	authHandler.RequireAPIKeyAuth(authContext, keyToken)
	if authContext.IsAborted() {
		t.Fatalf("created API key was rejected: %s", authRecorder.Body.String())
	}
	authenticated, exists := authContext.Get("user")
	if !exists || authenticated.(model.User).ID != created.APIKey.ID {
		t.Fatalf("authenticated user = %#v", authenticated)
	}

	deleteResponse := performAPIKeyRequest(router, http.MethodDelete, fmt.Sprintf("/apikeys/%d", created.APIKey.ID), "")
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", deleteResponse.Code, http.StatusOK, deleteResponse.Body.String())
	}

	rejectedRecorder := httptest.NewRecorder()
	rejectedContext, _ := gin.CreateTestContext(rejectedRecorder)
	rejectedContext.Request = httptest.NewRequest(http.MethodGet, "/protected", nil)
	keyToken, ok = model.APIKeyToken(fullKey)
	if !ok {
		t.Fatalf("APIKeyToken(%q) did not accept the issued key", fullKey)
	}
	authHandler.RequireAPIKeyAuth(rejectedContext, keyToken)
	if !rejectedContext.IsAborted() || rejectedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("deleted API key authentication status = %d, aborted=%v", rejectedRecorder.Code, rejectedContext.IsAborted())
	}
}

func TestDeleteAPIKeyRejectsInvalidID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.DELETE("/apikeys/:id", DeleteAPIKey)

	response := performAPIKeyRequest(router, http.MethodDelete, "/apikeys/not-a-number", "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

// /apikeys/:id 只能删 API key 伪用户：否则只被授予 settings.apikeys 的委派管理员
// 就能借这个接口删除普通账号，绕过 settings.users 授权域。
func TestDeleteAPIKeyRejectsNonAPIKeyUser(t *testing.T) {
	setupAPIKeyTestDB(t)

	passwordUser := model.User{Username: "not-an-api-key", Provider: model.AuthProviderPassword, Enabled: true}
	if err := model.DB.Create(&passwordUser).Error; err != nil {
		t.Fatalf("creating password user: %v", err)
	}

	router := gin.New()
	router.DELETE("/apikeys/:id", DeleteAPIKey)

	response := performAPIKeyRequest(router, http.MethodDelete, fmt.Sprintf("/apikeys/%d", passwordUser.ID), "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusNotFound, response.Body.String())
	}

	var remaining model.User
	if err := model.DB.First(&remaining, passwordUser.ID).Error; err != nil {
		t.Fatalf("the password user must survive DELETE /apikeys/:id: %v", err)
	}
}

func setupAPIKeyTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalEncryptKey := common.EncryptKey
	common.EncryptKey = "apikey-handler-test-key"
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.Role{}, &model.RoleAssignment{}, &model.BindingGroupMember{}, &model.GroupMember{}, &model.ResourceHistory{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	model.DB = db
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
		model.DB = originalDB
		common.EncryptKey = originalEncryptKey
	})
}

func performAPIKeyRequest(router *gin.Engine, method string, path string, body string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	router.ServeHTTP(recorder, request)
	return recorder
}

// 删除 API 密钥时审计必须留下密钥名称与脱敏快照：密钥本身绝不能进审计日志。
func TestDeleteAPIKeyRecordsAuditDetail(t *testing.T) {
	setupAPIKeyTestDB(t)

	var detail common.AdminAuditDetail
	router := gin.New()
	router.POST("/apikeys", CreateAPIKey)
	router.DELETE("/apikeys/:id", func(c *gin.Context) {
		DeleteAPIKey(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	create := performAPIKeyRequest(router, http.MethodPost, "/apikeys", `{"name":"ci-deploy"}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want %d: %s", create.Code, http.StatusCreated, create.Body.String())
	}
	var created struct {
		APIKey struct {
			ID  uint   `json:"id"`
			Key string `json:"key"`
		} `json:"apiKey"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatalf("decoding create response: %v", err)
	}

	deleted := performAPIKeyRequest(router, http.MethodDelete, fmt.Sprintf("/apikeys/%d", created.APIKey.ID), "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", deleted.Code, http.StatusOK, deleted.Body.String())
	}
	if detail.ResourceName != "ci-deploy" {
		t.Fatalf("audit resourceName = %q, want the key name", detail.ResourceName)
	}
	if !strings.Contains(detail.PreviousYAML, "username: ") {
		t.Fatalf("audit snapshot must describe the key, got %q", detail.PreviousYAML)
	}
	secret := created.APIKey.Key[strings.LastIndex(created.APIKey.Key, "-")+1:]
	if secret == "" || strings.Contains(detail.PreviousYAML, secret) {
		t.Fatalf("audit snapshot must not leak the key secret: %s", detail.PreviousYAML)
	}
}
