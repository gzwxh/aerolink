// Package notification implements the message notification module: SMTP mail,
// message templates, per event subscriptions and the in-app inbox.
package notification

import (
	"strings"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// Recipient is one delivery target that is not configured as a subscription,
// for example the account that just signed in.
type Recipient struct {
	UserID uint
	Email  string
}

// SendEvent renders the template of an event and delivers it to the configured
// subscribers plus the extra recipients passed in. It never returns an error:
// notification failures are logged so they cannot break the caller (a login,
// for instance).
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
		// Unknown event, or the template has been disabled.
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
	for address := range emails {
		if err := config.send([]string{address}, title, content); err != nil {
			klog.Errorf("failed to send %q mail to %s: %v", event, address, err)
		}
	}
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

// RenderTemplate replaces {{name}} placeholders with the provided variables.
// Unknown placeholders are kept as is so a broken template stays visible.
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
