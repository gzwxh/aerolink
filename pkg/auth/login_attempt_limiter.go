package auth

import (
	"bytes"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

const (
	tooManyCredentialLoginAttemptsError = "too many login attempts, please try again later"
	// failureRetention keeps a recorded failure long enough to be counted even
	// when the policy does not define a longer block window.
	failureRetention = 5 * time.Minute
)

type credentialLoginAttemptState struct {
	failures     []time.Time
	blockedUntil time.Time
}

type credentialLoginAttemptLimiter struct {
	mu          sync.Mutex
	attempts    map[string]credentialLoginAttemptState
	lastCleanup time.Time
}

var credentialLoginAttempts = &credentialLoginAttemptLimiter{
	attempts: map[string]credentialLoginAttemptState{},
}

// loginLimits is the security policy resolved for one login attempt.
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

// matchIPEntry supports a single address, a CIDR block and a range such as
// 192.168.10.1-192.168.10.20 or 2001:db8:a1-2001:db8:1:a10.
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

// blockedUntil reports whether the IP or the user is currently blocked.
func (l *credentialLoginAttemptLimiter) blockedUntil(ip string, username string, limits loginLimits) (time.Time, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	l.cleanupExpired(now)

	if !limits.ipWhitelisted(ip) {
		if state, ok := l.attempts[ipAttemptKey(ip)]; ok && now.Before(state.blockedUntil) {
			return state.blockedUntil, true
		}
	}
	if state, ok := l.attempts[userAttemptKey(username)]; ok && now.Before(state.blockedUntil) {
		return state.blockedUntil, true
	}
	return time.Time{}, false
}

// recordFailure counts a failed attempt for both dimensions and reports whether
// the attempt just reached a limit.
func (l *credentialLoginAttemptLimiter) recordFailure(ip string, username string, limits loginLimits) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	l.cleanupExpired(now)

	blocked := false
	if !limits.ipWhitelisted(ip) {
		blocked = l.recordFailureForKeyLocked(ipAttemptKey(ip), now, limits.ipFailLimit, limits.ipBlock) || blocked
	}
	return l.recordFailureForKeyLocked(userAttemptKey(username), now, limits.userFailLimit, limits.userBlock) || blocked
}

func (l *credentialLoginAttemptLimiter) recordFailureForKeyLocked(key string, now time.Time, limit int, block time.Duration) bool {
	if limit <= 0 {
		return false
	}

	state := l.attempts[key]
	retention := failureRetention
	if block > retention {
		retention = block
	}
	kept := state.failures[:0]
	for _, failure := range state.failures {
		if now.Sub(failure) < retention {
			kept = append(kept, failure)
		}
	}
	state.failures = append(kept, now)

	if len(state.failures) >= limit && block > 0 {
		state.blockedUntil = now.Add(block)
		state.failures = nil
		l.attempts[key] = state
		return true
	}

	l.attempts[key] = state
	return false
}

// clear drops the counters of a successful sign-in.
func (l *credentialLoginAttemptLimiter) clear(ip string, username string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	delete(l.attempts, ipAttemptKey(ip))
	delete(l.attempts, userAttemptKey(username))
}

func (l *credentialLoginAttemptLimiter) cleanupExpired(now time.Time) {
	if now.Sub(l.lastCleanup) < time.Minute {
		return
	}
	l.lastCleanup = now
	for key, state := range l.attempts {
		if now.Before(state.blockedUntil) {
			continue
		}
		if len(state.failures) == 0 {
			delete(l.attempts, key)
			continue
		}
		kept := state.failures[:0]
		for _, failure := range state.failures {
			if now.Sub(failure) < failureRetention {
				kept = append(kept, failure)
			}
		}
		if len(kept) == 0 {
			delete(l.attempts, key)
			continue
		}
		state.failures = kept
		l.attempts[key] = state
	}
}

// BlockedLoginIP is one currently locked client IP.
type BlockedLoginIP struct {
	IP           string    `json:"ip"`
	BlockedUntil time.Time `json:"blockedUntil"`
	Failures     int       `json:"failures"`
}

// BlockedLoginIPs snapshots the locked IPs, newest expiry first.
func BlockedLoginIPs() []BlockedLoginIP {
	credentialLoginAttempts.mu.Lock()
	defer credentialLoginAttempts.mu.Unlock()

	now := time.Now()
	result := make([]BlockedLoginIP, 0)
	for key, state := range credentialLoginAttempts.attempts {
		if !strings.HasPrefix(key, "ip:") {
			continue
		}
		if now.Before(state.blockedUntil) {
			result = append(result, BlockedLoginIP{
				IP:           strings.TrimPrefix(key, "ip:"),
				BlockedUntil: state.blockedUntil,
				Failures:     len(state.failures),
			})
		}
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].BlockedUntil.After(result[j].BlockedUntil)
	})
	return result
}
