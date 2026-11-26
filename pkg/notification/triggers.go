package notification

import (
	"context"
	"strconv"
	"time"

	"aerolink/pkg/model"
	"aerolink/pkg/utils"
	"github.com/gin-gonic/gin"
	"k8s.io/klog/v2"
)

const (
	dailyCheckInterval = time.Hour
	timeLayout         = "2006-01-02 15:04:05"
	dateLayout         = "2006-01-02"
)

// NotifyRemoteLogin 记录一次成功登录，并在安全策略
// 启用该功能时提醒账号出现了新的 IP 地址。
//
// 每个 IP 只提醒一次：同一账号从未出现过的 IP 视为异地，避免同一网络反复提醒。
func NotifyRemoteLogin(c *gin.Context, user *model.User) {
	if user == nil || user.ID == 0 {
		return
	}
	ip := c.ClientIP()
	sourceIP := utils.ExtractSourceIP(c.GetHeader("X-Forwarded-For"), c.Request.RemoteAddr)
	userAgent := c.GetHeader("User-Agent")

	isNewIP, err := model.RecordLogin(user.ID, user.Username, user.Provider, ip, sourceIP, userAgent)
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

	// 邮件在后台投递：登录流程不能等待
	// 一次 SMTP 往返。
	go func() {
		defer func() {
			if r := recover(); r != nil {
				klog.Errorf("panic in remote login notification: %v", r)
			}
		}()
		SendEventTo(model.NotificationEventRemoteLogin, map[string]string{
			"username":  user.Username,
			"ip":        ip,
			"sourceIp":  sourceIP,
			"time":      time.Now().Format(timeLayout),
			"provider":  user.Provider,
			"userAgent": userAgent,
		}, user.ID)
	}()
}

// StartDailyChecker 运行每日后台检查：密码过期提醒
// 以及自动停用长期不活跃的账号。
func StartDailyChecker(ctx context.Context) {
	go func() {
		// 后台循环中的 panic 会把整个进程带崩——
		// gin.Recovery 只保护 HTTP 处理器。
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

// runDailyChecksSafely 隔离单次检查执行，使失败不会拖垮
// 调度循环。
func runDailyChecksSafely() {
	defer func() {
		if r := recover(); r != nil {
			klog.Errorf("panic in daily checks: %v", r)
		}
	}()
	RunDailyChecks()
}

// RunDailyChecks 执行一次每日通知任务。
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
	// 两个提醒任务只在有可用通知渠道时有意义；不活跃自动禁用是安全策略本身，
	// 不能因为管理员把通知全关了就不执行。
	if setting.EmailEnabled || setting.InAppEnabled {
		checkPasswordExpiry(setting, securitySetting)
		checkAccountExpiry()
	}
	checkInactiveUsers(securitySetting)
	checkExpiredUsers()
}

// RunInactiveUserCheck 执行一次「不活跃自动禁用」检查，返回被禁用的账号数。
// 每日定时任务与控制台里的「立即检查」共用这一入口。
func RunInactiveUserCheck() (int, error) {
	securitySetting, err := model.GetSecuritySetting()
	if err != nil {
		return 0, err
	}
	return checkInactiveUsers(securitySetting), nil
}

// accountExpiryNoticeDays 是账号到期前开始提醒的天数。
const accountExpiryNoticeDays = 7

// checkAccountExpiry 提醒账号在提醒窗口内即将过期的用户。
// 与密码过期检查一样，在窗口期内它每天都会重发，
// 因此被忽略的提醒会持续出现。
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
		SendEventTo(model.NotificationEventAccountExpiring, map[string]string{
			"username":   user.Username,
			"days":       strconv.Itoa(daysLeft + 1),
			"expireDate": user.ExpiresAt.Format("2006-01-02"),
		}, user.ID)
	}
}

// checkPasswordExpiry 依据密码策略提醒密码即将过期
// （或刚刚过期）的用户。
func checkPasswordExpiry(setting *model.NotificationSettingData, securitySetting *model.SecuritySettingData) {
	if securitySetting.PasswordExpireDays <= 0 {
		return
	}
	users, err := model.ListUsersForPasswordExpiry()
	if err != nil {
		klog.Errorf("failed to list users for password expiry: %v", err)
		return
	}
	now := time.Now()
	for _, user := range users {
		if user.PasswordUpdatedAt == nil {
			continue
		}
		expireAt := user.PasswordUpdatedAt.AddDate(0, 0, securitySetting.PasswordExpireDays)
		event, days, remind := passwordExpiryReminder(expireAt, now, setting.PasswordExpireNoticeDays)
		if !remind {
			continue
		}
		SendEventTo(event, map[string]string{
			"username":   user.Username,
			"days":       days,
			"expireDate": expireAt.Format(dateLayout),
		}, user.ID)
	}
}

// passwordExpiryReminder 决定一条密码记录该发哪种提醒：
//   - 未过期且在提醒窗口内：password_expiring，days 为剩余天数（不足一天按一天算）；
//   - 过期不足一天：password_expired（过期一天后不再重复提醒）；
//   - 其余：不发。
//
// 判断依据是「到期时刻是否已经过去」，而不是 `int(小时数 / 24)`：后者对负数会向零
// 截断，把过期不足 24 小时算成 0 天，于是刚过期的密码被报成「还有 1 天过期」，
// 而真正的「已过期」只在过期 24–48 小时之间才发出。
func passwordExpiryReminder(expireAt, now time.Time, noticeDays int) (event string, days string, remind bool) {
	remaining := expireAt.Sub(now)
	if remaining > 0 {
		daysLeft := int(remaining.Hours() / 24)
		if daysLeft > noticeDays {
			return "", "", false
		}
		return model.NotificationEventPasswordExpiring, strconv.Itoa(daysLeft + 1), true
	}
	if remaining <= -24*time.Hour {
		return "", "", false
	}
	return model.NotificationEventPasswordExpired, "0", true
}

// checkExpiredUsers 停用已过有效期的账号。
//
// 「账号有效期」此前只存在于界面与模型注释里：没有任务执行它，登录与鉴权路径也不看
// ExpiresAt，所以设了也不生效。这里补上执行侧；登录/鉴权侧另有即时兜底
// （见 AuthHandler.completePasswordLikeLogin、RequireAuth）。
func checkExpiredUsers() int {
	users, err := model.ListUsersExpiringBefore(time.Now())
	if err != nil {
		klog.Errorf("failed to list expired users: %v", err)
		return 0
	}
	disabled := 0
	for _, user := range users {
		// 最后一个管理员由 model 层保护：过期也不会把管理面锁死。
		if err := model.SetUserEnabled(user.ID, false); err != nil {
			klog.Warningf("failed to disable expired user %s: %v", user.Username, err)
			continue
		}
		if err := model.MarkUserAutoDisabled(user.ID, model.DisableReasonExpired); err != nil {
			klog.Warningf("failed to record disable reason for %s: %v", user.Username, err)
		}
		disabled++
		klog.Infof("disabled expired user %s (account expired at %s)", user.Username, user.ExpiresAt.Format(dateLayout))
	}
	return disabled
}

// checkInactiveUsers 停用未在安全策略所配置的天数内登录过的账号，
// 并通知它们。返回
// 被停用的账号数量。
func checkInactiveUsers(securitySetting *model.SecuritySettingData) int {
	days := securitySetting.InactiveUserDisableDays
	if days <= 0 {
		return 0
	}
	threshold := time.Now().AddDate(0, 0, -days)
	users, err := model.ListInactiveUsers(threshold)
	if err != nil {
		klog.Errorf("failed to list inactive users: %v", err)
		return 0
	}
	disabled := 0
	for _, user := range users {
		if err := model.SetUserEnabled(user.ID, false); err != nil {
			// 最后一个管理员由 model 层保护。
			klog.Warningf("failed to disable inactive user %s: %v", user.Username, err)
			continue
		}
		disabled++
		if err := model.MarkUserAutoDisabled(user.ID, model.DisableReasonInactive); err != nil {
			klog.Warningf("failed to record disable reason for %s: %v", user.Username, err)
		}
		klog.Infof("disabled inactive user %s (no sign-in for %d days)", user.Username, days)
		SendEventTo(model.NotificationEventInactiveUserDisabled, map[string]string{
			"username": user.Username,
			"days":     strconv.Itoa(days),
		}, user.ID)
	}
	return disabled
}
