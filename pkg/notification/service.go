// Package notification 实现消息通知模块：SMTP 邮件、
// 消息模板、按事件的订阅以及站内信收件箱。
package notification

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
	"k8s.io/klog/v2"
)

// SendEvent 渲染某个事件的模板，并投递给该事件的订阅者。
//
// 收件人来自启用的订阅（`notification_subscriptions`）与管理员必收档；需要送达当事人时
// 用 SendEventTo。
//
// 它从不返回错误：通知失败只记录日志，因此不会影响调用方（例如一次登录）。
func SendEvent(event string, variables map[string]string) {
	sendEvent(event, variables, nil)
}

// SendEventTo 在 SendEvent 的基础上，把「当事人」（recipients）加入必收收件人。
//
// 只有 model.NotificationEventTargetsUser(event) 为真时才采纳 recipients：非清单事件
// 传入的收件人会被忽略并记一条 V(1) 日志。这是刻意的——历史上 SendEvent 有一个通用的
// extras 参数，任何调用方都能顺手把一个事件变成「不看订阅也发」，结果全网用户在订阅表
// 为空的情况下也收到了上千条消息（见 plans/2026-09-20-控制台体验与通知口径修复.md §5）。
// 现在要开这个口子，得先在 model.targetUserEvents 里显式登记该事件。
func SendEventTo(event string, variables map[string]string, recipients ...uint) {
	sendEvent(event, variables, recipients)
}

func sendEvent(event string, variables map[string]string, recipients []uint) {
	setting, title, content, ok := renderEvent(event, variables)
	if !ok {
		return
	}
	inAppUsers, emails := resolveRecipients(event, recipients)
	if setting.InAppEnabled {
		deliverInApp(inAppUsers, event, title, content)
	}
	deliverEmails(setting, emails, event, title, content)
}

// renderEvent 加载通知设置与事件模板并渲染内容。
// 最后一个返回值为 false 表示这个事件不该发（渠道全关 / 模板不存在或被停用）。
func renderEvent(
	event string, variables map[string]string,
) (*model.NotificationSettingData, string, string, bool) {
	setting, err := model.GetNotificationSetting()
	if err != nil {
		klog.Errorf("failed to load notification setting: %v", err)
		return nil, "", "", false
	}
	if !setting.EmailEnabled && !setting.InAppEnabled {
		return nil, "", "", false
	}

	template, err := model.GetNotificationTemplate(event)
	if err != nil {
		klog.Errorf("failed to load notification template %q: %v", event, err)
		return nil, "", "", false
	}
	if template == nil {
		// 未知事件，或者模板已被禁用。
		klog.V(1).Infof("notification event %q has no enabled template, skipped", event)
		return nil, "", "", false
	}

	return setting,
		RenderTemplate(template.Subject, variables),
		RenderTemplate(template.Body, variables),
		true
}

// resolveRecipients 解析收件人：订阅者 + 当事人必收 + 管理员必收，最后去重。
//
// 「全体用户」订阅在每一次投递时才展开成当前的账号列表，而不是把订阅时的那批人
// 固定下来：新入职的人自动收到，停用（或离职）的人也不再收到。
func resolveRecipients(event string, explicit []uint) ([]uint, map[string]bool) {
	inAppUsers := make([]uint, 0, 4)
	emails := make(map[string]bool)

	subscriptions, err := model.ListNotificationSubscriptions(event)
	if err != nil {
		klog.Errorf("failed to load notification subscriptions: %v", err)
		return inAppUsers, emails
	}
	for _, subscription := range subscriptions {
		if !subscription.Enabled {
			continue
		}
		if subscription.ReceiverType == model.NotificationReceiverAllUsers {
			users, err := model.ListEnabledUsers()
			if err != nil {
				klog.Errorf("failed to expand the all-users subscription: %v", err)
				continue
			}
			for _, user := range users {
				switch subscription.Channel {
				case model.NotificationChannelInApp:
					inAppUsers = append(inAppUsers, user.ID)
				case model.NotificationChannelEmail:
					if email := strings.TrimSpace(user.Email); email != "" {
						emails[email] = true
					}
				}
			}
			continue
		}
		if subscription.ReceiverType == model.NotificationReceiverEmail {
			if subscription.Channel == model.NotificationChannelEmail {
				if address := strings.TrimSpace(subscription.Receiver); address != "" {
					emails[address] = true
				}
			}
			continue
		}

		user, err := resolveSubscriptionUser(subscription)
		if err != nil || user == nil || !user.Enabled {
			continue
		}
		switch subscription.Channel {
		case model.NotificationChannelInApp:
			inAppUsers = append(inAppUsers, user.ID)
		case model.NotificationChannelEmail:
			if email := strings.TrimSpace(user.Email); email != "" {
				emails[email] = true
			}
		}
	}
	// 「当事人必收」：事件描述的是这个账号自己的状态/凭据变化，订阅配置不该让它消失。
	//
	// 有意**不**检查 Enabled：account_disabled 的当事人此刻正是停用状态，按「停用账号
	// 不收」过滤会让这条消息永远发不出去（它恰恰是当事人必须看到的那一条）。
	if len(explicit) > 0 {
		if model.NotificationEventTargetsUser(event) {
			inAppUsers = append(inAppUsers, explicit...)
		} else {
			klog.V(1).Infof(
				"notification event %q is not in the target-user list, ignoring %d explicit recipient(s)",
				event, len(explicit))
		}
	}

	// 「管理员必收」的事件不看订阅：这类事件（重置密码、清动态码、角色变更、
	// 邮件通道故障）是追责与应急处置的线索，任何订阅配置都不该让它消失。
	if model.NotificationEventMandatoryForAdmins(event) {
		adminIDs, adminErr := adminUserResolver()
		if adminErr != nil {
			klog.Errorf("failed to resolve admins for the mandatory event %q: %v", event, adminErr)
		} else {
			inAppUsers = append(inAppUsers, adminIDs...)
		}
	}

	// 同一个人可能同时被「全体用户」订阅、单独订阅、当事人必收与管理员必收命中，
	// 写站内信前先去重，否则他会收到两份同样的消息。
	return dedupeUserIDs(inAppUsers), emails
}

// adminUserResolver 解析「全部管理员」的实现，默认只查直接授权（纯 SQL）。
//
// 通过全局权限绑定组持有 admin 角色的账号需要看 rbac 包的内存角色映射，而
// pkg/rbac 依赖本包（handler.go 用了通知里的接口），不能反向 import；因此由
// app.go 在 rbac 初始化之后注入更完整的实现（rbac.AdminUserIDs）。
var adminUserResolver = model.ListAdminUserIDs

// SetAdminUserResolver 注入「查全部管理员」的实现；传 nil 表示恢复默认。
func SetAdminUserResolver(resolver func() ([]uint, error)) {
	if resolver == nil {
		adminUserResolver = model.ListAdminUserIDs
		return
	}
	adminUserResolver = resolver
}

func dedupeUserIDs(userIDs []uint) []uint {
	seen := make(map[uint]bool, len(userIDs))
	unique := make([]uint, 0, len(userIDs))
	for _, id := range userIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	return unique
}

// deliverInApp 把内容写进这些用户的站内信箱。调用方负责判断渠道开关。
func deliverInApp(userIDs []uint, event, title, content string) {
	if len(userIDs) == 0 {
		return
	}
	if err := model.CreateInAppNotifications(userIDs, event, title, content); err != nil {
		klog.Errorf("failed to store in-app notifications: %v", err)
	}
}

// deliverEmails 逐个地址发送通知邮件；有失败时给管理员留一条站内提醒。
func deliverEmails(
	setting *model.NotificationSettingData,
	emails map[string]bool,
	event, title, content string,
) {
	if !setting.EmailEnabled || len(emails) == 0 {
		return
	}
	config, err := loadSMTPConfig()
	if err != nil {
		klog.Warningf("skip sending %q mails: %v", event, err)
		return
	}
	deliveryFailed := false
	for address := range emails {
		if err := config.send([]string{address}, title, content); err != nil {
			klog.Errorf("failed to send %q mail to %s: %v", event, address, err)
			deliveryFailed = true
		}
	}
	if deliveryFailed {
		notifyAdminsOfMailFailure(event, emails)
	}
}

// mailFailureAlertMu 对面向管理员的站内提醒做节流，
// 避免 SMTP 服务器故障时事件仍在持续触发而冲垮通知表。
var (
	mailFailureAlertMu   sync.Mutex
	lastMailFailureAlert time.Time
)

// notifyAdminsOfMailFailure 向每个已启用的管理员写入一条仅站内的消息。
// 它有意绕过 SendEvent/mail：出问题的正是邮件通道，
// 所以用邮件来告警会递归。
func notifyAdminsOfMailFailure(event string, addresses map[string]bool) {
	mailFailureAlertMu.Lock()
	if time.Since(lastMailFailureAlert) < time.Hour {
		mailFailureAlertMu.Unlock()
		return
	}
	lastMailFailureAlert = time.Now()
	mailFailureAlertMu.Unlock()

	adminIDs, err := adminUserResolver()
	if err != nil {
		klog.Errorf("failed to list admins for mail failure alert: %v", err)
		return
	}
	title := "[鸢联] 通知邮件发送失败"
	content := fmt.Sprintf(
		"%s 事件「%s」的通知邮件发送失败（收件地址：%s）。请检查系统设置中的 SMTP 配置。",
		time.Now().Format("2006-01-02 15:04:05"), event,
		strings.Join(mapKeys(addresses), "、"),
	)
	for _, id := range adminIDs {
		if err := model.CreateUserNotification(
			id, model.NotificationEventMailDeliveryFailed, title, content); err != nil {
			klog.Errorf("failed to store mail failure alert for admin %d: %v", id, err)
		}
	}
}

func mapKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

func resolveSubscriptionUser(subscription model.NotificationSubscription) (*model.User, error) {
	if subscription.ReceiverID != 0 {
		return model.GetUserByID(uint64(subscription.ReceiverID))
	}
	if strings.TrimSpace(subscription.Receiver) == "" {
		return nil, nil
	}
	return model.GetUserByUsername(subscription.Receiver)
}

// RenderTemplate 用给定变量替换 {{name}} 占位符。
// 未知占位符保持原样，这样模板坏了也能被看见。
func RenderTemplate(text string, variables map[string]string) string {
	if len(variables) == 0 {
		return text
	}
	rendered := text
	for key, value := range variables {
		rendered = strings.ReplaceAll(rendered, "{{"+key+"}}", value)
		rendered = strings.ReplaceAll(rendered, "{{ "+key+" }}", value)
	}
	return rendered
}
