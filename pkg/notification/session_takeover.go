package notification

import (
	"strings"
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// 抢占性登录（单点登录把旧会话顶下线）的安全告警。
//
// 通知策略：
//   - 本人 + 全部启用的管理员：站内信（留痕，能在控制台里回看）；
//   - 只有反复出现（同一账号在窗口内被顶替达到 sessionTakeoverEmailAfter 次）才邮件
//     打扰管理员——换设备、忘了退出这类正常操作不该天天发邮件，而短时间内被反复顶替
//     更可能是密码已经泄露，值得主动告警。
const (
	sessionTakeoverEmailAfter = 3
	sessionTakeoverWindow     = 24 * time.Hour
)

var (
	sessionTakeoverMu    sync.Mutex
	sessionTakeoverStats = map[uint]*sessionTakeoverStat{}
)

type sessionTakeoverStat struct {
	count int
	first time.Time
}

// recordTakeover 记录一次顶替，返回窗口内的累计次数。窗口从首次出现开始计算，
// 过窗后重新计数（进程内计数即可：这里只用于决定「要不要发邮件」，丢了不致命）。
func recordTakeover(userID uint, now time.Time) int {
	sessionTakeoverMu.Lock()
	defer sessionTakeoverMu.Unlock()
	stat, ok := sessionTakeoverStats[userID]
	if !ok || now.Sub(stat.first) > sessionTakeoverWindow {
		stat = &sessionTakeoverStat{first: now}
		sessionTakeoverStats[userID] = stat
	}
	stat.count++
	return stat.count
}

// NotifySessionTakeover 在账号的旧会话被新的登录顶下线时通知用户与管理员。
// 发送在后台进行：登录流程不该等 SMTP。
func NotifySessionTakeover(user model.User, ip, userAgent string) {
	if user.ID == 0 {
		return
	}
	now := time.Now()
	count := recordTakeover(user.ID, now)

	go func() {
		defer func() {
			if r := recover(); r != nil {
				klog.Errorf("panic in session takeover notification: %v", r)
			}
		}()
		deliverSessionTakeover(user, ip, userAgent, count, now)
	}()
}

func deliverSessionTakeover(user model.User, ip, userAgent string, count int, now time.Time) {
	setting, err := model.GetNotificationSetting()
	if err != nil {
		klog.Errorf("failed to load notification setting: %v", err)
		return
	}
	if !setting.InAppEnabled && !setting.EmailEnabled {
		return
	}
	// 与其它事件一致：模板被管理员停用（或不存在）时整个事件静默。
	template, err := model.GetNotificationTemplate(model.NotificationEventSessionTakeover)
	if err != nil {
		klog.Errorf("failed to load the session takeover template: %v", err)
		return
	}
	if template == nil {
		return
	}

	variables := map[string]string{
		"username":  user.Username,
		"ip":        ip,
		"time":      now.Format(timeLayout),
		"userAgent": userAgent,
	}
	title := RenderTemplate(template.Subject, variables)
	content := RenderTemplate(template.Body, variables)

	admins, err := model.ListAdminUsers()
	if err != nil {
		klog.Errorf("failed to list admins for the session takeover alert: %v", err)
		admins = nil
	}

	if setting.InAppEnabled {
		// 站内信：本人与管理员各留一条（本人也是管理员时只留一条）。
		recipients := []uint{user.ID}
		for _, admin := range admins {
			if admin.ID != user.ID {
				recipients = append(recipients, admin.ID)
			}
		}
		if err := model.CreateInAppNotifications(
			recipients, model.NotificationEventSessionTakeover, title, content); err != nil {
			klog.Errorf("failed to store session takeover notifications: %v", err)
		}
	}

	if !setting.EmailEnabled || count < sessionTakeoverEmailAfter {
		return
	}
	config, err := loadSMTPConfig()
	if err != nil {
		klog.Warningf("skip session takeover mails: %v", err)
		return
	}
	// 邮件只发给管理员：用户本人已经有站内信，而短时间内反复被顶替需要管理员介入。
	sent := map[string]bool{}
	for _, admin := range admins {
		address := strings.TrimSpace(admin.Email)
		if address == "" || sent[address] {
			continue
		}
		sent[address] = true
		if err := config.send([]string{address}, title, content); err != nil {
			klog.Errorf("failed to send the session takeover mail to %s: %v", address, err)
		}
	}
}
