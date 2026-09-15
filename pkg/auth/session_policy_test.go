package auth

import (
	"testing"
	"time"
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

// cacheSessionPolicy pins the cached session policy for the duration of a test.
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

func TestSessionTrackerSuperseded(t *testing.T) {
	tracker := &sessionTracker{sessions: map[uint64]sessionState{}}

	// Untracked session (e.g. after a restart): fail open.
	cacheSessionPolicy(t, sessionPolicy{singleDevice: true})
	if tracker.superseded(7, 1) {
		t.Fatal("untracked session must not be reported as superseded")
	}

	// Tracked, but the policy is off.
	tracker.start(7)
	currentSeq := tracker.currentSeq(7)
	cacheSessionPolicy(t, sessionPolicy{})
	if tracker.superseded(7, currentSeq-1) {
		t.Fatal("older token must stay valid while the policy is off")
	}

	// Policy on: an older sequence is rejected, the current one is not.
	cacheSessionPolicy(t, sessionPolicy{singleDevice: true})
	if !tracker.superseded(7, currentSeq-1) {
		t.Fatal("older session must be superseded while single device is enabled")
	}
	if tracker.superseded(7, currentSeq) {
		t.Fatal("the newest session must stay valid")
	}

	// A second sign-in bumps the sequence and retires the first one.
	tracker.start(7)
	if !tracker.superseded(7, currentSeq) {
		t.Fatal("the first session must be superseded after signing in again")
	}
	if tracker.superseded(7, tracker.currentSeq(7)) {
		t.Fatal("the newest session must stay valid after signing in again")
	}
}
