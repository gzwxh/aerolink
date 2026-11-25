package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"aerolink/pkg/rbac"
	"github.com/gin-gonic/gin"
)

// 系统设置权限拆成查看（settings + get）与管理（settings + update）：
// GET 只要具备其中任一即可，写操作必须要有管理权限。
func TestRequireSettingsSectionReadVsWrite(t *testing.T) {
	gin.SetMode(gin.TestMode)

	roles := map[string]common.Role{
		"settings-viewer": {
			Name: "settings-viewer",
			Grants: []common.ResourceGrant{
				{Resource: common.SystemSettingsResource, Verbs: []string{"get"}},
			},
		},
		"settings-manager": {
			Name: "settings-manager",
			Grants: []common.ResourceGrant{
				{Resource: common.SystemSettingsResource, Verbs: []string{"get", "update"}},
			},
		},
		"no-settings": {
			Name:   "no-settings",
			Grants: []common.ResourceGrant{{Resource: "pods", Verbs: []string{"get"}}},
		},
	}

	tests := []struct {
		name       string
		role       string
		method     string
		wantStatus int
	}{
		{"viewer may read", "settings-viewer", http.MethodGet, http.StatusNoContent},
		{"viewer may not write", "settings-viewer", http.MethodPost, http.StatusForbidden},
		{"viewer may not delete", "settings-viewer", http.MethodDelete, http.StatusForbidden},
		{"manager may read", "settings-manager", http.MethodGet, http.StatusNoContent},
		{"manager may write", "settings-manager", http.MethodPut, http.StatusNoContent},
		{"unrelated role may not read", "no-settings", http.MethodGet, http.StatusForbidden},
	}

	originalConfig := rbac.RBACConfig
	t.Cleanup(func() { rbac.RBACConfig = originalConfig })

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rbac.RBACConfig = &common.RolesConfig{
				Roles:       []common.Role{roles[tc.role]},
				RoleMapping: []common.RoleMapping{{Name: tc.role, Users: []string{"alice"}}},
			}

			router := gin.New()
			router.Use(func(c *gin.Context) {
				c.Set("user", model.User{Username: "alice"})
			})
			router.Use(RequireSettingsSection(""))
			router.Any("/admin/roles", func(c *gin.Context) {
				c.Status(http.StatusNoContent)
			})

			response := httptest.NewRecorder()
			request := httptest.NewRequest(tc.method, "/admin/roles", nil)
			router.ServeHTTP(response, request)

			if response.Code != tc.wantStatus {
				t.Fatalf("%s as %s returned %d, want %d; body=%s",
					tc.method, tc.role, response.Code, tc.wantStatus, response.Body.String())
			}
		})
	}
}

// 章节级资源把「系统配置」「安全授权」「审计」隔开：三员在一个章节上的授权不会
// 外溢到别的章节（等保三级三权分立的落点）。
func TestRequireSettingsSectionIsolatesSections(t *testing.T) {
	gin.SetMode(gin.TestMode)

	roles := map[string]common.Role{
		// 系统管理员：系统配置类章节。
		"system-admin": {
			Name: "system-admin",
			Grants: []common.ResourceGrant{
				{Resource: common.SettingsSectionResource(common.SettingsSectionGeneral), Verbs: []string{"*"}},
				{Resource: common.SettingsSectionResource(common.SettingsSectionClusters), Verbs: []string{"*"}},
			},
		},
		// 安全管理员：授权与安全策略。
		"security-admin": {
			Name: "security-admin",
			Grants: []common.ResourceGrant{
				{Resource: common.SettingsSectionResource(common.SettingsSectionUsers), Verbs: []string{"*"}},
				{Resource: common.SettingsSectionResource(common.SettingsSectionRBAC), Verbs: []string{"*"}},
			},
		},
		// 审计管理员：只读审计日志。
		"auditor": {
			Name: "auditor",
			Grants: []common.ResourceGrant{
				{Resource: common.SettingsSectionResource(common.SettingsSectionAudit), Verbs: []string{"get"}},
			},
		},
	}

	tests := []struct {
		name       string
		role       string
		section    string
		method     string
		wantStatus int
	}{
		{"system admin may manage clusters", "system-admin", common.SettingsSectionClusters, http.MethodPut, http.StatusNoContent},
		{"system admin may NOT touch users", "system-admin", common.SettingsSectionUsers, http.MethodGet, http.StatusForbidden},
		{"system admin may NOT touch audit", "system-admin", common.SettingsSectionAudit, http.MethodGet, http.StatusForbidden},
		{"security admin may manage users", "security-admin", common.SettingsSectionUsers, http.MethodPost, http.StatusNoContent},
		{"security admin may NOT touch clusters", "security-admin", common.SettingsSectionClusters, http.MethodGet, http.StatusForbidden},
		{"security admin may NOT touch audit", "security-admin", common.SettingsSectionAudit, http.MethodGet, http.StatusForbidden},
		{"auditor may read audit", "auditor", common.SettingsSectionAudit, http.MethodGet, http.StatusNoContent},
		{"auditor may NOT write audit", "auditor", common.SettingsSectionAudit, http.MethodPut, http.StatusForbidden},
		{"auditor may NOT touch users", "auditor", common.SettingsSectionUsers, http.MethodGet, http.StatusForbidden},
		{"auditor may NOT touch general", "auditor", common.SettingsSectionGeneral, http.MethodGet, http.StatusForbidden},
	}

	originalConfig := rbac.RBACConfig
	t.Cleanup(func() { rbac.RBACConfig = originalConfig })

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rbac.RBACConfig = &common.RolesConfig{
				Roles:       []common.Role{roles[tc.role]},
				RoleMapping: []common.RoleMapping{{Name: tc.role, Users: []string{"alice"}}},
			}

			router := gin.New()
			router.Use(func(c *gin.Context) {
				c.Set("user", model.User{Username: "alice"})
			})
			router.Use(RequireSettingsSection(tc.section))
			router.Any("/admin/anything", func(c *gin.Context) {
				c.Status(http.StatusNoContent)
			})

			response := httptest.NewRecorder()
			request := httptest.NewRequest(tc.method, "/admin/anything", nil)
			router.ServeHTTP(response, request)

			if response.Code != tc.wantStatus {
				t.Fatalf("%s %s as %s returned %d, want %d; body=%s",
					tc.method, tc.section, tc.role, response.Code, tc.wantStatus, response.Body.String())
			}
		})
	}
}
