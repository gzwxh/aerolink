package auth

import (
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

const sessionPolicyCacheTTL = 10 * time.Second

// sessionPolicy is the resolved session policy from the security settings.
type sessionPolicy struct {
	expireOnBrowserClose bool
	maxIdle              time.Duration
	maxLifetime          time.Duration
}

var (
	sessionPolicyMu     sync.RWMutex
	sessionPolicyCache  sessionPolicy
	sessionPolicyCached time.Time
)

func loadSessionPolicy() sessionPolicy {
	sessionPolicyMu.RLock()
	cached, cachedAt := sessionPolicyCache, sessionPolicyCached
	sessionPolicyMu.RUnlock()
	if time.Since(cachedAt) < sessionPolicyCacheTTL {
		return cached
	}

	policy := sessionPolicy{}
	if model.DB != nil {
		if setting, err := model.GetSecuritySetting(); err == nil && setting != nil {
			policy.expireOnBrowserClose = setting.SessionExpireOnBrowserClose
			if setting.SessionMaxIdleMinutes > 0 {
				policy.maxIdle = time.Duration(setting.SessionMaxIdleMinutes) * time.Minute
			}
			if setting.SessionMaxHours > 0 {
				policy.maxLifetime = time.Duration(setting.SessionMaxHours) * time.Hour
			}
		}
	}

	sessionPolicyMu.Lock()
	sessionPolicyCache, sessionPolicyCached = policy, time.Now()
	sessionPolicyMu.Unlock()
	return policy
}

// ResetSessionPolicyCache makes the next request reload the policy. The security
// settings handler calls it so new session limits apply immediately.
func ResetSessionPolicyCache() {
	sessionPolicyMu.Lock()
	sessionPolicyCached = time.Time{}
	sessionPolicyMu.Unlock()
}

// authCookieMaxAge is the auth_token cookie lifetime. A zero value makes it a
// session cookie, which the browser discards when it closes.
func authCookieMaxAge() int {
	if loadSessionPolicy().expireOnBrowserClose {
		return 0
	}
	return common.CookieExpirationSeconds
}

type sessionState struct {
	startedAt time.Time
	lastSeen  time.Time
}

// sessionTracker keeps the start and last activity of the signed-in sessions so
// the idle and absolute lifetime limits can be enforced. It lives in memory, so
// a restart makes existing sessions fail open (they keep working until the JWT
// itself expires).
type sessionTracker struct {
	mu       sync.Mutex
	sessions map[uint64]sessionState
}

var activeSessions = &sessionTracker{sessions: map[uint64]sessionState{}}

func (t *sessionTracker) start(userID uint64) {
	if userID == 0 {
		return
	}
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sessions[userID] = sessionState{startedAt: now, lastSeen: now}
}

func (t *sessionTracker) touch(userID uint64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	state, ok := t.sessions[userID]
	if !ok {
		return
	}
	state.lastSeen = time.Now()
	t.sessions[userID] = state
}

func (t *sessionTracker) forget(userID uint64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.sessions, userID)
}

// expired reports whether the session hit the idle limit or the absolute
// lifetime limit. Sessions started before a restart are not tracked and are
// therefore treated as valid.
func (t *sessionTracker) expired(userID uint64) bool {
	t.mu.Lock()
	state, ok := t.sessions[userID]
	t.mu.Unlock()
	if !ok {
		return false
	}

	policy := loadSessionPolicy()
	now := time.Now()
	if policy.maxIdle > 0 && now.Sub(state.lastSeen) > policy.maxIdle {
		return true
	}
	return policy.maxLifetime > 0 && now.Sub(state.startedAt) > policy.maxLifetime
}
