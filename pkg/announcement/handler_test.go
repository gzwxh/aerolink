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
	// 同一时间只展示一条：优先级同为 0 时按 id 降序，取后创建的「已在窗口内」。
	want := []string{"已在窗口内"}
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

// 历史数据可能留有多条启用（旧版本允许多条同时生效）：顶栏只展示优先级最高的那条，
// 同优先级取后创建的一条，不能把顶栏撑成多条内容。
func TestActiveAnnouncementsPicksOneByPriorityThenID(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)

	mustCreate(t, model.Announcement{Title: "低", Content: "x", Enabled: true, Priority: 0})
	mustCreate(t, model.Announcement{Title: "高A", Content: "x", Enabled: true, Priority: 10})
	mustCreate(t, model.Announcement{Title: "高B", Content: "x", Enabled: true, Priority: 10})

	got := activeAnnouncementTitles(t, r)
	if !equalTitles(got, []string{"高B"}) {
		t.Fatalf("active titles = %v, want only priority desc then id desc top one", got)
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
		{"标题与内容都空", map[string]any{"title": "  ", "content": "  "}, "标题和内容不能同时为空"},
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

// 标题是可选项：只写内容也要能发出去（横幅只展示内容，列表用内容片段顶上）。
// 空白标题按「没填」处理，落库空串而不是一串空格。
func TestCreateAnnouncementWithoutTitle(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(&model.User{Model: model.Model{ID: 7}, Username: "ops"})

	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"不带 title 字段", map[string]any{"content": "今晚停服", "enabled": true}},
		{"title 是空白串", map[string]any{"title": "   ", "content": "今晚停服", "enabled": true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := doJSON(t, r, http.MethodPost, "/items", tc.body)
			if rec.Code != http.StatusCreated {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusCreated, rec.Body.String())
			}
			var created model.Announcement
			if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
				t.Fatalf("decoding response: %v", err)
			}
			if created.Title != "" {
				t.Fatalf("title = %q, want 空串", created.Title)
			}
			if created.Content != "今晚停服" {
				t.Fatalf("content = %q, want 今晚停服", created.Content)
			}
		})
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

// 滚动速度 / 每轮停留 / 显示时长同样是可配置项：
// 不带这三个字段时必须落回升级前写死的默认值（60px/s、停留 2 秒、时长自动），
// 显式传值时要真的写进库（覆盖式 PUT 也要带上，否则一次行内改动就会把它们重置）。
func TestAnnouncementScrollParamsConfigurable(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(&model.User{Model: model.Model{ID: 7}, Username: "ops"})

	defaulted := doJSON(t, r, http.MethodPost, "/items", map[string]any{
		"title": "默认参数", "content": "x", "enabled": true,
	})
	if defaulted.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body %s)", defaulted.Code, http.StatusCreated, defaulted.Body.String())
	}
	var first model.Announcement
	if err := json.Unmarshal(defaulted.Body.Bytes(), &first); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if first.ScrollSpeed != model.AnnouncementDefaultScrollSpeed {
		t.Fatalf("scrollSpeed = %d, want %d", first.ScrollSpeed, model.AnnouncementDefaultScrollSpeed)
	}
	if first.PauseSeconds != model.AnnouncementDefaultPauseSeconds {
		t.Fatalf("pauseSeconds = %d, want %d", first.PauseSeconds, model.AnnouncementDefaultPauseSeconds)
	}
	if first.DisplaySeconds != 0 {
		t.Fatalf("displaySeconds = %d, want 0（自动）", first.DisplaySeconds)
	}

	custom := doJSON(t, r, http.MethodPost, "/items", map[string]any{
		"title": "自定义参数", "content": "x", "enabled": true,
		"scrollMode": "paced", "scrollSpeed": 40, "pauseSeconds": 5, "displaySeconds": 30,
	})
	if custom.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body %s)", custom.Code, http.StatusCreated, custom.Body.String())
	}
	var second model.Announcement
	if err := json.Unmarshal(custom.Body.Bytes(), &second); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	// 回读一遍：确认真的落库了，而不只是响应里对（GORM 的 default 标签会跳过零值）。
	var stored model.Announcement
	if err := model.DB.First(&stored, second.ID).Error; err != nil {
		t.Fatalf("reloading announcement: %v", err)
	}
	if stored.ScrollSpeed != 40 || stored.PauseSeconds != 5 || stored.DisplaySeconds != 30 {
		t.Fatalf("stored params = %d/%d/%d, want 40/5/30",
			stored.ScrollSpeed, stored.PauseSeconds, stored.DisplaySeconds)
	}

	// 改成别的值：覆盖式 PUT 必须把三个参数一起写进去。
	rec := doJSON(t, r, http.MethodPut, fmt.Sprintf("/items/%d", second.ID), map[string]any{
		"title": "自定义参数", "content": "x", "enabled": true,
		"scrollMode": "paced", "scrollSpeed": 120, "pauseSeconds": 1, "displaySeconds": 0,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if err := model.DB.First(&stored, second.ID).Error; err != nil {
		t.Fatalf("reloading announcement: %v", err)
	}
	if stored.ScrollSpeed != 120 || stored.PauseSeconds != 1 || stored.DisplaySeconds != 0 {
		t.Fatalf("stored params = %d/%d/%d, want 120/1/0",
			stored.ScrollSpeed, stored.PauseSeconds, stored.DisplaySeconds)
	}
}

// 越界一律显式报错，不做「悄悄夹到边界值」：管理员得知道自己填的值没被采纳。
func TestAnnouncementScrollParamsValidation(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(&model.User{Model: model.Model{ID: 7}, Username: "ops"})

	cases := []struct {
		name    string
		body    map[string]any
		wantMsg string
	}{
		{"速度过慢", map[string]any{"scrollSpeed": model.AnnouncementScrollSpeedMin - 1}, "滚动速度需在"},
		{"速度过快", map[string]any{"scrollSpeed": model.AnnouncementScrollSpeedMax + 1}, "滚动速度需在"},
		{"停留为 0", map[string]any{"pauseSeconds": 0}, "每轮停留需在"},
		{"停留过长", map[string]any{"pauseSeconds": model.AnnouncementPauseSecondsMax + 1}, "每轮停留需在"},
		{"显示时长过短", map[string]any{"displaySeconds": model.AnnouncementDisplaySecondsMin - 1}, "显示时长需在"},
		{"显示时长过长", map[string]any{"displaySeconds": model.AnnouncementDisplaySecondsMax + 1}, "显示时长需在"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{"title": "t", "content": "x", "enabled": true}
			for key, value := range tc.body {
				body[key] = value
			}
			rec := doJSON(t, r, http.MethodPost, "/items", body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantMsg) {
				t.Fatalf("body %s does not mention %q", rec.Body.String(), tc.wantMsg)
			}
		})
	}
}

// 允许存多条公告，但同一时间只能有一条启用：新建时设成启用，必须把原来那条停掉，
// 而不是让两条都「启用」、只在读取时挑一条。
func TestCreateEnabledAnnouncementDisablesOthers(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)
	previous := mustCreate(t, model.Announcement{Title: "旧公告", Content: "x", Enabled: true})
	backup := mustCreate(t, model.Announcement{Title: "备用", Content: "x", Enabled: false})

	rec := doJSON(t, r, http.MethodPost, "/items", map[string]any{
		"title": "新公告", "content": "x", "enabled": true,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if got := activeAnnouncementTitles(t, r); !equalTitles(got, []string{"新公告"}) {
		t.Fatalf("active titles = %v, want only the new one", got)
	}

	var stored model.Announcement
	if err := model.DB.First(&stored, previous.ID).Error; err != nil {
		t.Fatalf("reloading the previous announcement: %v", err)
	}
	if stored.Enabled {
		t.Fatalf("previous announcement is still enabled, want disabled")
	}
	// 原本就停用的公告不受影响：新建一条启用公告只需要顶掉当前那条。
	var backupStored model.Announcement
	if err := model.DB.First(&backupStored, backup.ID).Error; err != nil {
		t.Fatalf("reloading the backup announcement: %v", err)
	}
	if backupStored.Enabled {
		t.Fatalf("a disabled announcement must stay disabled")
	}
}

// 把一条公告改成启用时同样只能留下这一条；全部停用是允许的（通知栏空着）。
func TestUpdateEnabledAnnouncementDisablesOthers(t *testing.T) {
	setupAnnouncementTestDB(t)
	r := newTestRouter(nil)
	current := mustCreate(t, model.Announcement{Title: "当前", Content: "x", Enabled: true})
	next := mustCreate(t, model.Announcement{Title: "下一条", Content: "x", Enabled: false})

	rec := doJSON(t, r, http.MethodPut, fmt.Sprintf("/items/%d", next.ID), map[string]any{
		"title": "下一条", "content": "x", "enabled": true,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := activeAnnouncementTitles(t, r); !equalTitles(got, []string{"下一条"}) {
		t.Fatalf("active titles = %v, want only the edited one", got)
	}
	var stored model.Announcement
	if err := model.DB.First(&stored, current.ID).Error; err != nil {
		t.Fatalf("reloading the previous announcement: %v", err)
	}
	if stored.Enabled {
		t.Fatalf("previous announcement is still enabled, want disabled")
	}

	rec = doJSON(t, r, http.MethodPut, fmt.Sprintf("/items/%d", next.ID), map[string]any{
		"title": "下一条", "content": "x", "enabled": false,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := activeAnnouncementTitles(t, r); len(got) != 0 {
		t.Fatalf("active titles = %v, want empty", got)
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
