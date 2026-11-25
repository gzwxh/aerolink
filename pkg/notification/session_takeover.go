package notification

import (
	"sync"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
	"k8s.io/klog/v2"
)

// 抢占性登录（单点登录把旧会话顶下线）的安全告警。
//
// 通知策略：当事人必收（被顶下线的那个账号一定收到站内信，见 model.targetUserEvents），
// 其余收件人（其他账号 / 邮箱）仍只看订阅。
//
// 邮件在此之上再叠一层节流：同一账号 24 小时内被顶替达到 sessionTakeoverEmailAfter 次
// 才发邮件 —— 换设备、忘了退出这类正常操作不该天天打扰，而短时间内被反复顶替更可能
// 是密码已经泄露，值得主动告警。
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
	setting, title, content, ok := renderEvent(
		model.NotificationEventSessionTakeover, map[string]string{
			"username":  user.Username,
			"ip":        ip,
			"time":      now.Format(timeLayout),
			"userAgent": userAgent,
		})
	if !ok {
		return
	}

	inAppUsers, emails := resolveRecipients(model.NotificationEventSessionTakeover, []uint{user.ID})
	if setting.InAppEnabled {
		deliverInApp(inAppUsers, model.NotificationEventSessionTakeover, title, content)
	}

	if count < sessionTakeoverEmailAfter {
		return
	}
	deliverEmails(setting, emails, model.NotificationEventSessionTakeover, title, content)
}
