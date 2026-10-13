package rbac

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestRoleHandlers(t *testing.T) { //nolint:gocyclo // 该用例用多个子测试覆盖 handler 的完整生命周期
	originalDB := model.DB
	originalManagedSections := common.ManagedSections
	originalSyncNow := SyncNow
	originalGinMode := gin.Mode()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get database: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	common.SetManagedSections(map[string]bool{})
	SyncNow = make(chan struct{}, 16)
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		model.DB = originalDB
		common.SetManagedSections(originalManagedSections)
		SyncNow = originalSyncNow
		gin.SetMode(originalGinMode)
		_ = sqlDB.Close()
	})

	if err := db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}
	if err := db.AutoMigrate(
		&model.Role{},
		&model.RoleAssignment{},
		&model.BindingGroupMember{},
		&model.BindingGroup{},
		&model.User{},
		&model.Cluster{},
		&model.GeneralSetting{},
	); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	// 捕获 handler 交给审计中间件的详情：生产链路上它由 middleware.AdminAudit 读取
	// 并写进 resource_histories。
	var auditDetail common.AdminAuditDetail
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Next()
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			if detail, ok := value.(common.AdminAuditDetail); ok {
				auditDetail = detail
			}
		}
	})
	router.GET("/roles", ListRoles)
	router.GET("/roles/:id", GetRole)
	router.POST("/roles", CreateRole)
	router.PUT("/roles/:id", UpdateRole)
	router.DELETE("/roles/:id", DeleteRole)
	router.POST("/roles/:id/assign", AssignRole)
	router.DELETE("/roles/:id/assign", UnassignRole)

	perform := func(method, path, body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		router.ServeHTTP(response, request)
		return response
	}

	t.Run("ordinary role lifecycle", func(t *testing.T) {
		response := perform(http.MethodPost, "/roles", `{"name":" developer ","description":"initial","clusters":["prod"],"namespaces":["default"],"resources":["pods"],"verbs":["get"]}`)
		if response.Code != http.StatusCreated {
			t.Fatalf("create returned %d, want %d; body=%s", response.Code, http.StatusCreated, response.Body.String())
		}
		var created struct {
			Role model.Role `json:"role"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
			t.Fatalf("decode create response: %v", err)
		}
		if created.Role.ID == 0 || created.Role.Name != "developer" {
			t.Fatalf("created role = %#v", created.Role)
		}
		rolePath := "/roles/" + strconv.FormatUint(uint64(created.Role.ID), 10)

		response = perform(http.MethodGet, "/roles", "")
		if response.Code != http.StatusOK {
			t.Fatalf("list returned %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
		}
		var listed struct {
			Roles []model.Role `json:"roles"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
			t.Fatalf("decode list response: %v", err)
		}
		if len(listed.Roles) != 1 || listed.Roles[0].ID != created.Role.ID {
			t.Fatalf("listed roles = %#v", listed.Roles)
		}

		response = perform(http.MethodGet, rolePath, "")
		if response.Code != http.StatusOK {
			t.Fatalf("get returned %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
		}

		response = perform(http.MethodPut, rolePath, `{"name":"developer-updated","description":"updated","clusters":["prod"],"namespaces":["team-a"],"resources":["deployments"],"verbs":["get","update"]}`)
		if response.Code != http.StatusOK {
			t.Fatalf("update returned %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
		}
		var updated struct {
			Role model.Role `json:"role"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &updated); err != nil {
			t.Fatalf("decode update response: %v", err)
		}
		if updated.Role.Name != "developer-updated" || updated.Role.Description != "updated" {
			t.Fatalf("updated role = %#v", updated.Role)
		}

		userAssignment := `{"subjectType":"user","subject":"alice"}`
		response = perform(http.MethodPost, rolePath+"/assign", userAssignment)
		if response.Code != http.StatusCreated {
			t.Fatalf("assign user returned %d, want %d; body=%s", response.Code, http.StatusCreated, response.Body.String())
		}
		response = perform(http.MethodPost, rolePath+"/assign", userAssignment)
		if response.Code != http.StatusOK {
			t.Fatalf("duplicate assignment returned %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
		}
		response = perform(http.MethodPost, rolePath+"/assign", `{"subjectType":"group","subject":"developers"}`)
		if response.Code != http.StatusCreated {
			t.Fatalf("assign group returned %d, want %d; body=%s", response.Code, http.StatusCreated, response.Body.String())
		}
		var assignmentCount int64
		if err := db.Model(&model.RoleAssignment{}).Where("role_id = ?", created.Role.ID).Count(&assignmentCount).Error; err != nil {
			t.Fatalf("count assignments: %v", err)
		}
		if assignmentCount != 2 {
			t.Fatalf("assignment count = %d, want 2", assignmentCount)
		}

		response = perform(http.MethodDelete, rolePath+"/assign?subjectType=user&subject=alice", "")
		if response.Code != http.StatusOK {
			t.Fatalf("unassign returned %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
		}
		// 取消分配的路径里只有角色 ID 与查询参数：审计详情要能读出「谁对哪个角色的分配被收回」。
		if auditDetail.ResourceName != "developer-updated ← user:alice" {
			t.Fatalf("audit resourceName = %q, want role <- subject", auditDetail.ResourceName)
		}
		if err := db.Model(&model.RoleAssignment{}).Where("role_id = ?", created.Role.ID).Count(&assignmentCount).Error; err != nil {
			t.Fatalf("count assignments after unassign: %v", err)
		}
		if assignmentCount != 1 {
			t.Fatalf("assignment count after unassign = %d, want 1", assignmentCount)
		}

		response = perform(http.MethodDelete, rolePath, "")
		if response.Code != http.StatusOK {
			t.Fatalf("delete returned %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
		}
		if err := db.Model(&model.RoleAssignment{}).Where("role_id = ?", created.Role.ID).Count(&assignmentCount).Error; err != nil {
			t.Fatalf("count assignments after role delete: %v", err)
		}
		if assignmentCount != 0 {
			t.Fatalf("assignment count after role delete = %d, want 0", assignmentCount)
		}
		response = perform(http.MethodGet, rolePath, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("get deleted role returned %d, want %d; body=%s", response.Code, http.StatusNotFound, response.Body.String())
		}
	})

	t.Run("role bound in a permission binding group cannot be deleted", func(t *testing.T) {
		// 删角色会连带删掉 permission binding 的成员行（等价于静默解绑别人的授权），
		// 所以必须先到「权限绑定」里解绑——否则管理员事后无法判断授权为什么少了。
		response := perform(http.MethodPost, "/roles", `{"name":"bound-role","resources":["pods"],"verbs":["get"]}`)
		if response.Code != http.StatusCreated {
			t.Fatalf("create returned %d, want %d; body=%s", response.Code, http.StatusCreated, response.Body.String())
		}
		var created struct {
			Role model.Role `json:"role"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
			t.Fatalf("decode create response: %v", err)
		}
		rolePath := "/roles/" + strconv.FormatUint(uint64(created.Role.ID), 10)

		// 直接分配给一个用户：删除会连带移除这条授权，审计快照里要能看到。
		response = perform(http.MethodPost, rolePath+"/assign", `{"subjectType":"user","subject":"alice"}`)
		if response.Code != http.StatusCreated {
			t.Fatalf("assign returned %d, want %d; body=%s", response.Code, http.StatusCreated, response.Body.String())
		}

		group := model.BindingGroup{Cluster: "c1", Name: "bound-group"}
		if err := db.Create(&group).Error; err != nil {
			t.Fatalf("create binding group: %v", err)
		}
		member := model.BindingGroupMember{
			ProjectID:   group.ID,
			SubjectType: model.SubjectTypeUser,
			Subject:     "alice",
			RoleID:      created.Role.ID,
		}
		if err := db.Create(&member).Error; err != nil {
			t.Fatalf("create binding group member: %v", err)
		}

		response = perform(http.MethodDelete, rolePath, "")
		if response.Code != http.StatusConflict {
			t.Fatalf("delete returned %d, want %d; body=%s", response.Code, http.StatusConflict, response.Body.String())
		}
		if !strings.Contains(response.Body.String(), "role_in_use_by_binding_group") {
			t.Fatalf("expected the in-use code, got %s", response.Body.String())
		}

		// 被拒的删除也要能查到动的是谁、删掉的是什么：DELETE 没有请求体，只靠路径
		// 审计里只会留下 `#6`，所以 handler 必须把角色名与快照交给中间件。
		if auditDetail.ResourceName != "bound-role" {
			t.Fatalf("audit resourceName = %q, want the role name", auditDetail.ResourceName)
		}
		if !strings.Contains(auditDetail.PreviousYAML, "name: bound-role") {
			t.Fatalf("the audit snapshot must describe the role, got %q", auditDetail.PreviousYAML)
		}
		if !strings.Contains(auditDetail.PreviousYAML, "subject: alice") {
			t.Fatalf("the audit snapshot must include the direct assignment, got %q", auditDetail.PreviousYAML)
		}

		// 拒绝删除不能有副作用：角色与成员行都要原样保留。
		var stored model.Role
		if err := db.First(&stored, created.Role.ID).Error; err != nil {
			t.Fatalf("load role after blocked delete: %v", err)
		}
		var memberCount int64
		if err := db.Model(&model.BindingGroupMember{}).Where("role_id = ?", created.Role.ID).Count(&memberCount).Error; err != nil {
			t.Fatalf("count members: %v", err)
		}
		if memberCount != 1 {
			t.Fatalf("member count after blocked delete = %d, want 1", memberCount)
		}

		// 在组里解绑之后，角色可以正常删除。
		if err := db.Where("role_id = ?", created.Role.ID).Delete(&model.BindingGroupMember{}).Error; err != nil {
			t.Fatalf("unbind member: %v", err)
		}
		response = perform(http.MethodDelete, rolePath, "")
		if response.Code != http.StatusOK {
			t.Fatalf("delete after unbind returned %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
		}
	})

	t.Run("managed rbac rejects mutations", func(t *testing.T) {
		common.SetManagedSections(map[string]bool{"rbac": true})
		defer common.SetManagedSections(map[string]bool{})

		var roleCountBefore, assignmentCountBefore int64
		if err := db.Model(&model.Role{}).Count(&roleCountBefore).Error; err != nil {
			t.Fatalf("count roles: %v", err)
		}
		if err := db.Model(&model.RoleAssignment{}).Count(&assignmentCountBefore).Error; err != nil {
			t.Fatalf("count assignments: %v", err)
		}

		tests := []struct {
			name   string
			method string
			path   string
			body   string
		}{
			{name: "create", method: http.MethodPost, path: "/roles", body: `{"name":"blocked"}`},
			{name: "update", method: http.MethodPut, path: "/roles/1", body: `{"name":"blocked"}`},
			{name: "delete", method: http.MethodDelete, path: "/roles/1"},
			{name: "assign", method: http.MethodPost, path: "/roles/1/assign", body: `{"subjectType":"user","subject":"alice"}`},
			{name: "unassign", method: http.MethodDelete, path: "/roles/1/assign?subjectType=user&subject=alice"},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				response := perform(test.method, test.path, test.body)
				if response.Code != http.StatusForbidden {
					t.Fatalf("returned %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
				}
			})
		}

		var roleCountAfter, assignmentCountAfter int64
		if err := db.Model(&model.Role{}).Count(&roleCountAfter).Error; err != nil {
			t.Fatalf("count roles after requests: %v", err)
		}
		if err := db.Model(&model.RoleAssignment{}).Count(&assignmentCountAfter).Error; err != nil {
			t.Fatalf("count assignments after requests: %v", err)
		}
		if roleCountAfter != roleCountBefore || assignmentCountAfter != assignmentCountBefore {
			t.Fatalf("managed requests changed database: roles %d -> %d, assignments %d -> %d", roleCountBefore, roleCountAfter, assignmentCountBefore, assignmentCountAfter)
		}
	})

	t.Run("protected roles are immutable", func(t *testing.T) {
		protectedRole := model.Role{
			Name:        model.DefaultSecurityAdminRole.Name,
			Description: "security admin",
			IsSystem:    true,
			Clusters:    model.SliceString{"*"},
			Namespaces:  model.SliceString{"*"},
			Resources:   model.SliceString{"*"},
			Verbs:       model.SliceString{"*"},
		}
		if err := db.Create(&protectedRole).Error; err != nil {
			t.Fatalf("create protected role: %v", err)
		}
		rolePath := "/roles/" + strconv.FormatUint(uint64(protectedRole.ID), 10)

		// 等保三员角色的定义就是三权分立本身：连“保持名称、改规则”也不允许。
		response := perform(http.MethodPut, rolePath, `{"name":"security-admin","description":"weakened","clusters":["dev"],"namespaces":["dev"],"resources":["pods"],"verbs":["get"]}`)
		if response.Code != http.StatusForbidden {
			t.Fatalf("update returned %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
		}

		var stored model.Role
		if err := db.First(&stored, protectedRole.ID).Error; err != nil {
			t.Fatalf("load protected role: %v", err)
		}
		if stored.Description != protectedRole.Description || len(stored.Resources) != 1 || stored.Resources[0] != "*" {
			t.Fatalf("protected role changed: %#v", stored)
		}

		response = perform(http.MethodDelete, rolePath, "")
		if response.Code != http.StatusForbidden {
			t.Fatalf("delete returned %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
		}
	})

	t.Run("reserved role names cannot be reused", func(t *testing.T) {
		// 最高权限角色是系统管理员（受保护、不可删），已退休的 super-admin 也不得再用：
		// 同名自定义角色会被误认为内置的最高权限入口；其余受保护内置角色同样不得冒名。
		for _, name := range []string{
			model.DefaultAdminRole.Name,
			model.SuperRoleName,
			model.DefaultClusterAdminRole.Name,
			model.DefaultClusterViewerRole.Name,
		} {
			body := `{"name":"` + name + `","clusters":["*"],"namespaces":["*"],"resources":["pods"],"verbs":["get"]}`
			response := perform(http.MethodPost, "/roles", body)
			if response.Code != http.StatusConflict {
				t.Fatalf("creating %q returned %d, want %d; body=%s", name, response.Code, http.StatusConflict, response.Body.String())
			}
		}
	})

	t.Run("viewer role is also protected from deletion and modification", func(t *testing.T) {
		if err := model.InitDefaultRole(); err != nil {
			t.Fatalf("init default roles: %v", err)
		}
		viewerRole, err := model.GetRoleByName(model.DefaultViewerRole.Name)
		if err != nil {
			t.Fatalf("load viewer role: %v", err)
		}
		rolePath := "/roles/" + strconv.FormatUint(uint64(viewerRole.ID), 10)

		// 只读管理员现在也是受保护角色，不允许删除。
		response := perform(http.MethodDelete, rolePath, "")
		if response.Code != http.StatusForbidden {
			t.Fatalf("delete viewer returned %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
		}

		// 只读管理员也不允许修改。
		response = perform(http.MethodPut, rolePath, `{"name":"viewer","description":"hacked","resources":["*"],"verbs":["get"]}`)
		if response.Code != http.StatusForbidden {
			t.Fatalf("update viewer returned %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
		}

		// 验证角色未被删除也未改动。
		var stored model.Role
		if err := db.First(&stored, viewerRole.ID).Error; err != nil {
			t.Fatalf("load viewer after failed delete: %v", err)
		}
		if stored.Description != model.DefaultViewerRole.Description {
			t.Fatalf("viewer description changed: %q", stored.Description)
		}
	})

	// 集群管理员 / 集群只读管理员：随 InitDefaultRole 播种，且同样受保护。
	t.Run("cluster roles are seeded and protected", func(t *testing.T) {
		if err := model.InitDefaultRole(); err != nil {
			t.Fatalf("init default roles: %v", err)
		}
		for _, seeded := range []*model.Role{&model.DefaultClusterAdminRole, &model.DefaultClusterViewerRole} {
			role, err := model.GetRoleByName(seeded.Name)
			if err != nil {
				t.Fatalf("load seeded role %s: %v", seeded.Name, err)
			}
			rolePath := "/roles/" + strconv.FormatUint(uint64(role.ID), 10)

			response := perform(http.MethodPut, rolePath,
				`{"name":"`+seeded.Name+`","description":"weakened","resources":["pods"],"verbs":["get"]}`)
			if response.Code != http.StatusForbidden {
				t.Fatalf("update %s returned %d, want %d; body=%s", seeded.Name, response.Code, http.StatusForbidden, response.Body.String())
			}
			response = perform(http.MethodDelete, rolePath, "")
			if response.Code != http.StatusForbidden {
				t.Fatalf("delete %s returned %d, want %d; body=%s", seeded.Name, response.Code, http.StatusForbidden, response.Body.String())
			}
		}
	})
}
