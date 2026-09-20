package model

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

// 通知事件标识。事件同时用作模板键与订阅键，因此新增事件只需在这里加一个常量，
// 并在 defaultNotificationTemplates 中补一条记录。
const (
	// NotificationEventRemoteLogin 在账号从未使用过的 IP 登录后触发。
	//
	NotificationEventRemoteLogin = "remote_login"
	// NotificationEventPasswordExpiring 在密码即将过期时触发。
	NotificationEventPasswordExpiring = "password_expiring"
	// NotificationEventPasswordExpired 在密码刚刚过期时触发。
	NotificationEventPasswordExpired = "password_expired"
	// NotificationEventInactiveUserDisabled 在长期不活跃的账号被自动停用时触发。
	//
	NotificationEventInactiveUserDisabled = "inactive_user_disabled"
	// NotificationEventTest 供"发送测试邮件"操作使用。
	NotificationEventTest = "test"

	// 上报给相关用户的安全 / 账号生命周期事件。
	NotificationEventPasswordResetByAdmin = "password_reset_by_admin"
	// NotificationEventMFAResetByAdmin 在管理员解除某账号的动态码绑定时发出（等保三级
	// 要求管理员重置强认证凭据后本人应能立即发现）。
	NotificationEventMFAResetByAdmin = "mfa_reset_by_admin"
	NotificationEventAccountDisabled = "account_disabled"
	NotificationEventAccountEnabled  = "account_enabled"
	NotificationEventAccountExpiring = "account_expiring"
	// NotificationEventSessionTakeover 在单点登录把该账号的旧会话顶下线时发出
	// （抢占性登录）：本人与管理员都会收到站内信，反复出现时还会邮件提醒管理员。
	NotificationEventSessionTakeover = "session_takeover"
	// 影响用户权限的 RBAC 变更。
	NotificationEventRoleAssigned   = "role_assigned"
	NotificationEventRoleUnassigned = "role_unassigned"
	// NotificationEventMailDeliveryFailed 提醒管理员某条通知的 SMTP 投递失败。
	// 它只走站内信，以免递归。
	NotificationEventMailDeliveryFailed = "mail_delivery_failed"
)

// 通知投递渠道。
const (
	NotificationChannelInApp = "inapp"
	NotificationChannelEmail = "email"
)

// 通知接收者类型。
const (
	NotificationReceiverUser  = "user"
	NotificationReceiverEmail = "email"
	// NotificationReceiverAllUsers 指整个实例的全体用户：订阅不绑定具体账号，
	// 投递时展开成当时所有已启用账号（见 pkg/notification 的 resolveRecipients），
	// 因此新入职的人不需要管理员再回来补一条订阅。
	NotificationReceiverAllUsers = "all_users"
)

// NotificationSettingData 保存通知模块的配置。SMTP 凭据放在 NotificationSetting 中，
// 这样口令可以加密存储。
type NotificationSettingData struct {
	// EmailEnabled 控制外发邮件的开关。
	EmailEnabled bool `json:"emailEnabled"`
	// InAppEnabled 控制内置站内信的开关。
	InAppEnabled bool `json:"inAppEnabled"`

	SMTPHost       string `json:"smtpHost"`
	SMTPPort       int    `json:"smtpPort"`
	SMTPUsername   string `json:"smtpUsername"`
	SMTPFrom       string `json:"smtpFrom"`
	SMTPSenderName string `json:"smtpSenderName"`
	// SMTPTLS 取值为 "none"、"starttls" 或 "ssl"。
	SMTPTLS string `json:"smtpTls"`
	// SMTPSkipVerify 跳过证书校验（自签名服务器）。
	SMTPSkipVerify bool `json:"smtpSkipVerify"`

	// PasswordExpireNoticeDays 表示过期前多少天开始发送提醒。
	PasswordExpireNoticeDays int `json:"passwordExpireNoticeDays"`
}

// DefaultNotificationSettingData 返回尚未存储任何配置时使用的默认配置：
// 邮件关闭、站内信开启。
func DefaultNotificationSettingData() NotificationSettingData {
	return NotificationSettingData{
		EmailEnabled:             false,
		InAppEnabled:             true,
		SMTPPort:                 465,
		SMTPTLS:                  "ssl",
		PasswordExpireNoticeDays: 7,
	}
}

// Normalize 把已存储的配置收敛到受支持的取值范围内。
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

// NotificationSetting 是保存 NotificationSettingData 的单行记录。
type NotificationSetting struct {
	Model
	Data JSONField `json:"-" gorm:"column:data"`
	// SMTPPassword 以密文存储（SecretString），且不会被序列化。
	SMTPPassword SecretString `json:"-" gorm:"column:smtp_password;type:text"`
}

func (NotificationSetting) TableName() string {
	return "notification_settings"
}

// NotificationTemplate 是某个事件使用的标题/正文组合。邮件与站内投递
// 共用同一份渲染结果。
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

// NotificationSubscription 把某个事件按渠道路由给接收者。
type NotificationSubscription struct {
	Model
	Event string `json:"event" gorm:"type:varchar(50);index;not null"`
	// Channel 取 NotificationChannelInApp 或 NotificationChannelEmail。
	Channel string `json:"channel" gorm:"type:varchar(20);not null"`
	// ReceiverType 取 NotificationReceiverUser / NotificationReceiverEmail /
	// NotificationReceiverAllUsers。
	ReceiverType string `json:"receiverType" gorm:"type:varchar(20);not null"`
	// ReceiverID 在 ReceiverType 为 "user" 时是用户 ID。
	ReceiverID uint `json:"receiverId"`
	// Receiver 保存用户名或原始邮箱地址，既用于展示，也便于在不联表的情况下
	// 解析出收件地址。全体用户订阅没有具体接收者，这里留空。
	Receiver string `json:"receiver" gorm:"type:varchar(255)"`
	Enabled  bool   `json:"enabled" gorm:"type:boolean;default:true"`
}

func (NotificationSubscription) TableName() string {
	return "notification_subscriptions"
}

// Notification is an in-app message ("站内信") shown in the bell menu.
//
// user_id 上的两个复合索引分别服务前端轮询的未读计数（user_id + read）与列表
// （user_id + created_at 倒序）；只按 user_id 的查询（删除全部站内信）走前者的左前缀。
type Notification struct {
	ID        uint      `json:"id" gorm:"primarykey"`
	CreatedAt time.Time `json:"createdAt" gorm:"index:idx_notifications_user_created,priority:2,sort:desc"`
	UpdatedAt time.Time `json:"updatedAt"`
	UserID    uint      `json:"userId" gorm:"not null;index:idx_notifications_user_read,priority:1;index:idx_notifications_user_created,priority:1"`
	Event     string    `json:"event" gorm:"type:varchar(50);index"`
	Title     string    `json:"title" gorm:"type:text"`
	Content   string    `json:"content" gorm:"type:text"`
	Read      bool      `json:"read" gorm:"type:boolean;default:false;index:idx_notifications_user_read,priority:2"`
}

func (Notification) TableName() string {
	return "notifications"
}

// LoginRecord 记录一次登录尝试，成功与失败都留痕（等保三级安全审计）。
// 成功登录用于新 IP 检测（见 RecordLogin）。
//
// created_at 索引同时服务登录日志的时间窗筛选/倒序分页与按天滚动删除（这两处都是全表
// 扫的大头）。user_id + ip 是「新 IP 检测」的查询条件，也覆盖只按 user_id 的查询。
type LoginRecord struct {
	ID        uint      `json:"id" gorm:"primarykey"`
	CreatedAt time.Time `json:"createdAt" gorm:"index:idx_login_records_created_at,sort:desc"`
	UpdatedAt time.Time `json:"updatedAt"`
	UserID    uint      `json:"userId" gorm:"index:idx_login_records_user_ip,priority:1"`
	Username  string    `json:"username" gorm:"type:varchar(50);index"`
	Provider  string    `json:"provider" gorm:"type:varchar(50)"`
	IP        string    `json:"ip" gorm:"type:varchar(64);index:idx_login_records_user_ip,priority:2"`
	UserAgent string    `json:"userAgent" gorm:"type:text"`
	// Result 区分成功与失败：空字符串 = 登录成功，非空 = 失败原因码
	// （invalid_credentials / mfa_invalid / ip_denied / ...）。
	//
	// 用「空值即成功」的失败码，而不是另加一个 success 布尔列：新列在
	// AutoMigrate 时只能回填列类型的零值，历史行都是成功登录，用布尔列会把它们
	// 全部显示成失败。
	Result string `json:"result" gorm:"type:varchar(50);index"`
}

func (LoginRecord) TableName() string {
	return "login_records"
}

// LoginResultSuccess 是成功登录在 LoginRecord.Result 里的取值。
const LoginResultSuccess = ""

// 失败原因码。取值会展示在「日志审计 → 登录日志」上，改动需要考虑前端文案。
const (
	// LoginResultInvalidCredentials 密码或目录凭据不正确。
	LoginResultInvalidCredentials = "invalid_credentials"
	// LoginResultMFAInvalid 动态码不正确。
	LoginResultMFAInvalid = "mfa_invalid"
	// LoginResultIPDenied 来源 IP 在黑名单中。
	LoginResultIPDenied = "ip_denied"
	// LoginResultTooManyAttempts 命中登录错误次数上限，账号或 IP 被锁定。
	LoginResultTooManyAttempts = "too_many_attempts"
	// LoginResultNotProvisioned 目录用户尚未在控制台开通。
	LoginResultNotProvisioned = "not_provisioned"
	// LoginResultNoPermission 账号被禁用，或没有任何角色 / 权限绑定组成员身份。
	LoginResultNoPermission = "no_permission"
	// LoginResultCaptchaInvalid 验证码不正确。
	LoginResultCaptchaInvalid = "captcha_invalid"
	// LoginResultAccountExpired 账号已超过有效期。
	LoginResultAccountExpired = "account_expired"
	// LoginResultSourceDenied 来源地址不在「仅从指定来源登录」的允许列表内。
	LoginResultSourceDenied = "source_denied"
)

// NotificationEventOperationFailed 标记由前端上报的一次操作失败（例如请求
// 没能到达服务端）。这些记录只展示在站内信中。
const NotificationEventOperationFailed = "operation_failed"

// CreateUserNotification 为指定用户写入一条站内消息。与 SendEvent 不同，它绕过
// 订阅与邮件投递：用于记录客户端自身观察到的失败，即便没有配置邮件也必须可见。
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

// defaultNotificationTemplates 预置本模块可发出的每一个事件。文案之后可以在
// 界面中编辑。
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
	NotificationEventMFAResetByAdmin: {
		Subject: "[Kite] 动态码绑定已被管理员重置",
		Body: `您好 {{username}}：

您账号的多因素认证（MFA）绑定已被管理员 {{operator}} 于 {{time}} 解除，请在下次登录时重新绑定。

如果这不是您预期的操作（例如您并未遗失身份验证器），请立即联系管理员核实。
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
	NotificationEventSessionTakeover: {
		Subject: "[Kite] 账号在其他设备登录",
		Body: `账号 {{username}} 于 {{time}} 在其他设备登录（IP：{{ip}}），出于安全考虑，该账号此前的会话已自动退出。

- 如果是您本人的操作：在登录页重新登录即可继续使用；
- 如果不是本人操作：说明密码可能已经泄露，请立即修改密码，管理员请尽快核实。
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

// NotificationEventList 返回所有受支持的事件标识。
func NotificationEventList() []string {
	return []string{
		NotificationEventRemoteLogin,
		NotificationEventPasswordExpiring,
		NotificationEventPasswordExpired,
		NotificationEventInactiveUserDisabled,
		NotificationEventPasswordResetByAdmin,
		NotificationEventMFAResetByAdmin,
		NotificationEventAccountDisabled,
		NotificationEventAccountEnabled,
		NotificationEventAccountExpiring,
		NotificationEventSessionTakeover,
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

// GetNotificationSetting 返回已存储的配置，并应用默认值。
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

// UpdateNotificationSetting 保存配置（不改动 SMTP 口令）。
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

// SetNotificationSMTPPassword 以密文方式保存 SMTP 口令。
func SetNotificationSMTPPassword(password string) error {
	row, err := notificationSettingRow()
	if err != nil {
		return err
	}
	row.SMTPPassword = SecretString(password)
	return DB.Save(row).Error
}

// GetNotificationSMTPPassword 返回解密后的 SMTP 口令。
func GetNotificationSMTPPassword() (string, error) {
	row, err := notificationSettingRow()
	if err != nil {
		return "", err
	}
	return string(row.SMTPPassword), nil
}

// HasNotificationSMTPPassword 报告是否已经配置了口令，
// 但不暴露口令本身。
func HasNotificationSMTPPassword() bool {
	row, err := notificationSettingRow()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(row.SMTPPassword)) != ""
}

// EnsureNotificationTemplates 创建尚不存在的模板，
// 并返回按事件排序的全部模板。
func EnsureNotificationTemplates() ([]NotificationTemplate, error) {
	// 显式按 id 排序：接口返回的顺序就是下拉列表的顺序（= NotificationEventList 的
	// 顺序，新事件追加在最后），不能依赖各数据库对无 ORDER BY 查询的默认顺序。
	var existing []NotificationTemplate
	if err := DB.Order("id ASC").Find(&existing).Error; err != nil {
		return nil, err
	}
	known := make(map[string]bool, len(existing))
	for _, template := range existing {
		known[template.Event] = true
	}
	// NotificationEventList 供界面使用；测试模板同样会预置，
	// 这样"发送测试邮件"才有内容可渲染。
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

// GetNotificationTemplate 返回某个事件已启用的模板；
// 事件没有模板或模板已禁用时返回 nil。
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

// UpdateNotificationTemplate 保存某个事件的标题/正文/启用状态。
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

// ListNotificationSubscriptions 返回某个事件的订阅列表。
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

// CreateNotificationSubscription 保存一条新的订阅。
func CreateNotificationSubscription(subscription *NotificationSubscription) error {
	return DB.Create(subscription).Error
}

// GetNotificationSubscription 按 ID 读取一条订阅。
func GetNotificationSubscription(id uint) (*NotificationSubscription, error) {
	var subscription NotificationSubscription
	if err := DB.First(&subscription, id).Error; err != nil {
		return nil, err
	}
	return &subscription, nil
}

// SaveNotificationSubscription 持久化对已有订阅的改动。
func SaveNotificationSubscription(subscription *NotificationSubscription) error {
	return DB.Save(subscription).Error
}

// DeleteNotificationSubscription 删除一条订阅。
func DeleteNotificationSubscription(id uint) error {
	return DB.Delete(&NotificationSubscription{}, id).Error
}

// CreateInAppNotifications 为指定用户批量保存站内消息。
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

// ClearNotifications 删除该用户的全部站内消息。
func ClearNotifications(userID uint) error {
	return DB.Where("user_id = ?", userID).Delete(&Notification{}).Error
}

// ListUsersExpiringBefore 返回 ExpiresAt 早于或等于给定截止时间的已启用用户，
// 用于"账号即将过期"提醒。
func ListUsersExpiringBefore(deadline time.Time) ([]User, error) {
	var users []User
	err := DB.Where(
		"enabled = ? AND expires_at IS NOT NULL AND expires_at <= ?",
		true, deadline,
	).Find(&users).Error
	return users, err
}

// ListAdminUsers 返回通过直接授权持有管理员角色的已启用账号，用于在安全事件时
// 提醒管理员（所有人发站内信，重复发生的才发邮件）。
func ListAdminUsers() ([]User, error) {
	var adminRole Role
	if err := DB.Where("name = ?", DefaultAdminRole.Name).First(&adminRole).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	var users []User
	err := DB.Model(&User{}).
		Joins("JOIN role_assignments ON role_assignments.subject = users.username").
		Where(
			"role_assignments.role_id = ? AND role_assignments.subject_type = ? AND users.enabled = ?",
			adminRole.ID, SubjectTypeUser, true,
		).
		Distinct("users.id").
		Find(&users).Error
	return users, err
}

// ListAdminUserIDs 返回通过直接授权持有管理员角色的已启用账号的用户 ID。
func ListAdminUserIDs() ([]uint, error) {
	users, err := ListAdminUsers()
	if err != nil {
		return nil, err
	}
	ids := make([]uint, 0, len(users))
	for _, user := range users {
		ids = append(ids, user.ID)
	}
	return ids, nil
}

// ListEnabledUsers 返回全部已启用账号，供「全体用户」订阅在投递时展开收件人。
//
// 只按 enabled 过滤（与 ListAdminUsers 同一口径）：停用账号登不进来，站内信没人看，
// 邮件也不该再发。
func ListEnabledUsers() ([]User, error) {
	var users []User
	err := DB.Where("enabled = ?", true).Find(&users).Error
	return users, err
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

// CountUnreadNotifications 返回用户的未读消息数。
func CountUnreadNotifications(userID uint) (int64, error) {
	var count int64
	err := DB.Model(&Notification{}).
		Where("user_id = ? AND read = ?", userID, false).
		Count(&count).Error
	return count, err
}

// MarkNotificationRead 把用户的一条消息标记为已读。
func MarkNotificationRead(userID, id uint) error {
	return DB.Model(&Notification{}).
		Where("id = ? AND user_id = ?", id, userID).
		Update("read", true).Error
}

// MarkAllNotificationsRead 把用户的所有消息标记为已读。
func MarkAllNotificationsRead(userID uint) error {
	return DB.Model(&Notification{}).
		Where("user_id = ? AND read = ?", userID, false).
		Update("read", true).Error
}

// RecordLogin 记录一次成功登录，并报告该 IP 对这个用户是否是新的。
//
// 仅成功登录参与「新 IP」判定；首次登录（无历史记录）不算异地，避免新账号就被提醒。
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
		Result:    LoginResultSuccess,
	}
	if err := DB.Create(&record).Error; err != nil {
		return false, err
	}
	return previous == 0 && total > 0, nil
}

// RecordLoginFailure 记录一次失败的登录尝试，它是安全审计链路
// （等保三级安全审计）的一部分。账号可能并不存在，因此 UserID
// 保持为 0，只保留尝试时使用的用户名。
func RecordLoginFailure(username, provider, ip, userAgent, reason string) error {
	if reason == LoginResultSuccess {
		reason = LoginResultInvalidCredentials
	}
	record := LoginRecord{
		Username:  truncateText(strings.TrimSpace(username), 50),
		Provider:  truncateText(provider, 50),
		IP:        ip,
		UserAgent: truncateText(userAgent, 512),
		Result:    truncateText(reason, 50),
	}
	return DB.Create(&record).Error
}

// ListUsersForPasswordExpiry 返回所有已启用且有密码时间戳的本地账号，
// 按最近一次修改密码的时间倒序。
func ListUsersForPasswordExpiry() ([]User, error) {
	var users []User
	err := DB.Where("enabled = ? AND provider = ? AND password_updated_at IS NOT NULL",
		true, AuthProviderPassword).Find(&users).Error
	return users, err
}

// ListInactiveUsers 返回自给定时间起从未登录的已启用账号。刚创建的账号会被跳过，
// 以免全新部署时一次性把所有人都停用。
func ListInactiveUsers(since time.Time) ([]User, error) {
	var users []User
	err := DB.Where(
		"enabled = ? AND created_at < ? AND (last_login_at IS NULL OR last_login_at < ?)",
		true, since, since,
	).Find(&users).Error
	return users, err
}

// DisableReasonInactive 标记按不活跃策略关闭的账号。
const DisableReasonInactive = "inactive"

// DisableReasonExpired 标记因超过账号有效期而被自动停用的账号。
const DisableReasonExpired = "expired"

// MarkUserAutoDisabled 记录账号被自动停用的原因。
func MarkUserAutoDisabled(id uint, reason string) error {
	now := time.Now()
	err := DB.Model(&User{}).Where("id = ?", id).Updates(map[string]any{
		"disabled_reason": reason,
		"disabled_at":     now,
	}).Error
	InvalidateUserCache(uint64(id))
	return err
}

// ListAutoDisabledUsers 返回当前被不活跃策略停用的所有账号，
// 按时间倒序。
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
