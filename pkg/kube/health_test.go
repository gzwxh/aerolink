package kube

import (
	"errors"
	"net/http"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const testStaleAfter = 45 * time.Second

func TestHealthSnapshotWithoutSuccessIsStale(t *testing.T) {
	h := NewHealth()
	now := time.Now()

	got := h.Snapshot(now, testStaleAfter)
	if !got.Stale || got.Reason != StaleReasonUnreachable {
		t.Fatalf("snapshot = %#v, want stale/unreachable before any successful probe", got)
	}
	if !got.LastOK.IsZero() || got.Age != 0 {
		t.Errorf("snapshot = %#v, want zero LastOK and Age", got)
	}
}

func TestHealthSnapshotThresholdBoundary(t *testing.T) {
	now := time.Now()

	// 正好等于阈值不算陈旧：阈值是「距上次成功已超过」，边界取严格大于。
	atThreshold := NewHealth()
	atThreshold.RecordProbeOK(now.Add(-testStaleAfter))
	if got := atThreshold.Snapshot(now, testStaleAfter); got.Stale {
		t.Errorf("age == staleAfter reported stale: %#v", got)
	} else if got.Age != testStaleAfter {
		t.Errorf("Age = %s, want %s", got.Age, testStaleAfter)
	}

	justOver := NewHealth()
	justOver.RecordProbeOK(now.Add(-testStaleAfter - time.Second))
	got := justOver.Snapshot(now, testStaleAfter)
	if !got.Stale || got.Reason != StaleReasonUnreachable {
		t.Errorf("age > staleAfter snapshot = %#v, want stale/unreachable", got)
	}
	if got.LastOK.IsZero() {
		t.Error("LastOK must be reported so the UI can say when data was last fresh")
	}
}

func TestHealthSnapshotDisablesAgeRuleWhenThresholdIsZero(t *testing.T) {
	now := time.Now()
	h := NewHealth()
	h.RecordProbeOK(now.Add(-24 * time.Hour))

	if got := h.Snapshot(now, 0); got.Stale {
		t.Errorf("staleAfter=0 must disable the age rule, got %#v", got)
	}
}

func TestHealthWatchErrorIsClearedBySuccessfulProbe(t *testing.T) {
	now := time.Now()
	h := NewHealth()
	h.RecordProbeOK(now.Add(-time.Second))

	if logged := h.RecordWatchError(errors.New("the server has asked for the client to provide credentials")); !logged {
		t.Error("first watch error must be logged")
	}
	got := h.Snapshot(now, testStaleAfter)
	if !got.Stale || got.Reason != StaleReasonWatchError {
		t.Fatalf("snapshot after watch error = %#v, want stale/watch-error", got)
	}

	// watch 错误的恢复判定只能靠主动探活：client-go 没有「已恢复」回调。
	h.RecordProbeOK(now)
	if got = h.Snapshot(now, testStaleAfter); got.Stale {
		t.Errorf("snapshot after successful probe = %#v, want healthy", got)
	}
}

// TestHealthIgnoresUnsupportedWatchError 覆盖 metrics.k8s.io 这类不支持 watch 的资源：
// informer 每轮都拿到 405，但集群本身是可达的，不能因此把数据标成陈旧。
func TestHealthIgnoresUnsupportedWatchError(t *testing.T) {
	now := time.Now()
	h := NewHealth()
	h.RecordProbeOK(now)

	unsupported := &apierrors.StatusError{ErrStatus: metav1.Status{
		Status:  metav1.StatusFailure,
		Code:    http.StatusMethodNotAllowed,
		Reason:  metav1.StatusReasonMethodNotAllowed,
		Message: `watch is not supported on resources of kind "pods.metrics.k8s.io"`,
	}}
	if logged := h.RecordWatchError(unsupported); logged {
		t.Error("不支持 watch 的错误不该按告警输出")
	}
	if got := h.Snapshot(now, testStaleAfter); got.Stale {
		t.Fatalf("snapshot after unsupported-watch error = %#v, want healthy", got)
	}

	// 真正的故障仍要标记陈旧，避免把这类错误一并放过。
	h.RecordWatchError(errors.New("connection refused"))
	if got := h.Snapshot(now, testStaleAfter); !got.Stale || got.Reason != StaleReasonWatchError {
		t.Fatalf("snapshot after real watch error = %#v, want stale/watch-error", got)
	}
}

func TestHealthProbeErrorDoesNotRefreshLastSuccess(t *testing.T) {
	now := time.Now()
	h := NewHealth()
	h.RecordProbeOK(now.Add(-10 * time.Second))
	h.RecordProbeError(errors.New("connection refused"))

	got := h.Snapshot(now, testStaleAfter)
	if got.Stale {
		t.Fatalf("a single failed probe must not trip the threshold early: %#v", got)
	}
	if got.Age != 10*time.Second {
		t.Errorf("Age = %s, want it to keep growing from the last success", got.Age)
	}

	// 失败本身不改状态，只有 Age 累积越过阈值才判陈旧。
	if got = h.Snapshot(now.Add(testStaleAfter+time.Second), testStaleAfter); !got.Stale {
		t.Errorf("snapshot after sustained probe failures = %#v, want stale", got)
	}
}

func TestHealthWatchErrorLogIsRateLimited(t *testing.T) {
	h := NewHealth()

	if !h.RecordWatchError(errors.New("boom")) {
		t.Fatal("first watch error must be logged")
	}
	if h.RecordWatchError(errors.New("boom")) {
		t.Error("second watch error within the interval must be suppressed")
	}
	if h.RecordWatchError(nil) {
		t.Error("a nil error is not a watch error and must not be logged")
	}

	// 超过限频窗口后再报一次：断连期间不会刷屏，但也不能永远静默。
	h.mu.Lock()
	h.watchErrLogAt = time.Now().Add(-watchErrLogInterval)
	h.mu.Unlock()
	if !h.RecordWatchError(errors.New("boom")) {
		t.Error("watch error after the rate-limit window must be logged again")
	}

	if got := h.LastWatchError(); got != "boom" {
		t.Errorf("LastWatchError = %q, want boom", got)
	}
}
