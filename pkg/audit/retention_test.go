package audit

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupRetentionTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(
		&model.User{},
		&model.ResourceHistory{},
		&model.LoginRecord{},
		&model.PasswordChangeLog{},
		&model.AuditSetting{},
	); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	model.DB = db
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { model.DB = originalDB })
	return db
}

// 保留天数要么是 0（永久保留），要么不低于 30 天；非法取值必须被拒绝而不是静默夹取。
func TestAuditRetentionValidation(t *testing.T) {
	setupRetentionTestDB(t)

	cases := []struct {
		days    int
		wantErr bool
	}{
		{0, false},  // 永久保留（默认）
		{30, false}, // 下限
		{180, false},
		{1, true},
		{29, true},
		{-5, true},
	}
	for _, tc := range cases {
		data := model.DefaultAuditSettingData()
		data.RetentionDays = tc.days
		_, err := model.UpdateAuditSetting(data)
		if tc.wantErr != (err != nil) {
			t.Fatalf("RetentionDays=%d: err=%v, wantErr=%v", tc.days, err, tc.wantErr)
		}
	}
}

// 保留策略只按时间自动滚动删除：0 天时一条不动，配置了天数才删过期记录，
// 并且删除动作本身要留一条审计记录（等保三级要求能看到"谁按什么策略删了多少"）。
func TestPruneExpiredAuditRecords(t *testing.T) {
	setupRetentionTestDB(t)
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)

	seed := func(createdAt time.Time) {
		row := model.ResourceHistory{
			ResourceType: "pods", ResourceName: "web", OperationType: "update", Success: true,
		}
		row.CreatedAt = createdAt
		if err := model.DB.Create(&row).Error; err != nil {
			t.Fatalf("seeding audit record: %v", err)
		}
	}
	seed(now.AddDate(0, 0, -200)) // 过期
	seed(now.AddDate(0, 0, -120)) // 过期（保留 90 天时 120 天前的记录应被清掉）
	seed(now.AddDate(0, 0, -10))  // 保留

	login := model.LoginRecord{Username: "alice", Provider: "password", IP: "203.0.113.1"}
	login.CreatedAt = now.AddDate(0, 0, -100)
	if err := model.DB.Create(&login).Error; err != nil {
		t.Fatalf("seeding login record: %v", err)
	}
	change := model.PasswordChangeLog{Username: "alice", Source: "self"}
	change.CreatedAt = now.AddDate(0, 0, -100)
	if err := model.DB.Create(&change).Error; err != nil {
		t.Fatalf("seeding password change record: %v", err)
	}

	// 默认（0 天）：永久保留，一条都不能删。
	if deleted := PruneExpiredAuditRecords(now); deleted != 0 {
		t.Fatalf("retention 0 must keep everything, deleted %d", deleted)
	}

	// 改为 90 天：三张表里的过期记录都要被清掉。
	setting := model.DefaultAuditSettingData()
	setting.RetentionDays = 90
	if _, err := model.UpdateAuditSetting(setting); err != nil {
		t.Fatalf("saving retention: %v", err)
	}
	deleted := PruneExpiredAuditRecords(now)
	// 2 条过期操作日志 + 1 条登录日志 + 1 条改密日志
	if deleted != 4 {
		t.Fatalf("deleted = %d, want 4", deleted)
	}

	var histories int64
	model.DB.Model(&model.ResourceHistory{}).Where("resource_type = ?", "pods").Count(&histories)
	if histories != 1 {
		t.Fatalf("expected the 10-day-old record to survive, got %d pod records", histories)
	}
	for _, table := range []struct {
		name  string
		model interface{}
	}{
		{"login_records", &model.LoginRecord{}},
		{"password_change_logs", &model.PasswordChangeLog{}},
	} {
		var count int64
		model.DB.Model(table.model).Count(&count)
		if count != 0 {
			t.Fatalf("%s should have been pruned, got %d", table.name, count)
		}
	}

	// 删除动作本身留痕。
	var pruned int64
	model.DB.Model(&model.ResourceHistory{}).
		Where("resource_type = ? AND operation_type = ?", "system/audit-retention", "prune").
		Count(&pruned)
	if pruned != 1 {
		t.Fatalf("expected the retention run to record itself, got %d", pruned)
	}
}

// 导出与列表共用同一套过滤条件：时间范围生效，条目数与时间范围放进响应头。
// 保留策略的后台循环必须随 ctx 退出：它是唯一没有上下文的后台协程，
// 进程关闭时只能被直接杀掉（顺带把「正在跑的清理事务」留在半途）。
func TestRetentionLoopStopsOnContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// 故意给一个很长的首次延迟：只有 ctx 能把它叫醒。
		runRetentionLoop(ctx, time.Hour, time.Hour)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runRetentionLoop ignored ctx cancellation")
	}
}

func TestExportAuditLogsCSV(t *testing.T) {
	setupRetentionTestDB(t)
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)

	for i, days := range []int{-1, -10, -100} {
		row := model.ResourceHistory{
			ResourceType:  "pods",
			ResourceName:  "web-" + string(rune('a'+i)),
			OperationType: "update",
			OperatorName:  "alice",
			ClientIP:      "203.0.113.7",
			Success:       true,
		}
		row.CreatedAt = now.AddDate(0, 0, days)
		if err := model.DB.Create(&row).Error; err != nil {
			t.Fatalf("seeding audit record: %v", err)
		}
	}

	router := gin.New()
	router.GET("/api/v1/admin/audit-logs/export", ExportAuditLogs)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-logs/export?from="+now.AddDate(0, 0, -20).Format("2006-01-02"), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("export status = %d body %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("X-Audit-Row-Count"); got != "2" {
		t.Fatalf("X-Audit-Row-Count = %q, want 2", got)
	}
	if got := recorder.Header().Get("X-Audit-Time-Range"); !strings.Contains(got, "/") {
		t.Fatalf("X-Audit-Time-Range = %q, want from/to", got)
	}
	if ct := recorder.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("Content-Type = %q, want text/csv", ct)
	}
	if cd := recorder.Header().Get("Content-Disposition"); !strings.Contains(cd, ".csv") {
		t.Fatalf("Content-Disposition = %q, want a .csv attachment", cd)
	}

	// 完整性指纹：sha256 必须等于响应体本身的摘要，接收方才能用 `sha256sum 文件` 核对。
	body := recorder.Body.String()
	digest := sha256.Sum256([]byte(body))
	if want := hex.EncodeToString(digest[:]); recorder.Header().Get("X-Audit-Content-SHA256") != want {
		t.Fatalf("X-Audit-Content-SHA256 = %q, want %q", recorder.Header().Get("X-Audit-Content-SHA256"), want)
	}
	// HMAC 必须与摘要不同（不同密钥与算法），且非空。
	if mac := recorder.Header().Get("X-Audit-Content-HMAC"); len(mac) != 64 || mac == recorder.Header().Get("X-Audit-Content-SHA256") {
		t.Fatalf("X-Audit-Content-HMAC = %q, want a distinct 64-char digest", mac)
	}

	body = strings.TrimPrefix(body, "\ufeff")
	rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil {
		t.Fatalf("parsing CSV: %v", err)
	}
	if len(rows) != 3 { // 表头 + 2 条时间范围内的记录
		t.Fatalf("CSV rows = %d, want 3", len(rows))
	}
	if rows[0][0] != "time" || rows[0][11] != "userAgent" {
		t.Fatalf("unexpected CSV header: %v", rows[0])
	}
	if rows[1][1] != "alice" || rows[1][10] != "203.0.113.7" {
		t.Fatalf("unexpected CSV row: %v", rows[1])
	}
}
