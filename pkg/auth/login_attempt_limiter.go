package auth

import (
	"bytes"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

const (
	tooManyCredentialLoginAttemptsError = "too many login attempts, please try again later"
	// failureRetention 让一次已记录的失败保留足够长的时间以便被计数，
	// 即使策略没有定义更长的封锁窗口。
	failureRetention = 5 * time.Minute
)

// credentialLoginAttemptLimiter 是凭据登录失败限流的入口。
//
// 计数与封锁状态都在数据库里（`model.LoginAttempt`），这里不再持有任何状态：
// 多副本部署时，「错 N 次锁定」必须跨副本生效，管理员手动拉黑的 IP 也必须对所有副本
// 生效。数据库读不出来时按「未封锁」处理（失败开放），与其它限流/会话判定一致。
type credentialLoginAttemptLimiter struct {
	// cleanupMu/lastCleanup 只用来限制「清理过期行」这个动作的频率：它是本机行为
	// （多副本各自清理一遍没有副作用），不需要跨副本共享。
	cleanupMu   sync.Mutex
	lastCleanup time.Time
}

var credentialLoginAttempts = &credentialLoginAttemptLimiter{}

// loginLimits 是针对某次登录尝试解析出的安全策略。
type loginLimits struct {
	userFailLimit int
	userBlock     time.Duration
	ipFailLimit   int
	ipBlock       time.Duration
	ipWhitelist   []string
	ipBlacklist   []string
}

func loadLoginLimits() loginLimits {
	limits := loginLimits{}
	if model.DB == nil {
		return limits
	}
	setting, err := model.GetSecuritySetting()
	if err != nil {
		klog.Warningf("Failed to load security setting for login limits: %v", err)
		return limits
	}
	limits.userFailLimit = setting.UserLoginFailLimit
	limits.userBlock = time.Duration(setting.UserLoginBlockMinutes) * time.Minute
	limits.ipFailLimit = setting.IPLoginFailLimit
	limits.ipBlock = time.Duration(setting.IPLoginBlockMinutes) * time.Minute
	limits.ipWhitelist = setting.IPWhitelist
	limits.ipBlacklist = setting.IPBlacklist
	return limits
}

func (l loginLimits) ipBlacklisted(ip string) bool {
	return matchesIPList(l.ipBlacklist, ip)
}

func (l loginLimits) ipWhitelisted(ip string) bool {
	return matchesIPList(l.ipWhitelist, ip)
}

func matchesIPList(entries []string, ip string) bool {
	for _, entry := range entries {
		if matchIPEntry(entry, ip) {
			return true
		}
	}
	return false
}

// matchIPEntry 支持单个地址、CIDR 网段，以及形如
// 192.168.10.1-192.168.10.20 或 2001:db8:a1-2001:db8:1:a10 的区间。
func matchIPEntry(entry string, ip string) bool {
	entry = strings.TrimSpace(entry)
	client := net.ParseIP(strings.TrimSpace(ip))
	if entry == "" || client == nil {
		return false
	}
	if _, block, err := net.ParseCIDR(entry); err == nil {
		return block.Contains(client)
	}
	if from, to, ok := strings.Cut(entry, "-"); ok {
		start := net.ParseIP(strings.TrimSpace(from))
		end := net.ParseIP(strings.TrimSpace(to))
		return start != nil && end != nil && ipBetween(client, start, end)
	}
	parsed := net.ParseIP(entry)
	return parsed != nil && parsed.Equal(client)
}

func ipBetween(ip, start, end net.IP) bool {
	value := ip.To16()
	low := start.To16()
	high := end.To16()
	if value == nil || low == nil || high == nil {
		return false
	}
	return bytes.Compare(value, low) >= 0 && bytes.Compare(value, high) <= 0
}

func ipAttemptKey(ip string) string  { return "ip:" + ip }
func userAttemptKey(u string) string { return "user:" + strings.ToLower(strings.TrimSpace(u)) }

// attemptBlocked 读取某个来源的封锁状态：manual 表示管理员手动拉黑（优先于白名单），
// blocked 表示此刻确实处于封锁期内。没有记录、已经过期、或读不到时都返回未封锁。
func attemptBlocked(key string, now time.Time) (manual bool, blocked bool) {
	if model.DB == nil {
		return false, false
	}
	attempt, err := model.GetLoginAttempt(key)
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			klog.Warningf("failed to read the login attempt state for %s: %v", key, err)
		}
		return false, false
	}
	if !now.Before(attempt.BlockedUntil) {
		return false, false
	}
	return attempt.ManualBlock, true
}

// blocked 报告该 IP 或用户当前是否被封锁。
func (l *credentialLoginAttemptLimiter) blocked(ip string, username string, limits loginLimits) bool {
	now := time.Now()
	l.cleanupExpired(now)

	if manual, blocked := attemptBlocked(ipAttemptKey(ip), now); blocked {
		// 管理员手动拉黑优先于白名单；自动锁定仍然对白名单地址豁免。
		if manual || !limits.ipWhitelisted(ip) {
			return true
		}
	}
	if _, blocked := attemptBlocked(userAttemptKey(username), now); blocked {
		return true
	}
	return false
}

// recordFailure 为 IP 与用户两个维度各记一次失败，并报告
// 这次尝试是否刚好触达阈值。
func (l *credentialLoginAttemptLimiter) recordFailure(ip string, username string, limits loginLimits) bool {
	now := time.Now()
	l.cleanupExpired(now)

	blocked := false
	if !limits.ipWhitelisted(ip) {
		if l.recordFailureForKey(ipAttemptKey(ip), now, limits.ipFailLimit, limits.ipBlock) {
			blocked = true
		}
	}
	if l.recordFailureForKey(userAttemptKey(username), now, limits.userFailLimit, limits.userBlock) {
		blocked = true
	}
	return blocked
}

// recordFailureForKey 记一次失败；达到阈值时顺便落封锁，并报告本次是否触达阈值。
func (l *credentialLoginAttemptLimiter) recordFailureForKey(key string, now time.Time, limit int, block time.Duration) bool {
	if limit <= 0 || model.DB == nil {
		return false
	}

	window := failureRetention
	if block > window {
		window = block
	}

	failures, err := model.RecordCredentialLoginFailure(key, now, window)
	if err != nil {
		klog.Warningf("failed to record a login failure for %s: %v", key, err)
		return false
	}
	if failures < limit || block <= 0 {
		return false
	}
	if err := model.BlockLoginAttempt(key, now.Add(block), false); err != nil {
		klog.Warningf("failed to block %s after repeated login failures: %v", key, err)
		return false
	}
	return true
}

// clear 清除一次成功登录的计数。
func (l *credentialLoginAttemptLimiter) clear(ip string, username string) {
	if err := model.DeleteLoginAttempts(ipAttemptKey(ip), userAttemptKey(username)); err != nil {
		klog.V(4).Infof("failed to clear the login attempt counters: %v", err)
	}
}

// cleanupExpired 顺手清掉既已解除封锁、计数窗口也过期的行（限制表增长）。
// 每次都做没有必要（登录尝试本来就不频繁），最多一分钟一次。
func (l *credentialLoginAttemptLimiter) cleanupExpired(now time.Time) {
	l.cleanupMu.Lock()
	if now.Sub(l.lastCleanup) < time.Minute {
		l.cleanupMu.Unlock()
		return
	}
	l.lastCleanup = now
	l.cleanupMu.Unlock()

	if err := model.CleanupLoginAttempts(now, failureRetention); err != nil {
		klog.V(4).Infof("failed to clean up the login attempt table: %v", err)
	}
}

// UnblockLoginIP 清除某个客户端 IP 已记录的锁定，并报告
// 该 IP 是否确实处于锁定状态。
func UnblockLoginIP(ip string) bool {
	key := ipAttemptKey(strings.TrimSpace(ip))
	_, blocked := attemptBlocked(key, time.Now())
	if err := model.DeleteLoginAttempts(key); err != nil {
		klog.Warningf("failed to clear the lock for %s: %v", key, err)
	}
	return blocked
}

// BlockLoginIP 代表管理员把某个客户端 IP 锁定到给定时间。
//
// 该封锁优先于允许列表；它现在也存在数据库里，所以对所有副本生效。
// 需要永久封锁请使用拒绝列表（这个封锁会随到期时间自然消失）。
func BlockLoginIP(ip string, until time.Time) {
	if model.DB == nil {
		return
	}
	credentialLoginAttempts.cleanupExpired(time.Now())
	if err := model.BlockLoginAttempt(ipAttemptKey(strings.TrimSpace(ip)), until, true); err != nil {
		klog.Warningf("failed to lock %s: %v", ip, err)
	}
}

// BlockedLoginIP 是一个当前被锁定的客户端 IP。
type BlockedLoginIP struct {
	IP           string    `json:"ip"`
	BlockedUntil time.Time `json:"blockedUntil"`
	Failures     int       `json:"failures"`
}

// BlockedLoginIPs 快照当前被锁定的 IP，按过期时间倒序。
func BlockedLoginIPs() []BlockedLoginIP {
	if model.DB == nil {
		return nil
	}
	now := time.Now()
	attempts, err := model.ListLoginAttempts("ip:", now)
	if err != nil {
		klog.Warningf("failed to list the locked client IPs: %v", err)
		return nil
	}
	result := make([]BlockedLoginIP, 0, len(attempts))
	for _, attempt := range attempts {
		result = append(result, BlockedLoginIP{
			IP:           strings.TrimPrefix(attempt.Key, "ip:"),
			BlockedUntil: attempt.BlockedUntil,
			Failures:     attempt.FailureCount,
		})
	}
	return result
}
