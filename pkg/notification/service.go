// Package notification 实现消息通知模块：SMTP 邮件、
// 消息模板、按事件的订阅以及站内信收件箱。
package notification

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// Recipient 是一个未通过订阅配置的投递目标，
// 例如刚刚登录的那个账号。
type Recipient struct {
	UserID uint
	Email  string
}

// SendEvent 渲染某个事件的模板，并投递给已配置的
// 订阅者以及额外传入的接收者。它从不返回错误：
// 通知失败只记录日志，因此不会影响调用方（例如一次登录）。
func SendEvent(event string, variables map[string]string, extras ...Recipient) {
	setting, err := model.GetNotificationSetting()
	if err != nil {
		klog.Errorf("failed to load notification setting: %v", err)
		return
	}
	if !setting.EmailEnabled && !setting.InAppEnabled {
		return
	}

	template, err := model.GetNotificationTemplate(event)
	if err != nil {
		klog.Errorf("failed to load notification template %q: %v", event, err)
		return
	}
	if template == nil {
		// 未知事件，或者模板已被禁用。
		klog.V(1).Infof("notification event %q has no enabled template, skipped", event)
		return
	}

	title := RenderTemplate(template.Subject, variables)
	content := RenderTemplate(template.Body, variables)

	inAppUsers := make([]uint, 0, len(extras)+1)
	emails := make(map[string]bool)
	for _, extra := range extras {
		if extra.UserID != 0 {
			inAppUsers = append(inAppUsers, extra.UserID)
		}
		if email := strings.TrimSpace(extra.Email); email != "" {
			emails[email] = true
		}
	}

	subscriptions, err := model.ListNotificationSubscriptions(event)
	if err != nil {
		klog.Errorf("failed to load notification subscriptions: %v", err)
	}
	for _, subscription := range subscriptions {
		if !subscription.Enabled {
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

	if setting.InAppEnabled && len(inAppUsers) > 0 {
		if err := model.CreateInAppNotifications(inAppUsers, event, title, content); err != nil {
			klog.Errorf("failed to store in-app notifications: %v", err)
		}
	}

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

	adminIDs, err := model.ListAdminUserIDs()
	if err != nil {
		klog.Errorf("failed to list admins for mail failure alert: %v", err)
		return
	}
	title := "[Kite] 通知邮件发送失败"
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
