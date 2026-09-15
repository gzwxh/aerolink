package notification

import (
	"context"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

const (
	dailyCheckInterval = time.Hour
	timeLayout         = "2006-01-02 15:04:05"
	dateLayout         = "2006-01-02"
)

// NotifyRemoteLogin records a successful sign-in and, when the security policy
// enables it, warns the account about the new IP address.
//
// 每个 IP 只提醒一次：同一账号从未出现过的 IP 视为异地，避免同一网络反复提醒。
func NotifyRemoteLogin(c *gin.Context, user *model.User) {
	if user == nil || user.ID == 0 {
		return
	}
	ip := c.ClientIP()
	userAgent := c.GetHeader("User-Agent")

	isNewIP, err := model.RecordLogin(user.ID, user.Username, user.Provider, ip, userAgent)
	if err != nil {
		klog.Errorf("failed to record login of %s: %v", user.Username, err)
		return
	}
	if !isNewIP {
		return
	}

	securitySetting, err := model.GetSecuritySetting()
	if err != nil {
		klog.Errorf("failed to load security setting for remote login notice: %v", err)
		return
	}
	if !securitySetting.RemoteLoginNoticeEnabled {
		return
	}

	// The mail is delivered in the background: the sign-in must not wait for
	// an SMTP round trip.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				klog.Errorf("panic in remote login notification: %v", r)
			}
		}()
		SendEvent(model.NotificationEventRemoteLogin, map[string]string{
			"username":  user.Username,
			"ip":        ip,
			"time":      time.Now().Format(timeLayout),
			"provider":  user.Provider,
			"userAgent": userAgent,
		}, Recipient{UserID: user.ID, Email: user.Email})
	}()
}

// StartDailyChecker runs the daily background checks: password expiry reminders
// and automatic disabling of long inactive accounts.
func StartDailyChecker(ctx context.Context) {
	go func() {
		// A panic in the background loop would take the whole process down —
		// gin.Recovery only guards HTTP handlers.
		defer func() {
			if r := recover(); r != nil {
				klog.Errorf("panic in daily notification checker: %v", r)
			}
		}()
		ticker := time.NewTicker(dailyCheckInterval)
		defer ticker.Stop()
		lastRun := ""
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				today := time.Now().Format(dateLayout)
				if lastRun == today {
					continue
				}
				lastRun = today
				runDailyChecksSafely()
			}
		}
	}()
}

// runDailyChecksSafely isolates one check run so a failure cannot kill the
// scheduler loop.
func runDailyChecksSafely() {
	defer func() {
		if r := recover(); r != nil {
			klog.Errorf("panic in daily checks: %v", r)
		}
	}()
	RunDailyChecks()
}

// RunDailyChecks performs the daily notification tasks once.
func RunDailyChecks() {
	setting, err := model.GetNotificationSetting()
	if err != nil {
		klog.Errorf("failed to load notification setting: %v", err)
		return
	}
	securitySetting, err := model.GetSecuritySetting()
	if err != nil {
		klog.Errorf("failed to load security setting: %v", err)
		return
	}
	if !setting.EmailEnabled && !setting.InAppEnabled {
		return
	}
	checkPasswordExpiry(setting, securitySetting)
	checkInactiveUsers(securitySetting)
	checkAccountExpiry()
}

// accountExpiryNoticeDays 是账号到期前开始提醒的天数。
const accountExpiryNoticeDays = 7

// checkAccountExpiry reminds users whose account expires within the notice
// window. Like the password expiry check it re-sends daily while in the
// window, so an ignored reminder keeps resurfacing.
func checkAccountExpiry() {
	users, err := model.ListUsersExpiringBefore(
		time.Now().AddDate(0, 0, accountExpiryNoticeDays),
	)
	if err != nil {
		klog.Errorf("failed to list users for account expiry: %v", err)
		return
	}
	now := time.Now()
	for _, user := range users {
		if user.ExpiresAt == nil {
			continue
		}
		daysLeft := int(user.ExpiresAt.Sub(now).Hours() / 24)
		if daysLeft < 0 {
			continue // already expired; login enforcement handles access
		}
		SendEvent(model.NotificationEventAccountExpiring, map[string]string{
			"username":   user.Username,
			"days":       strconv.Itoa(daysLeft + 1),
			"expireDate": user.ExpiresAt.Format("2006-01-02"),
		}, Recipient{UserID: user.ID, Email: user.Email})
	}
}

// checkPasswordExpiry reminds users whose password is about to expire (or just
// expired) according to the password policy.
func checkPasswordExpiry(setting *model.NotificationSettingData, securitySetting *model.SecuritySettingData) {
	if securitySetting.PasswordExpireDays <= 0 {
		return
	}
	users, err := model.ListUsersForPasswordExpiry()
	if err != nil {
		klog.Errorf("failed to list users for password expiry: %v", err)
		return
	}
	for _, user := range users {
		if user.PasswordUpdatedAt == nil {
			continue
		}
		expireAt := user.PasswordUpdatedAt.AddDate(0, 0, securitySetting.PasswordExpireDays)
		daysLeft := int(time.Until(expireAt).Hours() / 24)

		switch {
		case daysLeft > setting.PasswordExpireNoticeDays:
			continue
		case daysLeft >= 0:
			SendEvent(model.NotificationEventPasswordExpiring, map[string]string{
				"username":   user.Username,
				"days":       strconv.Itoa(daysLeft + 1),
				"expireDate": expireAt.Format(dateLayout),
			}, Recipient{UserID: user.ID, Email: user.Email})
		case daysLeft >= -1:
			// Keep telling the account for one day after the password expired.
			SendEvent(model.NotificationEventPasswordExpired, map[string]string{
				"username":   user.Username,
				"days":       "0",
				"expireDate": expireAt.Format(dateLayout),
			}, Recipient{UserID: user.ID, Email: user.Email})
		}
	}
}

// checkInactiveUsers disables accounts that have not signed in for the number of
// days configured in the security policy, and notifies them.
func checkInactiveUsers(securitySetting *model.SecuritySettingData) {
	days := securitySetting.InactiveUserDisableDays
	if days <= 0 {
		return
	}
	threshold := time.Now().AddDate(0, 0, -days)
	users, err := model.ListInactiveUsers(threshold)
	if err != nil {
		klog.Errorf("failed to list inactive users: %v", err)
		return
	}
	for _, user := range users {
		if err := model.SetUserEnabled(user.ID, false); err != nil {
			// The last administrator is protected by the model layer.
			klog.Warningf("failed to disable inactive user %s: %v", user.Username, err)
			continue
		}
		if err := model.MarkUserAutoDisabled(user.ID, model.DisableReasonInactive); err != nil {
			klog.Warningf("failed to record disable reason for %s: %v", user.Username, err)
		}
		klog.Infof("disabled inactive user %s (no sign-in for %d days)", user.Username, days)
		SendEvent(model.NotificationEventInactiveUserDisabled, map[string]string{
			"username": user.Username,
			"days":     strconv.Itoa(days),
		}, Recipient{UserID: user.ID, Email: user.Email})
	}
}
