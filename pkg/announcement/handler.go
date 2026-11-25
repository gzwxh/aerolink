// Package announcement 实现顶栏通知栏：管理员发布的公告在这里读写，
// 前端在页面顶端以滚动横幅展示（见 plans/2026-09-21-顶部通知栏.md）。
package announcement

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// maxTitleLength 与模型列宽一致（varchar(255)）：超限时数据库在非严格模式下会静默
// 截断、严格模式下直接报错，两种都不如在这里显式拒绝。
const maxTitleLength = 255

type announcementRequest struct {
	Title    string `json:"title"`
	Content  string `json:"content"`
	Level    string `json:"level"`
	Priority int    `json:"priority"`
	Enabled  bool   `json:"enabled"`
	// Scroll 用指针区分「没传」与「显式传 false」：不带该字段的老客户端应当保持滚动这个
	// 默认行为，而不是把公告改成停住。
	Scroll *bool `json:"scroll"`
	// ScrollMode 是新的三态口径（none / continuous / paced，见 model 的常量）。
	// 两者同时出现时以它为准，写入时会据此同步维护 Scroll。
	ScrollMode *string `json:"scrollMode"`
	// 滚动参数同样是可选项：不带这三个字段的老客户端取默认值，与升级前写死的常量一致，
	// 不会把现有公告的观感改掉。
	ScrollSpeed    *int   `json:"scrollSpeed"`
	PauseSeconds   *int   `json:"pauseSeconds"`
	DisplaySeconds *int   `json:"displaySeconds"`
	StartAt        string `json:"startAt"`
	EndAt          string `json:"endAt"`
}

// HandleListActiveAnnouncements 返回当前生效的公告，供所有登录用户读取。
func HandleListActiveAnnouncements(c *gin.Context) {
	items, err := model.ListActiveAnnouncements(time.Now())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load announcements"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// HandleListAnnouncements 返回全部公告（含未生效、已停用、已过期），供管理界面使用。
func HandleListAnnouncements(c *gin.Context) {
	items, err := model.ListAnnouncements()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load announcements"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func HandleCreateAnnouncement(c *gin.Context) {
	var req announcementRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	item, err := buildAnnouncement(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	item.CreatorID = currentUserID(c)
	// 同一时间只允许一条公告启用：新公告一启用，原来那条自动停用。
	// 两步放在同一个事务里，否则中间失败会留下「两条都启用」或「一条都不启用」的状态。
	// 事务开头先锁定启用集：与启动归一化（MigrateAnnouncementSingleEnabled）互斥，
	// 避免交错后一条启用公告都不剩（见 model.lockEnabledAnnouncementRows）。
	err = model.DB.Transaction(func(tx *gorm.DB) error {
		if err := model.LockEnabledAnnouncements(tx); err != nil {
			return err
		}
		if err := tx.Create(item).Error; err != nil {
			return err
		}
		if !item.Enabled {
			return nil
		}
		return model.DisableOtherAnnouncements(tx, item.ID)
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create announcement"})
		return
	}
	c.JSON(http.StatusCreated, item)
}

func HandleUpdateAnnouncement(c *gin.Context) {
	id, ok := parseID(c)
	if !ok {
		return
	}
	existing, err := model.GetAnnouncement(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "公告不存在"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load announcement"})
		return
	}

	var req announcementRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	updated, err := buildAnnouncement(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existing.Title = updated.Title
	existing.Content = updated.Content
	existing.Level = updated.Level
	existing.Priority = updated.Priority
	existing.Enabled = updated.Enabled
	existing.Scroll = updated.Scroll
	existing.ScrollMode = updated.ScrollMode
	existing.ScrollSpeed = updated.ScrollSpeed
	existing.PauseSeconds = updated.PauseSeconds
	existing.DisplaySeconds = updated.DisplaySeconds
	existing.StartAt = updated.StartAt
	existing.EndAt = updated.EndAt
	// CreatorID 不覆盖：它记的是「谁发的」，改内容的人由操作日志留痕。
	// 同新建：这条一旦是启用状态，就把它之外的公告停用（含编辑前就已启用的旧数据）。
	// 事务开头先锁定启用集：与启动归一化互斥，避免交错后一条启用公告都不剩。
	err = model.DB.Transaction(func(tx *gorm.DB) error {
		if err := model.LockEnabledAnnouncements(tx); err != nil {
			return err
		}
		if err := tx.Save(existing).Error; err != nil {
			return err
		}
		if !existing.Enabled {
			return nil
		}
		return model.DisableOtherAnnouncements(tx, existing.ID)
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save announcement"})
		return
	}
	c.JSON(http.StatusOK, existing)
}

func HandleDeleteAnnouncement(c *gin.Context) {
	id, ok := parseID(c)
	if !ok {
		return
	}
	// 公告的标题就是它的可读标识：只留自增 ID 的话，审计里认不出删掉的是哪条公告。
	var announcement model.Announcement
	if err := model.DB.First(&announcement, id).Error; err == nil {
		c.Set(common.AdminAuditDetailKey, common.AdminAuditDetail{
			ResourceName: announcement.Title,
			PreviousYAML: common.AdminAuditSnapshot(announcement),
		})
	}
	result := model.DB.Delete(&model.Announcement{}, id)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete announcement"})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "公告不存在"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "公告已删除"})
}

// buildAnnouncement 校验并归一化请求体。校验一律显式报错、不用默认值兜底：
// 一条被悄悄改短的公告比一次报错难排查得多。
func buildAnnouncement(req announcementRequest) (*model.Announcement, error) {
	// 标题是可选项：横幅在标题缺席时只展示内容（见 ui/src/components/announcement-bar.tsx），
	// 管理列表则用内容片段顶上，所以这里只校验长度、不要求非空。
	title := strings.TrimSpace(req.Title)
	content := strings.TrimSpace(req.Content)
	// 两者都空 = 一条什么都显示不出来的公告：占着生效名额，用户只看到一个空横幅。
	// 标题可选之后这条单独兜住，文案要能让人知道「填空了」，而不是只猜哪一项不对。
	if title == "" && content == "" {
		return nil, errors.New("标题和内容不能同时为空")
	}
	if len([]rune(title)) > maxTitleLength {
		return nil, errors.New("标题过长（最多 255 字）")
	}
	if content == "" {
		return nil, errors.New("请填写内容")
	}
	if len([]rune(content)) > model.AnnouncementMaxContentLength {
		return nil, errors.New("内容过长（最多 8192 字）")
	}
	level := strings.TrimSpace(req.Level)
	if level == "" {
		level = model.AnnouncementLevelInfo
	}
	if !model.IsAnnouncementLevel(level) {
		return nil, errors.New("级别不合法")
	}
	if req.Priority < 0 {
		return nil, errors.New("优先级不能为负数")
	}

	startAt, err := parseOptionalTime(req.StartAt)
	if err != nil {
		return nil, errors.New("生效时间格式不合法")
	}
	endAt, err := parseOptionalTime(req.EndAt)
	if err != nil {
		return nil, errors.New("结束时间格式不合法")
	}
	if startAt != nil && endAt != nil && !startAt.Before(*endAt) {
		return nil, errors.New("结束时间必须晚于生效时间")
	}

	// 滚动方式：默认连续滚动，与历史行为一致，不带该字段的老客户端不会改变观感。
	// 老客户端只发 scroll(bool)，这里按它的取值翻译成对应方式。
	scrollMode := model.AnnouncementScrollContinuous
	switch {
	case req.ScrollMode != nil:
		scrollMode = strings.TrimSpace(*req.ScrollMode)
	case req.Scroll != nil && !*req.Scroll:
		scrollMode = model.AnnouncementScrollNone
	}
	if !model.IsAnnouncementScrollMode(scrollMode) {
		return nil, errors.New("滚动方式不合法")
	}

	scrollSpeed, err := resolveScrollSpeed(req.ScrollSpeed)
	if err != nil {
		return nil, err
	}
	pauseSeconds, err := resolvePauseSeconds(req.PauseSeconds)
	if err != nil {
		return nil, err
	}
	displaySeconds, err := resolveDisplaySeconds(req.DisplaySeconds)
	if err != nil {
		return nil, err
	}

	return &model.Announcement{
		Title:    title,
		Content:  content,
		Level:    level,
		Priority: req.Priority,
		Enabled:  req.Enabled,
		// Scroll 与 ScrollMode 必须一致：前者是给老客户端读的兼容口径。
		Scroll:         scrollMode != model.AnnouncementScrollNone,
		ScrollMode:     scrollMode,
		ScrollSpeed:    scrollSpeed,
		PauseSeconds:   pauseSeconds,
		DisplaySeconds: displaySeconds,
		StartAt:        startAt,
		EndAt:          endAt,
	}, nil
}

// resolveScrollSpeed 归一化滚动速度：缺省取默认值，越界显式报错（不悄悄夹到边界，
// 否则管理员会以为保存的是自己填的值）。
func resolveScrollSpeed(value *int) (int, error) {
	if value == nil {
		return model.AnnouncementDefaultScrollSpeed, nil
	}
	if *value < model.AnnouncementScrollSpeedMin || *value > model.AnnouncementScrollSpeedMax {
		return 0, fmt.Errorf("滚动速度需在 %d~%d 像素/秒之间",
			model.AnnouncementScrollSpeedMin, model.AnnouncementScrollSpeedMax)
	}
	return *value, nil
}

// resolvePauseSeconds 归一化「每轮停留」：缺省 2 秒；0 不合法（那是「连续滚动」）。
func resolvePauseSeconds(value *int) (int, error) {
	if value == nil {
		return model.AnnouncementDefaultPauseSeconds, nil
	}
	if *value < 1 || *value > model.AnnouncementPauseSecondsMax {
		return 0, fmt.Errorf("每轮停留需在 1~%d 秒之间（不想停留请把滚动方式改成「连续滚动」）",
			model.AnnouncementPauseSecondsMax)
	}
	return *value, nil
}

// resolveDisplaySeconds 归一化「显示时长」：0 表示自动；其余必须落在允许区间内。
func resolveDisplaySeconds(value *int) (int, error) {
	if value == nil || *value == 0 {
		return 0, nil
	}
	if *value < model.AnnouncementDisplaySecondsMin || *value > model.AnnouncementDisplaySecondsMax {
		return 0, fmt.Errorf("显示时长需在 %d~%d 秒之间（0 或留空表示按速度自动计算）",
			model.AnnouncementDisplaySecondsMin, model.AnnouncementDisplaySecondsMax)
	}
	return *value, nil
}

// parseOptionalTime 解析可空时间；空串表示「立即生效 / 永不过期」。
// 前端用 datetime-local，按本地时区取值，可能不带秒。
func parseOptionalTime(value string) (*time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02T15:04"} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return &parsed, nil
		}
	}
	return nil, errors.New("invalid time")
}

func parseID(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return 0, false
	}
	return uint(id), true
}

// currentUserID 取自鉴权中间件写入上下文的当前账号（键为 "user"，见 pkg/auth）。
// 取不到时返回 0：CreatorID 只用于界面展示与追责便利，不该阻断发布。
func currentUserID(c *gin.Context) uint {
	value, exists := c.Get("user")
	if !exists {
		return 0
	}
	user, ok := value.(model.User)
	if !ok {
		return 0
	}
	return user.ID
}
