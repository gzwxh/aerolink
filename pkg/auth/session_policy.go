package auth

import (
	"errors"
	"sync"
	"time"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

const sessionPolicyCacheTTL = 10 * time.Second

// sessionPolicy 是根据安全设置解析出来的会话策略。
type sessionPolicy struct {
	expireOnBrowserClose bool
	maxIdle              time.Duration
	maxLifetime          time.Duration
	// singleDevice 只保留最近一次登录：同一个用户一旦开始新会话，
	// 旧令牌立即被拒绝。
	singleDevice bool
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
			policy.singleDevice = setting.SingleDeviceLogin
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

// ResetSessionPolicyCache 让下一个请求重新加载策略。安全设置的处理函数会调用它，
// 这样新的会话限制会立即生效。
func ResetSessionPolicyCache() {
	sessionPolicyMu.Lock()
	sessionPolicyCached = time.Time{}
	sessionPolicyMu.Unlock()
}

// authCookieMaxAge 是 auth_token cookie 的生存期。为零时它是会话 cookie，
// 浏览器关闭即丢弃。
func authCookieMaxAge() int {
	if loadSessionPolicy().expireOnBrowserClose {
		return 0
	}
	return common.CookieExpirationSeconds
}

// sessionStateCacheTTL 是一台机器上「会话状态」缓存的有效期，也就是「顶下线 /
// 空闲超时」最多晚多久生效。超过它就回源数据库，所以多副本之间最多差这么久。
const sessionStateCacheTTL = 30 * time.Second

// sessionLastSeenFlushInterval 是「最近活动时间」回写数据库的最小间隔。
// 每个请求都回写会让数据库承受无意义的写压力（并让 SQLite 的单写入者成为瓶颈），
// 而空闲限制本身是以分钟计的，晚一分钟回写足够。
const sessionLastSeenFlushInterval = 60 * time.Second

// maxTrackedSessions 限制单机缓存的行数，避免内存随访问过的用户数无限增长。
const maxTrackedSessions = 4096

// sessionState 是一台机器对某个用户会话状态的缓存。
type sessionState struct {
	startedAt time.Time
	lastSeen  time.Time
	// seq 标识启动本次会话的那次登录。令牌携带签发时的 seq，这样更新的一次登录
	// 可以确定地让旧令牌失效（时间戳只有秒级精度）。
	seq uint64
	// ended 表示这次会话已经由用户主动退出登录结束（见 sessionTracker.end）。
	// 已结束的会话不再算「仍在使用的会话」，因此紧接着的登录不该被报成顶下线。
	ended bool
	// loadedAt 是本条状态从数据库读到的时间：超过 sessionStateCacheTTL 就回源。
	loadedAt time.Time
	// persistedAt 是 lastSeen 最后一次写回数据库的时间，用来做回写节流。
	persistedAt time.Time
	// tookOver 记录本次登录替换掉了一个仍在跟踪中的会话（单设备策略开启时），
	// 用于在客户端提示用户（见 bootstrapSession.Superseded）。
	//
	// 它只放在本机缓存里，不入库：这是「刚刚这次登录」的一次性提示，而库里的那行是
	// 用户级共享状态。多副本下如果紧接着的 bootstrap 请求落到别的机器，这条提示可能
	// 不显示——顶下线本身照常生效（由 seq 保证），这里只是少一次提示。
	tookOver bool
}

// sessionTracker 记录已登录会话的开始时间与最近活动时间，以便执行空闲时长与绝对
// 生存期的限制。
//
// 状态**存在数据库里**（`model.UserSession`），进程内只保留一份短时缓存：
// 内存里那份在多副本之间互不可见，会让「顶下线」「空闲超时」两台机器各判各的。
// 数据库不可用或读不到状态时保持失败开放（视为有效），与重启后不踢人的既有行为一致。
type sessionTracker struct {
	mu     sync.Mutex
	states map[uint64]*sessionState
	// db 记住缓存对应的是哪一个数据库连接：测试会换内存库（生产不会换），
	// 换库后必须整体丢弃，否则上一套库的状态会被当成这一套库的。
	db *gorm.DB
}

var activeSessions = &sessionTracker{states: map[uint64]*sessionState{}}

// load 取回某个用户的会话状态：缓存命中就直接用，否则回源数据库。
// 返回 nil 表示没有可用状态（没有记录、或数据库读失败）。
func (t *sessionTracker) load(userID uint64, now time.Time) *sessionState {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.loadLocked(userID, now)
}

// loadLocked 与 load 相同，但要求调用方已经持有 t.mu。
func (t *sessionTracker) loadLocked(userID uint64, now time.Time) *sessionState {
	if t.db != model.DB {
		t.states = map[uint64]*sessionState{}
		t.db = model.DB
	}
	// 没有数据库（单元测试里可能出现）时按「没有状态」处理，保持失败开放。
	if model.DB == nil {
		return nil
	}
	if state, ok := t.states[userID]; ok && now.Sub(state.loadedAt) < sessionStateCacheTTL {
		return state
	}

	session, err := model.GetUserSession(uint(userID))
	if err != nil {
		// 没有记录（用户还没登录过、或已被清理）与读失败都按「没有状态」处理：
		// 都是失败开放，不会把人挡在门外。
		delete(t.states, userID)
		return nil
	}

	state := &sessionState{
		startedAt:   session.StartedAt,
		lastSeen:    session.LastSeen,
		seq:         session.Seq,
		ended:       session.EndedAt != nil,
		loadedAt:    now,
		persistedAt: session.LastSeen,
	}
	t.storeLocked(userID, state)
	return state
}

// storeLocked 写入缓存，并在必要时裁剪过期的行。
func (t *sessionTracker) storeLocked(userID uint64, state *sessionState) {
	if _, exists := t.states[userID]; !exists && len(t.states) >= maxTrackedSessions {
		for id, cached := range t.states {
			if time.Since(cached.loadedAt) >= sessionStateCacheTTL {
				delete(t.states, id)
			}
		}
		for id := range t.states {
			if len(t.states) < maxTrackedSessions {
				break
			}
			delete(t.states, id)
		}
	}
	t.states[userID] = state
}

// start 记录一次新的登录，并报告它是否接管了单设备策略下仍在跟踪的会话。
// 调用方据此提醒用户与管理员
// （见 notification.NotifySessionTakeover）。
func (t *sessionTracker) start(userID uint64) bool {
	if userID == 0 {
		return false
	}
	singleDevice := loadSessionPolicy().singleDevice
	now := time.Now()

	// 先拿一份最新状态，用来判断「是否真的顶掉了一个仍然有效的会话」。
	// 重启后库里可能留着早就过期的行，那种不算顶下线，不该发通知。
	previous := t.load(userID, now)

	var session *model.UserSession
	var err error
	if model.DB == nil {
		err = errors.New("no database")
	} else {
		session, err = model.StartUserSession(uint(userID), now)
	}
	if err != nil {
		klog.Errorf("failed to record the session for user %d: %v", userID, err)
		// 记不下就只更新内存：seq 取「已知的最大值 + 1」。签发的令牌序号偏大是安全的
		// （superseded 只拒绝更小的序号），代价是这台机器掉线期间顶下线判定会退化。
		seq := uint64(1)
		if previous != nil {
			seq = previous.seq + 1
		}
		t.mu.Lock()
		t.storeLocked(userID, &sessionState{
			startedAt: now,
			lastSeen:  now,
			seq:       seq,
			loadedAt:  now,
		})
		t.mu.Unlock()
		return false
	}

	// 只有「仍在使用的会话」才算被顶下线：用户自己退出登录之后再登录，上一个会话已经
	// 结束，不该报成别的设备被踢（否则会在同一台设备上弹出一条误导性的安全提示）。
	tookOver := singleDevice && previous != nil && !previous.ended && !sessionExpired(*previous, now)

	t.mu.Lock()
	t.storeLocked(userID, &sessionState{
		startedAt:   session.StartedAt,
		lastSeen:    session.LastSeen,
		seq:         session.Seq,
		loadedAt:    now,
		persistedAt: now,
		tookOver:    tookOver,
	})
	t.mu.Unlock()

	return tookOver
}

// end 记录用户主动退出登录（注销）。与 forget 不同，它保留会话序号——删行会让序号
// 从 1 重新开始，已作废的旧令牌会重新变得有效（见 model.EndUserSession）。
// 标记本身存在库里，所以多副本下另一台机器也能看到。
func (t *sessionTracker) end(userID uint64) {
	if userID == 0 {
		return
	}
	now := time.Now()

	t.mu.Lock()
	if state, ok := t.states[userID]; ok {
		state.ended = true
		state.loadedAt = now
	}
	t.mu.Unlock()

	if err := model.EndUserSession(uint(userID), now); err != nil {
		klog.V(4).Infof("failed to record the sign-out for user %d: %v", userID, err)
	}
}

// current 返回用户最新会话的跟踪状态。当用户没有已跟踪的会话时
// （例如重启之后），第二个返回值为 false。
func (t *sessionTracker) current(userID uint64) (sessionState, bool) {
	now := time.Now()
	state := t.load(userID, now)
	if state == nil {
		return sessionState{}, false
	}
	return *state, true
}

// currentSeq 返回用户最新登录的序号，也就是此刻签发的令牌必须携带的序号。
// 为零表示用户没有已跟踪的会话，
// 此时回退到失败开放的行为。
func (t *sessionTracker) currentSeq(userID uint64) uint64 {
	state := t.load(userID, time.Now())
	if state == nil {
		return 0
	}
	return state.seq
}

// touch 刷新最近活动时间。内存里每次请求都更新，但最多每
// sessionLastSeenFlushInterval 回写一次数据库。
func (t *sessionTracker) touch(userID uint64) {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()

	state := t.loadLocked(userID, now)
	if state == nil {
		return
	}
	state.lastSeen = now
	if now.Sub(state.persistedAt) < sessionLastSeenFlushInterval {
		return
	}
	state.persistedAt = now
	if err := model.TouchUserSession(uint(userID), now); err != nil {
		klog.V(4).Infof("failed to persist last activity for user %d: %v", userID, err)
	}
}

// forget 丢弃某个用户的会话状态（空闲超时被踢下线）。
func (t *sessionTracker) forget(userID uint64) {
	t.mu.Lock()
	delete(t.states, userID)
	t.mu.Unlock()

	if err := model.DeleteUserSession(uint(userID)); err != nil {
		klog.V(4).Infof("failed to delete the session state for user %d: %v", userID, err)
	}
}

// supersededSeq 报告携带 tokenSeq 的令牌是否属于已被更新登录替换掉的会话。
// 在这套机制之前（或策略启用之前）签发的令牌携带 seq 0，
// 因此用户再次登录后就会被拒绝。
func supersededSeq(trackedSeq uint64, tokenSeq uint64) bool {
	return tokenSeq < trackedSeq
}

// superseded 报告令牌是否属于被单设备策略替换掉的旧会话。策略关闭或会话
// 未被跟踪时（例如重启之后）它是空操作，
// 与其它会话限制的失败开放行为保持一致。
func (t *sessionTracker) superseded(userID uint64, tokenSeq uint64) bool {
	if !loadSessionPolicy().singleDevice {
		return false
	}
	state := t.load(userID, time.Now())
	if state == nil {
		return false
	}
	return supersededSeq(state.seq, tokenSeq)
}

// expired 报告会话是否触发了空闲限制或绝对生存期限制。
// 没有被跟踪的会话（例如重启之前签发的、或数据库读不到时）
// 被视为有效。
func (t *sessionTracker) expired(userID uint64) bool {
	state := t.load(userID, time.Now())
	if state == nil {
		return false
	}
	return sessionExpired(*state, time.Now())
}

// sessionExpired 按当前策略判断一份会话状态是否已超时。
func sessionExpired(state sessionState, now time.Time) bool {
	policy := loadSessionPolicy()
	if policy.maxIdle > 0 && now.Sub(state.lastSeen) > policy.maxIdle {
		return true
	}
	return policy.maxLifetime > 0 && now.Sub(state.startedAt) > policy.maxLifetime
}
