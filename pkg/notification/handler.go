package notification

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

// templateVariables documents the placeholders available for each event, so the
// template editor can list them.
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
	// SMTPPassword is written only when present, so leaving it empty keeps the
	// stored password.
	SMTPPassword *string `json:"smtpPassword"`
	// ClearSMTPPassword removes the stored password.
	ClearSMTPPassword bool `json:"clearSmtpPassword"`
}

func notificationSettingPayload(setting *model.NotificationSettingData) gin.H {
	return gin.H{
		"setting":                setting,
		"smtpPasswordConfigured": model.HasNotificationSMTPPassword(),
	}
}

// HandleGetNotificationSetting returns the notification configuration.
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

// HandleUpdateNotificationSetting stores the notification configuration.
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

// HandleListAutoDisabledUsers lists the accounts disabled by the inactivity
// policy so an administrator can restore them.
//
// 路由：GET /api/v1/admin/notification-setting/disabled-users（仅管理员）。
func HandleListAutoDisabledUsers(c *gin.Context) {
	users, err := model.ListAutoDisabledUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load disabled users"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// HandleRunDailyChecks runs the daily notification tasks on demand: password
// expiry reminders and automatic disabling of long inactive accounts.
//
// 路由：POST /api/v1/admin/notification-setting/run-daily-checks（仅管理员）。
func HandleRunDailyChecks(c *gin.Context) {
	RunDailyChecks()
	c.JSON(http.StatusOK, gin.H{"message": "每日检查已执行"})
}

// HandleSendTestNotification sends a test mail with the stored configuration.
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

// HandleListNotificationTemplates returns every event template, seeding the
// defaults on first use.
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

// HandleUpdateNotificationTemplate updates one event template.
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

// HandleListNotificationSubscriptions lists the subscriptions of an event.
//
// 路由：GET /api/v1/admin/notification-subscriptions/（仅管理员）。
func HandleListNotificationSubscriptions(c *gin.Context) {
	subscriptions, err := model.ListNotificationSubscriptions(strings.TrimSpace(c.Query("event")))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load notification subscriptions"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"subscriptions": subscriptions})
}

// HandleCreateNotificationSubscription adds a receiver for an event.
//
// 路由：POST /api/v1/admin/notification-subscriptions/（仅管理员）。
func HandleCreateNotificationSubscription(c *gin.Context) {
	var request struct {
		Event        string `json:"event"`
		Channel      string `json:"channel"`
		ReceiverType string `json:"receiverType"`
		ReceiverID   uint   `json:"receiverId"`
		Receiver     string `json:"receiver"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	subscription := model.NotificationSubscription{
		Event:        strings.TrimSpace(request.Event),
		Channel:      strings.TrimSpace(request.Channel),
		ReceiverType: strings.TrimSpace(request.ReceiverType),
		ReceiverID:   request.ReceiverID,
		Receiver:     strings.TrimSpace(request.Receiver),
		Enabled:      true,
	}
	if subscription.Event == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请选择事件"})
		return
	}
	if subscription.Channel != model.NotificationChannelInApp && subscription.Channel != model.NotificationChannelEmail {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请选择接收渠道"})
		return
	}

	switch subscription.ReceiverType {
	case model.NotificationReceiverUser:
		// The user can be addressed by id (picker) or by username (free text).
		var user *model.User
		var err error
		if subscription.ReceiverID != 0 {
			user, err = model.GetUserByID(uint64(subscription.ReceiverID))
		} else if subscription.Receiver != "" {
			user, err = model.GetUserByUsername(subscription.Receiver)
		} else {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请选择接收用户"})
			return
		}
		if err != nil || user == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "user not found"})
			return
		}
		subscription.ReceiverID = user.ID
		subscription.Receiver = user.Username
		if subscription.Channel == model.NotificationChannelEmail && strings.TrimSpace(user.Email) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "该用户未配置邮箱，无法通过邮件接收"})
			return
		}
	case model.NotificationReceiverEmail:
		if !strings.Contains(subscription.Receiver, "@") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请输入合法的邮箱地址"})
			return
		}
		subscription.Channel = model.NotificationChannelEmail
		subscription.ReceiverID = 0
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "请选择接收人类型"})
		return
	}

	if err := model.CreateNotificationSubscription(&subscription); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create notification subscription"})
		return
	}
	c.JSON(http.StatusCreated, subscription)
}

// HandleUpdateNotificationSubscription enables or disables a subscription.
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

// HandleDeleteNotificationSubscription removes a subscription.
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

// HandleListNotifications returns the inbox of the current user.
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

// HandleNotificationUnreadCount returns the unread badge count of the user.
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

// HandleMarkNotificationsRead marks the given messages (or all of them) as read.
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

// HandleClearNotifications deletes all in-app messages of the current user.
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

// clientEventRateLimiter bounds how many client-reported failures one account
// can turn into inbox rows per minute, so a broken loop cannot flood the
// notifications table.
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

// HandleCreateClientNotification turns an operation failure reported by the
// web client into an in-app message for that user.
//
// 路由：POST /api/v1/notifications/client-events（任意登录用户）。
//
// The client cannot rely on a toast for feedback when the request itself
// failed (e.g. connection reset), so it reports the failure here and the
// message shows up in the notification bell once connectivity is restored.
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
