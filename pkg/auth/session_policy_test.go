package auth

import (
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

func TestSupersededSeq(t *testing.T) {
	cases := []struct {
		name       string
		trackedSeq uint64
		tokenSeq   uint64
		want       bool
	}{
		{"token from an older sign-in", 5, 4, true},
		{"token minted before the mechanism (seq 0)", 3, 0, true},
		{"token from the current sign-in", 5, 5, false},
		{"untracked user", 0, 0, false},
	}
	for _, c := range cases {
		if got := supersededSeq(c.trackedSeq, c.tokenSeq); got != c.want {
			t.Errorf("%s: supersededSeq(%d, %d) = %v, want %v",
				c.name, c.trackedSeq, c.tokenSeq, got, c.want)
		}
	}
}

// cacheSessionPolicy 在测试期间固定缓存中的会话策略。
func cacheSessionPolicy(t *testing.T, policy sessionPolicy) {
	t.Helper()
	sessionPolicyMu.Lock()
	previousPolicy, previousAt := sessionPolicyCache, sessionPolicyCached
	sessionPolicyCache, sessionPolicyCached = policy, time.Now()
	sessionPolicyMu.Unlock()
	t.Cleanup(func() {
		sessionPolicyMu.Lock()
		sessionPolicyCache, sessionPolicyCached = previousPolicy, previousAt
		sessionPolicyMu.Unlock()
	})
}

// newTestSessionTracker 建一个干净的跟踪器（相当于一台新启动的机器）。
func newTestSessionTracker() *sessionTracker {
	return &sessionTracker{states: map[uint64]*sessionState{}}
}

// dropCache 丢掉某个跟踪器的进程内缓存，模拟缓存过期或重启。
func dropCache(tracker *sessionTracker) {
	tracker.mu.Lock()
	tracker.states = map[uint64]*sessionState{}
	tracker.mu.Unlock()
}

func loadSessionRow(t *testing.T, userID uint) *model.UserSession {
	t.Helper()
	session, err := model.GetUserSession(userID)
	if err != nil {
		t.Fatalf("reading the session row: %v", err)
	}
	return session
}

func TestSessionTrackerSuperseded(t *testing.T) {
	setupAuthIntegrationDB(t)
	tracker := newTestSessionTracker()

	// 未被跟踪的会话（例如重启之后）：失败开放。
	cacheSessionPolicy(t, sessionPolicy{singleDevice: true})
	if tracker.superseded(7, 1) {
		t.Fatal("untracked session must not be reported as superseded")
	}

	// 已被跟踪，但策略处于关闭状态。
	tracker.start(7)
	currentSeq := tracker.currentSeq(7)
	if currentSeq == 0 {
		t.Fatal("start() did not record a session")
	}
	cacheSessionPolicy(t, sessionPolicy{})
	if tracker.superseded(7, currentSeq-1) {
		t.Fatal("older token must stay valid while the policy is off")
	}

	// 策略开启：更旧的序号被拒绝，当前的不会。
	cacheSessionPolicy(t, sessionPolicy{singleDevice: true})
	if !tracker.superseded(7, currentSeq-1) {
		t.Fatal("older session must be superseded while single device is enabled")
	}
	if tracker.superseded(7, currentSeq) {
		t.Fatal("the newest session must stay valid")
	}

	// 第二次登录会推进序号，并让第一次登录失效。
	tracker.start(7)
	if !tracker.superseded(7, currentSeq) {
		t.Fatal("the first session must be superseded after signing in again")
	}
	if tracker.superseded(7, tracker.currentSeq(7)) {
		t.Fatal("the newest session must stay valid after signing in again")
	}
}

// 会话状态存在数据库里，所以「另一台机器」不认识这个用户也能正确判定——
// 这正是多副本下「顶下线」能生效的原因。
func TestSessionTrackerIsSharedAcrossReplicas(t *testing.T) {
	setupAuthIntegrationDB(t)
	cacheSessionPolicy(t, sessionPolicy{singleDevice: true})

	replicaA := newTestSessionTracker()
	replicaB := newTestSessionTracker()

	replicaA.start(11)
	seqA := replicaA.currentSeq(11)
	if seqA == 0 {
		t.Fatal("replica A did not record a session")
	}

	if !replicaB.superseded(11, seqA-1) {
		t.Fatal("replica B must reject a token older than the session replica A recorded")
	}
	if replicaB.superseded(11, seqA) {
		t.Fatal("replica B must accept the current token")
	}

	// A 上再次登录：B 的缓存可能还是旧的（≤30 秒，已知取舍），
	// 但缓存过期后会从库里读到新序号并让旧令牌失效。
	replicaA.start(11)
	dropCache(replicaB)
	if !replicaB.superseded(11, seqA) {
		t.Fatal("replica B did not pick up the newer sign-in from the database")
	}
}

// 「最近活动时间」不能每个请求都回写数据库：节流到
// sessionLastSeenFlushInterval 一次，空闲限制本身以分钟计，晚一分钟足够。
func TestSessionTrackerThrottlesLastSeenWrites(t *testing.T) {
	setupAuthIntegrationDB(t)
	tracker := newTestSessionTracker()

	tracker.start(21)
	afterStart := loadSessionRow(t, 21).LastSeen

	for i := 0; i < 5; i++ {
		tracker.touch(21)
	}
	if got := loadSessionRow(t, 21).LastSeen; !got.Equal(afterStart) {
		t.Fatalf("touching inside the flush window wrote to the database: last_seen = %v, want %v", got, afterStart)
	}

	// 把「上次回写时间」推早到节流窗口之外，下一次 touch 就必须回写。
	tracker.mu.Lock()
	tracker.states[21].persistedAt = time.Now().Add(-sessionLastSeenFlushInterval - time.Second)
	tracker.mu.Unlock()

	tracker.touch(21)
	if got := loadSessionRow(t, 21).LastSeen; !got.After(afterStart) {
		t.Fatalf("last_seen was not persisted after the flush window: %v", got)
	}
}

// 空闲超时按数据库里的最近活动时间判定，因此另一台机器上启动的会话同样会被踢。
func TestSessionTrackerExpiredUsesStoredActivity(t *testing.T) {
	setupAuthIntegrationDB(t)
	cacheSessionPolicy(t, sessionPolicy{maxIdle: time.Minute})

	tracker := newTestSessionTracker()
	tracker.start(31)

	replicaB := newTestSessionTracker()
	if replicaB.expired(31) {
		t.Fatal("a session that just started must not be reported as expired")
	}

	// 模拟「两分钟没有任何活动」。
	if err := model.TouchUserSession(31, time.Now().Add(-2*time.Minute)); err != nil {
		t.Fatalf("updating last_seen: %v", err)
	}
	replicaC := newTestSessionTracker()
	if !replicaC.expired(31) {
		t.Fatal("a session idle beyond the policy must be reported as expired")
	}
}

// 退出登录后再登录不能算「顶掉了另一台设备」：否则用户会在自己刚注销的浏览器上收到
// 一条「其他设备的会话已退出」的安全提示。
func TestSessionTrackerSignOutIsNotATakeover(t *testing.T) {
	setupAuthIntegrationDB(t)
	cacheSessionPolicy(t, sessionPolicy{singleDevice: true})
	tracker := newTestSessionTracker()

	// 第一次登录：没有别的会话可顶。
	if tracker.start(51) {
		t.Fatal("the first sign-in must not report a takeover")
	}

	// 退出后再登录：上一个会话已经结束，不该报顶下线。
	tracker.end(51)
	if tracker.start(51) {
		t.Fatal("signing in right after signing out must not report a takeover")
	}

	// 仍然登录着的时候再登录：这才是真正的顶下线。
	if !tracker.start(51) {
		t.Fatal("signing in while another session is still active must report a takeover")
	}

	// 结束标记写在库里，所以另一台机器（或本机缓存过期后）同样不会误报。
	tracker.end(51)
	if newTestSessionTracker().start(51) {
		t.Fatal("another replica must also treat the signed-out session as finished")
	}
}

// 退出登录不能回退序号：作废判定是「令牌序号 < 当前序号」，序号回到 1 会让旧令牌复活。
func TestSessionTrackerSignOutKeepsSeq(t *testing.T) {
	setupAuthIntegrationDB(t)
	cacheSessionPolicy(t, sessionPolicy{singleDevice: true})
	tracker := newTestSessionTracker()

	tracker.start(52)
	before := tracker.currentSeq(52)
	tracker.end(52)

	if got := tracker.currentSeq(52); got != before {
		t.Fatalf("seq after sign-out = %d, want it to stay %d", got, before)
	}
	if !tracker.superseded(52, before-1) {
		t.Fatal("a token older than the signed-out session must stay superseded")
	}
}

// forget（空闲被踢下线）要把库里的状态一起清掉，否则下一次登录的序号会接着旧会话继续涨。
func TestSessionTrackerForgetClearsStoredState(t *testing.T) {
	setupAuthIntegrationDB(t)
	tracker := newTestSessionTracker()

	tracker.start(41)
	tracker.forget(41)

	if _, err := model.GetUserSession(41); err == nil {
		t.Fatal("forget() left the session row behind")
	}
	if _, ok := tracker.current(41); ok {
		t.Fatal("forget() left the cached state behind")
	}

	tracker.start(41)
	if seq := tracker.currentSeq(41); seq != 1 {
		t.Fatalf("seq after forget = %d, want the count to restart at 1", seq)
	}
}
