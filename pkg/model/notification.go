package model

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

// Notification event identifiers. An event is at the same time the template key
// and the subscription key, so adding a new event only needs a constant here
// plus an entry in defaultNotificationTemplates.
const (
	// NotificationEventRemoteLogin fires after a sign-in from an IP the account
	// has never used before.
	NotificationEventRemoteLogin = "remote_login"
	// NotificationEventPasswordExpiring fires when a password is about to expire.
	NotificationEventPasswordExpiring = "password_expiring"
	// NotificationEventPasswordExpired fires when a password has just expired.
	NotificationEventPasswordExpired = "password_expired"
	// NotificationEventInactiveUserDisabled fires when an inactive account is
	// disabled automatically.
	NotificationEventInactiveUserDisabled = "inactive_user_disabled"
	// NotificationEventTest is used by the "send test mail" action.
	NotificationEventTest = "test"

	// Security/account lifecycle events reported to the affected user.
	NotificationEventPasswordResetByAdmin = "password_reset_by_admin"
	NotificationEventAccountDisabled      = "account_disabled"
	NotificationEventAccountEnabled       = "account_enabled"
	NotificationEventAccountExpiring      = "account_expiring"
	// RBAC changes that affect a user's permissions.
	NotificationEventRoleAssigned   = "role_assigned"
	NotificationEventRoleUnassigned = "role_unassigned"
	// NotificationEventMailDeliveryFailed warns administrators that the SMTP
	// delivery of a notification failed. It is in-app only to avoid recursion.
	NotificationEventMailDeliveryFailed = "mail_delivery_failed"
)

// Notification delivery channels.
const (
	NotificationChannelInApp = "inapp"
	NotificationChannelEmail = "email"
)

// Notification receiver kinds.
const (
	NotificationReceiverUser  = "user"
	NotificationReceiverEmail = "email"
)

// NotificationSettingData holds the notification module configuration. SMTP
// credentials live in NotificationSetting so the password can be encrypted.
type NotificationSettingData struct {
	// EmailEnabled turns outgoing mail on/off.
	EmailEnabled bool `json:"emailEnabled"`
	// InAppEnabled turns the built-in inbox on/off.
	InAppEnabled bool `json:"inAppEnabled"`

	SMTPHost       string `json:"smtpHost"`
	SMTPPort       int    `json:"smtpPort"`
	SMTPUsername   string `json:"smtpUsername"`
	SMTPFrom       string `json:"smtpFrom"`
	SMTPSenderName string `json:"smtpSenderName"`
	// SMTPTLS is one of "none", "starttls" or "ssl".
	SMTPTLS string `json:"smtpTls"`
	// SMTPSkipVerify skips certificate verification (self signed servers).
	SMTPSkipVerify bool `json:"smtpSkipVerify"`

	// PasswordExpireNoticeDays is how many days before expiry a reminder is sent.
	PasswordExpireNoticeDays int `json:"passwordExpireNoticeDays"`
}

// DefaultNotificationSettingData returns the configuration used when nothing
// has been stored yet: mail off, inbox on.
func DefaultNotificationSettingData() NotificationSettingData {
	return NotificationSettingData{
		EmailEnabled:             false,
		InAppEnabled:             true,
		SMTPPort:                 465,
		SMTPTLS:                  "ssl",
		PasswordExpireNoticeDays: 7,
	}
}

// Normalize clamps the stored configuration into supported ranges.
func (d *NotificationSettingData) Normalize() {
	if d.SMTPPort <= 0 || d.SMTPPort > 65535 {
		d.SMTPPort = 465
	}
	switch strings.ToLower(d.SMTPTLS) {
	case "none", "starttls", "ssl":
		d.SMTPTLS = strings.ToLower(d.SMTPTLS)
	default:
		d.SMTPTLS = "ssl"
	}
	if d.PasswordExpireNoticeDays < 0 {
		d.PasswordExpireNoticeDays = 0
	}
	if d.PasswordExpireNoticeDays > 365 {
		d.PasswordExpireNoticeDays = 365
	}
}

// NotificationSetting is the single row holding NotificationSettingData.
type NotificationSetting struct {
	Model
	Data JSONField `json:"-" gorm:"column:data;type:text"`
	// SMTPPassword is encrypted at rest (SecretString) and never serialized.
	SMTPPassword SecretString `json:"-" gorm:"column:smtp_password;type:text"`
}

func (NotificationSetting) TableName() string {
	return "notification_settings"
}

// NotificationTemplate is the subject/body pair used for one event. Email and
// in-app deliveries share the same rendered content.
type NotificationTemplate struct {
	Model
	Event   string `json:"event" gorm:"type:varchar(50);uniqueIndex;not null"`
	Subject string `json:"subject" gorm:"type:text"`
	Body    string `json:"body" gorm:"type:text"`
	Enabled bool   `json:"enabled" gorm:"type:boolean;default:true"`
}

func (NotificationTemplate) TableName() string {
	return "notification_templates"
}

// NotificationSubscription routes an event to a receiver over a channel.
type NotificationSubscription struct {
	Model
	Event string `json:"event" gorm:"type:varchar(50);index;not null"`
	// Channel is NotificationChannelInApp or NotificationChannelEmail.
	Channel string `json:"channel" gorm:"type:varchar(20);not null"`
	// ReceiverType is NotificationReceiverUser or NotificationReceiverEmail.
	ReceiverType string `json:"receiverType" gorm:"type:varchar(20);not null"`
	// ReceiverID is the user id when ReceiverType is "user".
	ReceiverID uint `json:"receiverId"`
	// Receiver keeps the username or the raw mail address, for display and for
	// resolving the address without a join.
	Receiver string `json:"receiver" gorm:"type:varchar(255)"`
	Enabled  bool   `json:"enabled" gorm:"type:boolean;default:true"`
}

func (NotificationSubscription) TableName() string {
	return "notification_subscriptions"
}

// Notification is an in-app message ("站内信") shown in the bell menu.
type Notification struct {
	Model
	UserID  uint   `json:"userId" gorm:"index;not null"`
	Event   string `json:"event" gorm:"type:varchar(50);index"`
	Title   string `json:"title" gorm:"type:text"`
	Content string `json:"content" gorm:"type:text"`
	Read    bool   `json:"read" gorm:"type:boolean;default:false;index"`
}

func (Notification) TableName() string {
	return "notifications"
}

// LoginRecord keeps every successful sign-in so a new IP can be detected.
type LoginRecord struct {
	Model
	UserID    uint   `json:"userId" gorm:"index;not null"`
	Username  string `json:"username" gorm:"type:varchar(50);index"`
	Provider  string `json:"provider" gorm:"type:varchar(50)"`
	IP        string `json:"ip" gorm:"type:varchar(64);index"`
	UserAgent string `json:"userAgent" gorm:"type:text"`
}

func (LoginRecord) TableName() string {
	return "login_records"
}

// NotificationEventOperationFailed marks an operation failure reported by the
// web client (e.g. a request that could not reach the server). These rows are
// only shown in the in-app inbox.
const NotificationEventOperationFailed = "operation_failed"

// CreateUserNotification writes one in-app message for the given user. Unlike
// SendEvent it bypasses subscriptions and mail delivery: it is for failures the
// client itself observed, which must be visible even when mail is not set up.
func CreateUserNotification(userID uint, event, title, content string) error {
	if userID == 0 {
		return errors.New("user id is required")
	}
	notification := Notification{
		UserID:  userID,
		Event:   event,
		Title:   title,
		Content: content,
	}
	return DB.Create(&notification).Error
}

// defaultNotificationTemplates seeds every event the module can emit. The text
// is editable from the UI afterwards.
var defaultNotificationTemplates = map[string]struct {
	Subject string
	Body    string
}{
	NotificationEventRemoteLogin: {
		Subject: "[Kite] 异地登录提醒",
		Body: `您好 {{username}}：

您的账号刚刚在以下位置登录，如果不是您本人操作，请立即修改密码。

  登录时间：{{time}}
  登录 IP：{{ip}}
  登录方式：{{provider}}
  客户端：{{userAgent}}
`,
	},
	NotificationEventPasswordExpiring: {
		Subject: "[Kite] 密码即将过期提醒",
		Body: `您好 {{username}}：

您的登录密码将在 {{days}} 天后过期（{{expireDate}}），请及时修改密码，以免影响登录。
`,
	},
	NotificationEventPasswordExpired: {
		Subject: "[Kite] 密码已过期",
		Body: `您好 {{username}}：

您的登录密码已于 {{expireDate}} 过期，请尽快修改密码。
`,
	},
	NotificationEventInactiveUserDisabled: {
		Subject: "[Kite] 账号因长期未登录被禁用",
		Body: `您好 {{username}}：

您的账号已连续 {{days}} 天未登录，已被自动禁用。如需继续使用，请联系管理员。
`,
	},
	NotificationEventTest: {
		Subject: "[Kite] 通知测试邮件",
		Body: `这是一封来自 Kite 的测试邮件。

如果您收到此邮件，说明 SMTP 配置正确。

发送时间：{{time}}
`,
	},
	NotificationEventPasswordResetByAdmin: {
		Subject: "[Kite] 密码已被管理员重置",
		Body: `您好 {{username}}：

您的账号密码已被管理员 {{operator}} 于 {{time}} 重置。

如果这不是您预期的操作，请立即联系管理员核实。
`,
	},
	NotificationEventAccountDisabled: {
		Subject: "[Kite] 账号已被禁用",
		Body: `您好 {{username}}：

您的账号已被管理员 {{operator}} 于 {{time}} 禁用，将无法登录 Kite。

如有疑问，请联系管理员。
`,
	},
	NotificationEventAccountEnabled: {
		Subject: "[Kite] 账号已启用",
		Body: `您好 {{username}}：

您的账号已被管理员 {{operator}} 于 {{time}} 启用，现在可以正常登录使用。
`,
	},
	NotificationEventAccountExpiring: {
		Subject: "[Kite] 账号即将过期",
		Body: `您好 {{username}}：

您的账号将于 {{expireDate}}（{{days}} 天后）过期，过期后将无法登录。

如需继续使用，请联系管理员办理延期。
`,
	},
	NotificationEventRoleAssigned: {
		Subject: "[Kite] 已为您分配角色",
		Body: `您好 {{username}}：

管理员于 {{time}} 为您的账号分配了角色「{{role}}」，相关权限已生效。
`,
	},
	NotificationEventRoleUnassigned: {
		Subject: "[Kite] 角色已被移除",
		Body: `您好 {{username}}：

管理员于 {{time}} 移除了您账号的角色「{{role}}」，相关权限已收回。
`,
	},
	NotificationEventMailDeliveryFailed: {
		Subject: "[Kite] 通知邮件发送失败",
		Body: `管理员您好：

{{time}} 向 {{address}} 发送事件「{{event}}」的通知邮件失败：

  {{reason}}

请检查系统设置中的 SMTP 配置。
`,
	},
}

// NotificationEventList returns every supported event identifier.
func NotificationEventList() []string {
	return []string{
		NotificationEventRemoteLogin,
		NotificationEventPasswordExpiring,
		NotificationEventPasswordExpired,
		NotificationEventInactiveUserDisabled,
		NotificationEventPasswordResetByAdmin,
		NotificationEventAccountDisabled,
		NotificationEventAccountEnabled,
		NotificationEventAccountExpiring,
		NotificationEventRoleAssigned,
		NotificationEventRoleUnassigned,
		NotificationEventMailDeliveryFailed,
	}
}

func notificationSettingRow() (*NotificationSetting, error) {
	var row NotificationSetting
	err := DB.First(&row, 1).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		raw, marshalErr := json.Marshal(DefaultNotificationSettingData())
		if marshalErr != nil {
			return nil, marshalErr
		}
		row = NotificationSetting{Data: JSONField(raw)}
		if err := DB.Create(&row).Error; err != nil {
			return nil, err
		}
		return &row, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// GetNotificationSetting returns the stored configuration with defaults applied.
func GetNotificationSetting() (*NotificationSettingData, error) {
	row, err := notificationSettingRow()
	if err != nil {
		return nil, err
	}
	data := DefaultNotificationSettingData()
	if len(row.Data) > 0 {
		if err := json.Unmarshal(row.Data, &data); err != nil {
			klog.Warningf("failed to parse notification setting, using defaults: %v", err)
			data = DefaultNotificationSettingData()
		}
	}
	data.Normalize()
	return &data, nil
}

// UpdateNotificationSetting stores the configuration (SMTP password untouched).
func UpdateNotificationSetting(data NotificationSettingData) (*NotificationSettingData, error) {
	data.Normalize()
	row, err := notificationSettingRow()
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	row.Data = JSONField(raw)
	if err := DB.Save(row).Error; err != nil {
		return nil, err
	}
	return &data, nil
}

// SetNotificationSMTPPassword stores the SMTP password encrypted at rest.
func SetNotificationSMTPPassword(password string) error {
	row, err := notificationSettingRow()
	if err != nil {
		return err
	}
	row.SMTPPassword = SecretString(password)
	return DB.Save(row).Error
}

// GetNotificationSMTPPassword returns the decrypted SMTP password.
func GetNotificationSMTPPassword() (string, error) {
	row, err := notificationSettingRow()
	if err != nil {
		return "", err
	}
	return string(row.SMTPPassword), nil
}

// HasNotificationSMTPPassword reports whether a password has been configured,
// without exposing it.
func HasNotificationSMTPPassword() bool {
	row, err := notificationSettingRow()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(row.SMTPPassword)) != ""
}

// EnsureNotificationTemplates creates the templates that do not exist yet and
// returns all of them ordered by event.
func EnsureNotificationTemplates() ([]NotificationTemplate, error) {
	var existing []NotificationTemplate
	if err := DB.Find(&existing).Error; err != nil {
		return nil, err
	}
	known := make(map[string]bool, len(existing))
	for _, template := range existing {
		known[template.Event] = true
	}
	// NotificationEventList drives the UI; the test template is seeded as well
	// so the "send test mail" action has something to render.
	seeded := append(NotificationEventList(), NotificationEventTest)
	for _, event := range seeded {
		if known[event] {
			continue
		}
		seed, ok := defaultNotificationTemplates[event]
		if !ok {
			continue
		}
		template := NotificationTemplate{
			Event:   event,
			Subject: seed.Subject,
			Body:    seed.Body,
			Enabled: true,
		}
		if err := DB.Create(&template).Error; err != nil {
			return nil, err
		}
		existing = append(existing, template)
	}
	return existing, nil
}

// GetNotificationTemplate returns the enabled template of an event, or nil when
// the event has no template or it has been disabled.
func GetNotificationTemplate(event string) (*NotificationTemplate, error) {
	var template NotificationTemplate
	err := DB.Where("event = ?", event).First(&template).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !template.Enabled {
		return nil, nil
	}
	return &template, nil
}

// UpdateNotificationTemplate saves the subject/body/enabled state of an event.
func UpdateNotificationTemplate(template NotificationTemplate) error {
	var stored NotificationTemplate
	err := DB.Where("event = ?", template.Event).First(&stored).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return DB.Create(&template).Error
	}
	if err != nil {
		return err
	}
	return DB.Model(&stored).Updates(map[string]any{
		"subject": template.Subject,
		"body":    template.Body,
		"enabled": template.Enabled,
	}).Error
}

// ListNotificationSubscriptions returns the subscriptions of an event.
func ListNotificationSubscriptions(event string) ([]NotificationSubscription, error) {
	var subscriptions []NotificationSubscription
	query := DB.Order("id ASC")
	if event != "" {
		query = query.Where("event = ?", event)
	}
	if err := query.Find(&subscriptions).Error; err != nil {
		return nil, err
	}
	return subscriptions, nil
}

// CreateNotificationSubscription stores a new subscription.
func CreateNotificationSubscription(subscription *NotificationSubscription) error {
	return DB.Create(subscription).Error
}

// GetNotificationSubscription loads one subscription by id.
func GetNotificationSubscription(id uint) (*NotificationSubscription, error) {
	var subscription NotificationSubscription
	if err := DB.First(&subscription, id).Error; err != nil {
		return nil, err
	}
	return &subscription, nil
}

// SaveNotificationSubscription persists changes to an existing subscription.
func SaveNotificationSubscription(subscription *NotificationSubscription) error {
	return DB.Save(subscription).Error
}

// DeleteNotificationSubscription removes a subscription.
func DeleteNotificationSubscription(id uint) error {
	return DB.Delete(&NotificationSubscription{}, id).Error
}

// CreateInAppNotifications stores inbox messages for the given users.
func CreateInAppNotifications(userIDs []uint, event, title, content string) error {
	if len(userIDs) == 0 {
		return nil
	}
	seen := make(map[uint]bool, len(userIDs))
	messages := make([]Notification, 0, len(userIDs))
	for _, userID := range userIDs {
		if userID == 0 || seen[userID] {
			continue
		}
		seen[userID] = true
		messages = append(messages, Notification{
			UserID:  userID,
			Event:   event,
			Title:   title,
			Content: content,
		})
	}
	if len(messages) == 0 {
		return nil
	}
	return DB.Create(&messages).Error
}

// ListNotifications returns one page of inbox messages for a user.
// ClearNotifications deletes every in-app message of the user.
func ClearNotifications(userID uint) error {
	return DB.Where("user_id = ?", userID).Delete(&Notification{}).Error
}

// ListUsersExpiringBefore returns enabled users whose ExpiresAt falls on or
// before the given deadline, for the "account expiring" reminder.
func ListUsersExpiringBefore(deadline time.Time) ([]User, error) {
	var users []User
	err := DB.Where(
		"enabled = ? AND expires_at IS NOT NULL AND expires_at <= ?",
		true, deadline,
	).Find(&users).Error
	return users, err
}

// ListAdminUserIDs returns the user IDs of enabled accounts that hold the
// admin role through a direct assignment.
func ListAdminUserIDs() ([]uint, error) {
	var adminRole Role
	if err := DB.Where("name = ?", DefaultAdminRole.Name).First(&adminRole).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	var ids []uint
	err := DB.Model(&User{}).
		Joins("JOIN role_assignments ON role_assignments.subject = users.username").
		Where(
			"role_assignments.role_id = ? AND role_assignments.subject_type = ? AND users.enabled = ?",
			adminRole.ID, SubjectTypeUser, true,
		).
		Distinct("users.id").
		Pluck("users.id", &ids).Error
	return ids, err
}

func ListNotifications(userID uint, page, size int) ([]Notification, int64, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	query := DB.Model(&Notification{}).Where("user_id = ?", userID)
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var messages []Notification
	if err := query.Order("created_at DESC").
		Offset((page - 1) * size).
		Limit(size).
		Find(&messages).Error; err != nil {
		return nil, 0, err
	}
	return messages, total, nil
}

// CountUnreadNotifications returns how many unread messages a user has.
func CountUnreadNotifications(userID uint) (int64, error) {
	var count int64
	err := DB.Model(&Notification{}).
		Where("user_id = ? AND read = ?", userID, false).
		Count(&count).Error
	return count, err
}

// MarkNotificationRead marks one message of a user as read.
func MarkNotificationRead(userID, id uint) error {
	return DB.Model(&Notification{}).
		Where("id = ? AND user_id = ?", id, userID).
		Update("read", true).Error
}

// MarkAllNotificationsRead marks every message of a user as read.
func MarkAllNotificationsRead(userID uint) error {
	return DB.Model(&Notification{}).
		Where("user_id = ? AND read = ?", userID, false).
		Update("read", true).Error
}

// RecordLogin stores a sign-in and reports whether the IP is new for the user.
//
// 仅记录成功登录；首次登录（无历史记录）不算异地，避免新账号就被提醒。
func RecordLogin(userID uint, username, provider, ip, userAgent string) (bool, error) {
	var previous int64
	if err := DB.Model(&LoginRecord{}).
		Where("user_id = ? AND ip = ?", userID, ip).
		Count(&previous).Error; err != nil {
		return false, err
	}
	var total int64
	if err := DB.Model(&LoginRecord{}).
		Where("user_id = ?", userID).
		Count(&total).Error; err != nil {
		return false, err
	}
	record := LoginRecord{
		UserID:    userID,
		Username:  username,
		Provider:  provider,
		IP:        ip,
		UserAgent: truncateText(userAgent, 512),
	}
	if err := DB.Create(&record).Error; err != nil {
		return false, err
	}
	return previous == 0 && total > 0, nil
}

// ListUsersForPasswordExpiry returns every enabled local account that has a
// password timestamp, newest password change first.
func ListUsersForPasswordExpiry() ([]User, error) {
	var users []User
	err := DB.Where("enabled = ? AND provider = ? AND password_updated_at IS NOT NULL",
		true, AuthProviderPassword).Find(&users).Error
	return users, err
}

// ListInactiveUsers returns enabled accounts that have not signed in since the
// given time. Accounts created recently are skipped so a fresh installation
// does not disable everybody at once.
func ListInactiveUsers(since time.Time) ([]User, error) {
	var users []User
	err := DB.Where(
		"enabled = ? AND created_at < ? AND (last_login_at IS NULL OR last_login_at < ?)",
		true, since, since,
	).Find(&users).Error
	return users, err
}

// DisableReasonInactive marks accounts closed by the inactivity policy.
const DisableReasonInactive = "inactive"

// MarkUserAutoDisabled records why an account was disabled automatically.
func MarkUserAutoDisabled(id uint, reason string) error {
	now := time.Now()
	err := DB.Model(&User{}).Where("id = ?", id).Updates(map[string]any{
		"disabled_reason": reason,
		"disabled_at":     now,
	}).Error
	InvalidateUserCache(uint64(id))
	return err
}

// ListAutoDisabledUsers returns every account currently disabled by the
// inactivity policy, newest first.
func ListAutoDisabledUsers() ([]User, error) {
	var users []User
	err := DB.Where("enabled = ? AND disabled_reason <> ''", false).
		Order("disabled_at DESC").Find(&users).Error
	return users, err
}

func truncateText(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}
