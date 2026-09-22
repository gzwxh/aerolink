package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupAdminAuditDB(t *testing.T) model.User {
	t.Helper()

	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.ResourceHistory{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	model.DB = db
	t.Cleanup(func() { model.DB = originalDB })

	operator := model.User{Username: "alice", Provider: model.AuthProviderPassword, Enabled: true}
	if err := db.Create(&operator).Error; err != nil {
		t.Fatalf("creating operator: %v", err)
	}
	gin.SetMode(gin.TestMode)
	return operator
}

// runAdminAudit 让一个请求走一遍审计中间件。
func runAdminAudit(t *testing.T, operator model.User, method, path string, status int) {
	t.Helper()

	router := gin.New()
	router.Use(func(c *gin.Context) { c.Set("user", operator) })
	router.Use(AdminAudit())
	router.Any(path, func(c *gin.Context) { c.Status(status) })

	request := httptest.NewRequest(method, path, nil)
	request.Header.Set("User-Agent", "aerolink-test-agent/1.0")
	request.RemoteAddr = "203.0.113.7:51234"
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
}

func auditRows(t *testing.T) []model.ResourceHistory {
	t.Helper()
	var rows []model.ResourceHistory
	if err := model.DB.Order("id").Find(&rows).Error; err != nil {
		t.Fatalf("loading audit rows: %v", err)
	}
	return rows
}

// 管理接口的写操作留痕必须带来源：来源 IP、User-Agent 与操作者用户名快照
// （等保三级安全审计要求审计记录可追溯到发起方）。
func TestAdminAuditRecordsSourceOfChange(t *testing.T) {
	operator := setupAdminAuditDB(t)

	runAdminAudit(t, operator, http.MethodPut, "/api/v1/admin/general-setting", http.StatusOK)

	rows := auditRows(t)
	if len(rows) != 1 {
		t.Fatalf("expected 1 audit row, got %d", len(rows))
	}
	row := rows[0]
	if row.OperationType != "update" {
		t.Fatalf("operationType = %q, want update", row.OperationType)
	}
	if row.ClientIP != "203.0.113.7" {
		t.Fatalf("clientIp = %q, want the request address", row.ClientIP)
	}
	if row.UserAgent != "aerolink-test-agent/1.0" {
		t.Fatalf("userAgent = %q, want the request User-Agent", row.UserAgent)
	}
	if row.OperatorName != "alice" {
		t.Fatalf("operatorName = %q, want the username snapshot", row.OperatorName)
	}
	if row.OperatorID == nil || *row.OperatorID != operator.ID {
		t.Fatalf("operatorId = %v, want %d", row.OperatorID, operator.ID)
	}
	if !row.Success {
		t.Fatal("a 2xx response should be recorded as success")
	}
}

// 读审计日志本身要留痕（谁查了审计记录），被拒绝的查询也要记（Success=false）。
func TestAdminAuditTracesAuditLogReads(t *testing.T) {
	operator := setupAdminAuditDB(t)

	runAdminAudit(t, operator, http.MethodGet, "/api/v1/admin/audit-logs", http.StatusOK)
	runAdminAudit(t, operator, http.MethodGet, "/api/v1/admin/login-logs", http.StatusOK)
	runAdminAudit(t, operator, http.MethodGet, "/api/v1/admin/password-change-logs", http.StatusForbidden)

	rows := auditRows(t)
	if len(rows) != 3 {
		t.Fatalf("expected 3 audit rows, got %d", len(rows))
	}
	wantTypes := []string{"system/audit-log", "system/login-log", "system/password-change-log"}
	for i, row := range rows {
		if row.OperationType != adminAuditReadOperation {
			t.Fatalf("row %d operationType = %q, want %q", i, row.OperationType, adminAuditReadOperation)
		}
		if row.ResourceType != wantTypes[i] {
			t.Fatalf("row %d resourceType = %q, want %q", i, row.ResourceType, wantTypes[i])
		}
	}
	if rows[2].Success {
		t.Fatal("a 403 response must be recorded as a failed attempt")
	}
}

// 其它管理接口的 GET 不写操作日志：否则浏览设置页就会把审计日志淹掉。
func TestAdminAuditIgnoresOtherReads(t *testing.T) {
	operator := setupAdminAuditDB(t)

	runAdminAudit(t, operator, http.MethodGet, "/api/v1/admin/users", http.StatusOK)
	runAdminAudit(t, operator, http.MethodGet, "/api/v1/admin/general-setting", http.StatusOK)

	if rows := auditRows(t); len(rows) != 0 {
		t.Fatalf("expected no audit rows for ordinary reads, got %d", len(rows))
	}
}

// 管理路由挂在 common.Base 之下（见 main.buildEngine）：设了 AEROLINK_BASE 时前缀匹配
// 必须先把 base 剥掉，否则管理端写操作与审计读取都会漏审计。
func TestAdminAuditRespectsBasePath(t *testing.T) {
	operator := setupAdminAuditDB(t)
	originalBase := common.Base
	common.Base = "/aerolink"
	t.Cleanup(func() { common.Base = originalBase })

	runAdminAudit(t, operator, http.MethodPut, "/aerolink/api/v1/admin/general-setting", http.StatusOK)
	runAdminAudit(t, operator, http.MethodGet, "/aerolink/api/v1/admin/audit-logs", http.StatusOK)
	// base 之下的普通资源写操作不属于管理接口，不该被记。
	runAdminAudit(t, operator, http.MethodPut, "/aerolink/api/v1/pods/default", http.StatusOK)

	rows := auditRows(t)
	if len(rows) != 2 {
		t.Fatalf("expected 2 admin audit rows under AEROLINK_BASE, got %d", len(rows))
	}
	if rows[0].OperationType != "update" || rows[0].ResourceType != "system/general-setting" {
		t.Fatalf("row 0 = %q/%q, want update/system/general-setting", rows[0].OperationType, rows[0].ResourceType)
	}
	if rows[1].OperationType != adminAuditReadOperation || rows[1].ResourceType != "system/audit-log" {
		t.Fatalf("row 1 = %q/%q, want %s/system/audit-log",
			rows[1].OperationType, rows[1].ResourceType, adminAuditReadOperation)
	}
}
