package notification

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

// templateVariables 记录每个事件可用的占位符，
// 便于模板编辑器把它们列出来。
var templateVariables = map[string][]string{
	model.NotificationEventRemoteLogin:          {"username", "ip", "time", "provider", "userAgent"},
	model.NotificationEventPasswordExpiring:     {"username", "days", "expireDate"},
	model.NotificationEventPasswordExpired:      {"username", "expireDate"},
	model.NotificationEventInactiveUserDisabled: {"username", "days"},
	model.NotificationEventTest:                 {"time"},
	model.NotificationEventPasswordResetByAdmin: {"username", "operator", "time"},
	model.NotificationEventAccountDisabled:      {"username", "operator", "time"},
	model.NotificationEventAccountEnabled:       {"username", "operator", "time"},
	model.NotificationEventAccountExpiring:      {"username", "days", "expireDate"},
	model.NotificationEventRoleAssigned:         {"username", "role", "time"},
	model.NotificationEventRoleUnassigned:       {"username", "role", "time"},
	model.NotificationEventMailDeliveryFailed:   {"time", "address", "event", "reason"},
}

type updateNotificationSettingRequest struct {
	model.NotificationSettingData
	// SMTPPassword 只在有值时写入，因此留空会保留
	// 已保存的口令。
	SMTPPassword *string `json:"smtpPassword"`
	// ClearSMTPPassword 清除已保存的口令。
	ClearSMTPPassword bool `json:"clearSmtpPassword"`
}

func notificationSettingPayload(setting *model.NotificationSettingData) gin.H {
	return gin.H{
		"setting":                setting,
		"smtpPasswordConfigured": model.HasNotificationSMTPPassword(),
	}
}

// HandleGetNotificationSetting 返回通知配置。
//
// 路由：GET /api/v1/admin/notification-setting/（仅管理员）。
func HandleGetNotificationSetting(c *gin.Context) {
	setting, err := model.GetNotificationSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load notification setting"})
		return
	}
	c.JSON(http.StatusOK, notificationSettingPayload(setting))
}

// HandleUpdateNotificationSetting 保存通知配置。
//
// 路由：PUT /api/v1/admin/notification-setting/（仅管理员）。
func HandleUpdateNotificationSetting(c *gin.Context) {
	var request updateNotificationSettingRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	setting, err := model.UpdateNotificationSetting(request.NotificationSettingData)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save notification setting"})
		return
	}
	switch {
	case request.ClearSMTPPassword:
		if err := model.SetNotificationSMTPPassword(""); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to clear SMTP password"})
			return
		}
	case request.SMTPPassword != nil && *request.SMTPPassword != "":
		if err := model.SetNotificationSMTPPassword(*request.SMTPPassword); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save SMTP password"})
			return
		}
	}
	c.JSON(http.StatusOK, notificationSettingPayload(setting))
}

// HandleRunDailyChecks 按需执行每日通知任务：密码过期提醒
// 以及自动停用长期不活跃的账号。
//
// 路由：POST /api/v1/admin/notification-setting/run-daily-checks（仅管理员）。
func HandleRunDailyChecks(c *gin.Context) {
	RunDailyChecks()
	c.JSON(http.StatusOK, gin.H{"message": "每日检查已执行"})
}

// HandleSendTestNotification 用已保存的配置发送一封测试邮件。
//
// 路由：POST /api/v1/admin/notification-setting/test-mail（仅管理员）。
func HandleSendTestNotification(c *gin.Context) {
	var request struct {
		To string `json:"to"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	recipient := strings.TrimSpace(request.To)
	if recipient == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请填写收件人邮箱"})
		return
	}

	variables := map[string]string{"time": time.Now().Format(timeLayout)}
	subject := "[Kite] 通知测试邮件"
	body := RenderTemplate("这是一封来自 Kite 的测试邮件。\n\n发送时间：{{time}}\n", variables)
	if template, err := model.GetNotificationTemplate(model.NotificationEventTest); err == nil && template != nil {
		subject = RenderTemplate(template.Subject, variables)
		body = RenderTemplate(template.Body, variables)
	}

	if err := SendTestMail(recipient, subject, body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "测试邮件已发送"})
}

// HandleListNotificationTemplates 返回全部事件模板，首次使用时
// 预置默认值。
//
// 路由：GET /api/v1/admin/notification-templates/（仅管理员）。
func HandleListNotificationTemplates(c *gin.Context) {
	templates, err := model.EnsureNotificationTemplates()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load notification templates"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"templates": templates,
		"variables": templateVariables,
	})
}

// HandleUpdateNotificationTemplate 更新某个事件模板。
//
// 路由：PUT /api/v1/admin/notification-templates/:event（仅管理员）。
func HandleUpdateNotificationTemplate(c *gin.Context) {
	event := strings.TrimSpace(c.Param("event"))
	if event == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "event is required"})
		return
	}
	var request struct {
		Subject string `json:"subject"`
		Body    string `json:"body"`
		Enabled bool   `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(request.Subject) == "" || strings.TrimSpace(request.Body) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "标题和内容不能为空"})
		return
	}
	if err := model.UpdateNotificationTemplate(model.NotificationTemplate{
		Event:   event,
		Subject: request.Subject,
		Body:    request.Body,
		Enabled: request.Enabled,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save notification template"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "saved"})
}

// HandleListNotificationSubscriptions 列出某个事件的订阅。
//
// 路由：GET /api/v1/admin/notification-subscriptions/（仅管理员）。
func HandleListNotificationSubscriptions(c *gin.Context) {
	subscriptions, err := model.ListNotificationSubscriptions(strings.TrimSpace(c.Query("event")))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load notification subscriptions"})
		return
	}
	// mandatoryEvents 一并下发：界面要把这些事件标成「管理员必收、无法取消」，
	// 清单只存在后端（model.mandatoryAdminEvents），前端不另抄一份。
	c.JSON(http.StatusOK, gin.H{
		"subscriptions":   subscriptions,
		"mandatoryEvents": model.MandatoryAdminEvents(),
	})
}

// maxBatchSubscriptionEvents 限制单次批量创建的订阅数：界面最多是「全选」当前事件列表
// （十几个），给一个宽松上限挡掉构造出来的超大请求。
const maxBatchSubscriptionEvents = 100

// subscriptionRequest 是新增订阅的请求体，单条与批量共用。
type subscriptionRequest struct {
	Event        string `json:"event"`
	Channel      string `json:"channel"`
	ReceiverType string `json:"receiverType"`
	ReceiverID   uint   `json:"receiverId"`
	Receiver     string `json:"receiver"`
}

// buildSubscription 校验并规范化一条订阅。返回的错误信息可以直接展示给用户
// （与原来的单条创建逻辑完全一致，只是搬到了函数里，批量接口共用同一套校验）。
func buildSubscription(request subscriptionRequest) (*model.NotificationSubscription, error) {
	subscription := &model.NotificationSubscription{
		Event:        strings.TrimSpace(request.Event),
		Channel:      strings.TrimSpace(request.Channel),
		ReceiverType: strings.TrimSpace(request.ReceiverType),
		ReceiverID:   request.ReceiverID,
		Receiver:     strings.TrimSpace(request.Receiver),
		Enabled:      true,
	}
	if subscription.Event == "" {
		return nil, errors.New("请选择事件")
	}
	if subscription.Channel != model.NotificationChannelInApp && subscription.Channel != model.NotificationChannelEmail {
		return nil, errors.New("请选择接收渠道")
	}

	switch subscription.ReceiverType {
	case model.NotificationReceiverAllUsers:
		// 全体用户：不绑定具体账号（投递时展开成当时的账号列表），
		// 因此没有 ReceiverID / Receiver 可校验。邮件渠道下没有邮箱的账号
		// 会在投递时被跳过，这里不预判。
		subscription.ReceiverID = 0
		subscription.Receiver = ""
	case model.NotificationReceiverUser:
		// 用户可以用 id（选择器）或用户名（自由文本）来指定。
		var user *model.User
		var err error
		switch {
		case subscription.ReceiverID != 0:
			user, err = model.GetUserByID(uint64(subscription.ReceiverID))
		case subscription.Receiver != "":
			user, err = model.GetUserByUsername(subscription.Receiver)
		default:
			return nil, errors.New("请选择接收用户")
		}
		if err != nil || user == nil {
			return nil, errors.New("user not found")
		}
		subscription.ReceiverID = user.ID
		subscription.Receiver = user.Username
		if subscription.Channel == model.NotificationChannelEmail && strings.TrimSpace(user.Email) == "" {
			return nil, errors.New("该用户未配置邮箱，无法通过邮件接收")
		}
	case model.NotificationReceiverEmail:
		if !strings.Contains(subscription.Receiver, "@") {
			return nil, errors.New("请输入合法的邮箱地址")
		}
		subscription.Channel = model.NotificationChannelEmail
		subscription.ReceiverID = 0
	default:
		return nil, errors.New("请选择接收人类型")
	}
	return subscription, nil
}

// subscriptionKey 是「同一条订阅」的判重键，用于批量创建时跳过重复项。
func subscriptionKey(subscription model.NotificationSubscription) string {
	return strings.Join([]string{
		subscription.Event,
		subscription.Channel,
		subscription.ReceiverType,
		strconv.FormatUint(uint64(subscription.ReceiverID), 10),
		strings.ToLower(subscription.Receiver),
	}, "|")
}

// HandleCreateNotificationSubscription 为某个事件新增一个接收者。
//
// 路由：POST /api/v1/admin/notification-subscriptions/（仅管理员）。
func HandleCreateNotificationSubscription(c *gin.Context) {
	var request subscriptionRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	subscription, err := buildSubscription(request)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := model.CreateNotificationSubscription(subscription); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create notification subscription"})
		return
	}
	c.JSON(http.StatusCreated, subscription)
}

// HandleCreateNotificationSubscriptions 一次为多个事件建同一套接收者（界面上的「全选」）。
//
// 路由：POST /api/v1/admin/notification-subscriptions/batch（仅管理员）。
//
// 语义：事件 × (渠道, 接收人) 展开成多条订阅；已经存在完全相同订阅的事件跳过，
// 所以「全选」点两次不会留下重复行。任何一个事件校验不过就整批不写（保持一致，
// 也避免界面只提示一半）。新建与跳过的分开回传，界面能说明「新增 N 条、跳过 M 条」。
func HandleCreateNotificationSubscriptions(c *gin.Context) {
	var request struct {
		Events       []string `json:"events"`
		Channel      string   `json:"channel"`
		ReceiverType string   `json:"receiverType"`
		ReceiverID   uint     `json:"receiverId"`
		Receiver     string   `json:"receiver"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(request.Events) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请选择事件"})
		return
	}
	if len(request.Events) > maxBatchSubscriptionEvents {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf("一次最多为 %d 个事件创建订阅", maxBatchSubscriptionEvents),
		})
		return
	}

	existing, err := model.ListNotificationSubscriptions("")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load notification subscriptions"})
		return
	}
	seen := make(map[string]bool, len(existing))
	for _, subscription := range existing {
		seen[subscriptionKey(subscription)] = true
	}

	created := make([]model.NotificationSubscription, 0, len(request.Events))
	skipped := make([]string, 0)
	for _, event := range request.Events {
		subscription, err := buildSubscription(subscriptionRequest{
			Event:        event,
			Channel:      request.Channel,
			ReceiverType: request.ReceiverType,
			ReceiverID:   request.ReceiverID,
			Receiver:     request.Receiver,
		})
		if err != nil {
			// 带上事件名：批量的报错必须能看出是哪一项不合法。
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("%s: %s", strings.TrimSpace(event), err.Error()),
			})
			return
		}
		key := subscriptionKey(*subscription)
		if seen[key] {
			skipped = append(skipped, subscription.Event)
			continue
		}
		if err := model.CreateNotificationSubscription(subscription); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create notification subscription"})
			return
		}
		seen[key] = true
		created = append(created, *subscription)
	}

	c.JSON(http.StatusCreated, gin.H{"created": created, "skipped": skipped})
}

// HandleUpdateNotificationSubscription 启用或停用一条订阅。
//
// 路由：PUT /api/v1/admin/notification-subscriptions/:id（仅管理员）。
func HandleUpdateNotificationSubscription(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	subscription, err := model.GetNotificationSubscription(uint(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "subscription not found"})
		return
	}
	var request struct {
		Enabled *bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if request.Enabled != nil {
		subscription.Enabled = *request.Enabled
	}
	if err := model.SaveNotificationSubscription(subscription); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update notification subscription"})
		return
	}
	c.JSON(http.StatusOK, subscription)
}

// HandleDeleteNotificationSubscription 删除一条订阅。
//
// 路由：DELETE /api/v1/admin/notification-subscriptions/:id（仅管理员）。
func HandleDeleteNotificationSubscription(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := model.DeleteNotificationSubscription(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete notification subscription"})
		return
	}
	c.Status(http.StatusNoContent)
}

// HandleListNotifications 返回当前用户的站内信。
//
// 路由：GET /api/v1/notifications（任意登录用户）。
func HandleListNotifications(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	items, total, err := model.ListNotifications(user.ID, page, size)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load notifications"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"items": items,
		"total": total,
		"page":  page,
		"size":  size,
	})
}

// HandleNotificationUnreadCount 返回用户的未读角标数。
//
// 路由：GET /api/v1/notifications/unread-count（任意登录用户）。
func HandleNotificationUnreadCount(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	count, err := model.CountUnreadNotifications(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count notifications"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"count": count})
}

// HandleMarkNotificationsRead 把给定消息（或全部消息）标记为已读。
//
// 路由：POST /api/v1/notifications/read（任意登录用户）。
func HandleMarkNotificationsRead(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	var request struct {
		ID  uint   `json:"id"`
		IDs []uint `json:"ids"`
		All bool   `json:"all"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if request.All {
		if err := model.MarkAllNotificationsRead(user.ID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to mark notifications as read"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "ok"})
		return
	}

	ids := request.IDs
	if request.ID != 0 {
		ids = append(ids, request.ID)
	}
	if len(ids) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	for _, id := range ids {
		if err := model.MarkNotificationRead(user.ID, id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to mark notification as read"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// HandleClearNotifications 删除当前用户的全部站内消息。
//
// 路由：POST /api/v1/notifications/clear（任意登录用户）。
func HandleClearNotifications(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if err := model.ClearNotifications(user.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to clear notifications"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// clientEventRateLimiter 限制单个账号每分钟最多能把多少条客户端上报的失败
// 转成站内信记录，这样即使出现死循环也不会冲垮
// notifications 表。
type clientEventRateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	limit  int
	hits   map[uint][]time.Time
}

var clientEventLimiter = &clientEventRateLimiter{
	window: time.Minute,
	limit:  10,
	hits:   map[uint][]time.Time{},
}

func (l *clientEventRateLimiter) allow(userID uint) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	times := l.hits[userID]
	fresh := times[:0]
	for _, t := range times {
		if now.Sub(t) <= l.window {
			fresh = append(fresh, t)
		}
	}
	if len(fresh) >= l.limit {
		l.hits[userID] = fresh
		return false
	}
	l.hits[userID] = append(fresh, now)
	return true
}

// HandleCreateClientNotification 把 Web 客户端上报的操作失败
// 转成该用户的站内消息。
//
// 路由：POST /api/v1/notifications/client-events（任意登录用户）。
//
// 当请求本身失败时（例如连接被重置），客户端不能依赖 toast 给出反馈，
// 因此把失败上报到这里，
// 恢复连接后消息会出现在通知铃铛里。
func HandleCreateClientNotification(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if !clientEventLimiter.allow(user.ID) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many notifications, try again later"})
		return
	}

	var req struct {
		Title  string `json:"title"`
		Detail string `json:"detail"`
		Path   string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request payload"})
		return
	}

	title := truncateRunes(strings.TrimSpace(req.Title), 200)
	if title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title is required"})
		return
	}
	detail := truncateRunes(strings.TrimSpace(req.Detail), 2000)
	path := truncateRunes(strings.TrimSpace(req.Path), 300)
	if path != "" {
		detail = strings.TrimSpace(path + "\n" + detail)
	}

	if err := model.CreateUserNotification(
		user.ID, model.NotificationEventOperationFailed, title, detail); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save notification"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true})
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}
