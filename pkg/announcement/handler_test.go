package announcement

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupAnnouncementTestDB(t *testing.T) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&model.Announcement{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	previous := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = previous })
}

// newTestRouter 注册处理函数；user 非 nil 时模拟鉴权中间件写入的当前账号
// （创建者字段就取自这个上下文键）。
func newTestRouter(user *model.User) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		if user != nil {
			c.Set("user", *user)
		}
	})
	r.GET("/active", HandleListActiveAnnouncements)
	r.GET("/all", HandleListAnnouncements)
	r.POST("/items", HandleCreateAnnouncement)
	r.PUT("/items/:id", HandleUpdateAnnouncement)
	r.DELETE("/items/:id", HandleDeleteAnnouncement)
	return r
}

func doJSON(t *testing.T, r *gin.Engine, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encoding request body: %v", err)
		}
		payload = encoded
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func mustCreate(t *testing.T, item model.Announcement) model.Announcement {
	t.Helper()
	if item.Level == "" {
		item.Level = model.AnnouncementLevelInfo
	}
	if err := model.DB.Create(&item).Error; err != nil {
		t.Fatalf("seeding announcement: %v", err)
	}
	return item
}

func activeAnnouncementTitles(t *testing.T, r *gin.Engine) []string {
	t.Helper()
	rec := doJSON(t, r, http.MethodGet, "/active", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var payload struct {
		Items []model.Announcement `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	titles := make([]string, 0, len(payload.Items))
	for _, item := range payload.Items {
		titles = append(titles, item.Title)
	}
	return titles
}

func equalTitles(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// 生效窗口由服务端过滤：未开始、已结束、已停用的公告都不能出现在横幅里。
func TestActiveAnnouncementsFilterWindow(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)
	now := time.Now()

	past := now.Add(-time.Hour)
	future := now.Add(time.Hour)
	mustCreate(t, model.Announcement{Title: "立即生效", Content: "x", Enabled: true})
	mustCreate(t, model.Announcement{Title: "已在窗口内", Content: "x", Enabled: true, StartAt: &past, EndAt: &future})
	mustCreate(t, model.Announcement{Title: "尚未开始", Content: "x", Enabled: true, StartAt: &future})
	mustCreate(t, model.Announcement{Title: "已经结束", Content: "x", Enabled: true, EndAt: &past})
	mustCreate(t, model.Announcement{Title: "已停用", Content: "x", Enabled: false})

	got := activeAnnouncementTitles(t, r)
	// 优先级同为 0，按 id 降序 → 后创建的「已在窗口内」在前。
	want := []string{"已在窗口内", "立即生效"}
	if !equalTitles(got, want) {
		t.Fatalf("active titles = %v, want %v", got, want)
	}
}

// 边界：endAt 已过（哪怕只过 1 毫秒）就不再出现；startAt 已到（哪怕刚到）就出现。
// 处理函数里的 now 必然晚于测试里的 now，因此这两个断言是确定的，不是竞态。
func TestActiveAnnouncementsWindowBoundaries(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)
	now := time.Now()

	justStarted := now.Add(-time.Millisecond)
	justEnded := now.Add(-time.Millisecond)
	mustCreate(t, model.Announcement{Title: "刚开始", Content: "x", Enabled: true, StartAt: &justStarted})
	mustCreate(t, model.Announcement{Title: "刚结束", Content: "x", Enabled: true, EndAt: &justEnded})

	got := activeAnnouncementTitles(t, r)
	if !equalTitles(got, []string{"刚开始"}) {
		t.Fatalf("active titles = %v, want only the just-started one", got)
	}
}

func TestActiveAnnouncementsSortByPriorityThenID(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)

	mustCreate(t, model.Announcement{Title: "低", Content: "x", Enabled: true, Priority: 0})
	mustCreate(t, model.Announcement{Title: "高A", Content: "x", Enabled: true, Priority: 10})
	mustCreate(t, model.Announcement{Title: "高B", Content: "x", Enabled: true, Priority: 10})

	got := activeAnnouncementTitles(t, r)
	if !equalTitles(got, []string{"高B", "高A", "低"}) {
		t.Fatalf("active titles = %v, want priority desc then id desc", got)
	}
}

func TestCreateAnnouncementValidatesInput(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(&model.User{Model: model.Model{ID: 7}, Username: "ops"})
	future := time.Now().Add(time.Hour).Format("2006-01-02T15:04:05")
	past := time.Now().Add(-time.Hour).Format("2006-01-02T15:04:05")

	cases := []struct {
		name    string
		body    map[string]any
		wantMsg string
	}{
		{"标题为空", map[string]any{"title": "   ", "content": "x"}, "请填写标题"},
		{"内容为空", map[string]any{"title": "t", "content": "  "}, "请填写内容"},
		{"标题过长", map[string]any{"title": strings.Repeat("字", 256), "content": "x"}, "标题过长"},
		{"内容过长", map[string]any{"title": "t", "content": strings.Repeat("字", model.AnnouncementMaxContentLength+1)}, "内容过长"},
		{"级别非法", map[string]any{"title": "t", "content": "x", "level": "rainbow"}, "级别不合法"},
		{"优先级为负", map[string]any{"title": "t", "content": "x", "priority": -1}, "优先级不能为负数"},
		{"时间格式非法", map[string]any{"title": "t", "content": "x", "startAt": "明天"}, "生效时间格式不合法"},
		{"结束早于开始", map[string]any{"title": "t", "content": "x", "startAt": future, "endAt": past}, "结束时间必须晚于生效时间"},
		{"起止相同", map[string]any{"title": "t", "content": "x", "startAt": future, "endAt": future}, "结束时间必须晚于生效时间"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doJSON(t, r, http.MethodPost, "/items", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantMsg) {
				t.Fatalf("body %s does not mention %q", rec.Body.String(), tc.wantMsg)
			}
		})
	}

	// 合法请求：多出来的空白被裁掉，级别留空回落 info，创建者来自当前账号。
	rec := doJSON(t, r, http.MethodPost, "/items", map[string]any{
		"title": "  维护通知  ", "content": "  今晚停服  ", "enabled": true,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusCreated, rec.Body.String())
	}
	var created model.Announcement
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if created.Title != "维护通知" || created.Content != "今晚停服" {
		t.Fatalf("created = %+v, want trimmed title/content", created)
	}
	if created.Level != model.AnnouncementLevelInfo {
		t.Fatalf("level = %q, want %q", created.Level, model.AnnouncementLevelInfo)
	}
	if created.CreatorID != 7 {
		t.Fatalf("creatorId = %d, want 7", created.CreatorID)
	}
}

// scroll 是可配置项：请求里不带时必须默认滚动（不带该字段的老客户端观感不变），
// 显式传 false 要能真的写进库（模型上不能声明 gorm default，否则零值会被 Create 跳过）。
func TestAnnouncementScrollConfigurable(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(&model.User{Model: model.Model{ID: 7}, Username: "ops"})

	defaulted := doJSON(t, r, http.MethodPost, "/items", map[string]any{
		"title": "默认滚动", "content": "x", "enabled": true,
	})
	if defaulted.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body %s)", defaulted.Code, http.StatusCreated, defaulted.Body.String())
	}
	var first model.Announcement
	if err := json.Unmarshal(defaulted.Body.Bytes(), &first); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if !first.Scroll {
		t.Fatalf("scroll = false, want true（未传该字段时应当默认滚动）")
	}

	disabled := doJSON(t, r, http.MethodPost, "/items", map[string]any{
		"title": "不滚动", "content": "x", "enabled": true, "scroll": false,
	})
	if disabled.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body %s)", disabled.Code, http.StatusCreated, disabled.Body.String())
	}
	var second model.Announcement
	if err := json.Unmarshal(disabled.Body.Bytes(), &second); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if second.Scroll {
		t.Fatalf("scroll = true, want false（显式 false 必须生效）")
	}

	// 回读一遍：确认真的落库了，而不只是响应里对。
	var stored model.Announcement
	if err := model.DB.First(&stored, second.ID).Error; err != nil {
		t.Fatalf("reloading announcement: %v", err)
	}
	if stored.Scroll {
		t.Fatalf("stored scroll = true, want false")
	}
}

// 上限只挡「现在就会出现在横幅里」的公告：排期到将来的、或者先存成停用状态的，
// 都不该被当前的生效条数卡住。
func TestCreateAnnouncementActiveLimit(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)
	for i := 0; i < model.AnnouncementMaxActive; i++ {
		mustCreate(t, model.Announcement{Title: fmt.Sprintf("生效中-%d", i), Content: "x", Enabled: true})
	}

	rec := doJSON(t, r, http.MethodPost, "/items", map[string]any{"title": "第 21 条", "content": "x", "enabled": true})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "上限") {
		t.Fatalf("status = %d body = %s, want 400 with the limit message", rec.Code, rec.Body.String())
	}

	future := time.Now().Add(time.Hour).Format("2006-01-02T15:04:05")
	rec = doJSON(t, r, http.MethodPost, "/items", map[string]any{
		"title": "稍后生效", "content": "x", "enabled": true, "startAt": future,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("scheduled announcement rejected at the limit: %d %s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, r, http.MethodPost, "/items", map[string]any{"title": "停用的", "content": "x", "enabled": false})
	if rec.Code != http.StatusCreated {
		t.Fatalf("disabled announcement rejected at the limit: %d %s", rec.Code, rec.Body.String())
	}
}

// 上限不能把已在生效列表里的公告锁死：否则一旦到达上限，第 20 条就再也改不动了。
func TestUpdateAnnouncementActiveLimitOnlyAppliesWhenBecomingActive(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)
	first := mustCreate(t, model.Announcement{Title: "生效中-0", Content: "x", Enabled: true})
	for i := 1; i < model.AnnouncementMaxActive; i++ {
		mustCreate(t, model.Announcement{Title: fmt.Sprintf("生效中-%d", i), Content: "x", Enabled: true})
	}
	scheduled := mustCreate(t, model.Announcement{Title: "稍后生效", Content: "x", Enabled: true, StartAt: ptrTime(time.Now().Add(time.Hour))})

	// 已在生效列表里：允许继续编辑。
	rec := doJSON(t, r, http.MethodPut, fmt.Sprintf("/items/%d", first.ID), map[string]any{
		"title": "生效中-0（改过）", "content": "x", "enabled": true,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("editing an already-active announcement was rejected: %d %s", rec.Code, rec.Body.String())
	}

	// 由「未生效」变成「生效」：会顶破上限，拒绝。
	rec = doJSON(t, r, http.MethodPut, fmt.Sprintf("/items/%d", scheduled.ID), map[string]any{
		"title": "稍后生效（改成立即）", "content": "x", "enabled": true,
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "上限") {
		t.Fatalf("status = %d body = %s, want 400 with the limit message", rec.Code, rec.Body.String())
	}
}

func TestUpdateAnnouncementKeepsCreator(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(&model.User{Model: model.Model{ID: 9}, Username: "someone-else"})
	item := mustCreate(t, model.Announcement{Title: "原标题", Content: "原内容", Enabled: true, CreatorID: 3})

	rec := doJSON(t, r, http.MethodPut, fmt.Sprintf("/items/%d", item.ID), map[string]any{
		"title": "新标题", "content": "新内容", "level": model.AnnouncementLevelDanger, "enabled": false, "priority": 5,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var updated model.Announcement
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if updated.Title != "新标题" || updated.Content != "新内容" {
		t.Fatalf("updated = %+v", updated)
	}
	if updated.Level != model.AnnouncementLevelDanger || updated.Enabled || updated.Priority != 5 {
		t.Fatalf("updated = %+v, want danger/disabled/priority 5", updated)
	}
	// CreatorID 记的是「谁发的」，改内容的人由操作日志留痕，不能被覆盖成当前账号。
	if updated.CreatorID != 3 {
		t.Fatalf("creatorId = %d, want the original 3", updated.CreatorID)
	}
}

// 新建时就处于停用状态的公告，落库必须是停用：GORM 对带 default 标签的布尔字段会跳过
// 零值，很容易把「先存成停用」写成启用（见 model.Announcement 的字段注释）。
func TestCreateDisabledAnnouncementStaysDisabled(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)

	rec := doJSON(t, r, http.MethodPost, "/items", map[string]any{
		"title": "先存成停用", "content": "x", "enabled": false,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	if got := activeAnnouncementTitles(t, r); len(got) != 0 {
		t.Fatalf("active titles = %v, want empty for a disabled announcement", got)
	}
}

// 通知栏弹窗提交的生效时间是带偏移的 RFC3339（前端把本地时间转过去的），
// 而结束时间等字段历史上也可能是无时区的写法：两种都必须能解析。
func TestCreateAnnouncementAcceptsBothTimeFormats(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)

	cases := []struct {
		name  string
		value string
	}{
		{"带偏移的 RFC3339", "2026-09-21T22:00:00+08:00"},
		{"无时区的日期时间", "2026-09-21T22:00:00"},
		{"不带秒", "2026-09-21T22:00"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doJSON(t, r, http.MethodPost, "/items", map[string]any{
				"title": "排期公告", "content": "x", "enabled": true,
				"startAt": tc.value,
			})
			if rec.Code != http.StatusCreated {
				t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
			}
			var created model.Announcement
			if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
				t.Fatalf("decoding response: %v", err)
			}
			if created.StartAt == nil || created.StartAt.Hour() != 22 {
				t.Fatalf("startAt = %v, want 22:00", created.StartAt)
			}
		})
	}
}

func TestAnnouncementNotFound(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)

	rec := doJSON(t, r, http.MethodPut, "/items/4242", map[string]any{"title": "t", "content": "x"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("update status = %d, want 404", rec.Code)
	}
	rec = doJSON(t, r, http.MethodDelete, "/items/4242", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete status = %d, want 404", rec.Code)
	}
	rec = doJSON(t, r, http.MethodDelete, "/items/not-a-number", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("delete status = %d, want 400 for a non-numeric id", rec.Code)
	}
}

func TestDeleteAnnouncementRemovesItFromTheBar(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)
	item := mustCreate(t, model.Announcement{Title: "待删除", Content: "x", Enabled: true})

	if got := activeAnnouncementTitles(t, r); !equalTitles(got, []string{"待删除"}) {
		t.Fatalf("active titles = %v, want the seeded one", got)
	}
	rec := doJSON(t, r, http.MethodDelete, fmt.Sprintf("/items/%d", item.ID), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := activeAnnouncementTitles(t, r); len(got) != 0 {
		t.Fatalf("active titles = %v, want empty after delete", got)
	}
}

// 管理列表要能看到全部（含未生效与已停用），否则管理员没法回来改一条还没开始的公告。
func TestAdminListIncludesInactive(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)
	mustCreate(t, model.Announcement{Title: "生效中", Content: "x", Enabled: true})
	mustCreate(t, model.Announcement{Title: "未开始", Content: "x", Enabled: true, StartAt: ptrTime(time.Now().Add(time.Hour))})
	mustCreate(t, model.Announcement{Title: "已停用", Content: "x", Enabled: false})

	rec := doJSON(t, r, http.MethodGet, "/all", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var payload struct {
		Items []model.Announcement `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(payload.Items) != 3 {
		t.Fatalf("admin list returned %d items, want 3", len(payload.Items))
	}
}

func ptrTime(value time.Time) *time.Time {
	return &value
}

// 删除公告的审计记录必须带标题与快照：只留自增 ID 的话，事后认不出删的是哪条公告。
func TestDeleteAnnouncementRecordsAuditDetail(t *testing.T) {
	setupAnnouncementTestDB(t)
	item := mustCreate(t, model.Announcement{Title: "待删除", Content: "x", Enabled: true})

	var detail common.AdminAuditDetail
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.DELETE("/items/:id", func(c *gin.Context) {
		HandleDeleteAnnouncement(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	rec := doJSON(t, r, http.MethodDelete, fmt.Sprintf("/items/%d", item.ID), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if detail.ResourceName != "待删除" {
		t.Fatalf("audit resourceName = %q, want the announcement title", detail.ResourceName)
	}
	if !strings.Contains(detail.PreviousYAML, "title: 待删除") {
		t.Fatalf("audit snapshot must contain the announcement, got %q", detail.PreviousYAML)
	}
}
