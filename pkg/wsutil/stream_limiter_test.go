package wsutil

import "testing"

// 回归（缺陷 D-55）：日志与终端会话此前没有任何并发上限，一个人多开几个标签页
// 就能把到 apiserver 的日志流 / exec 流数量无界拉高。
func TestStreamLimiterAcquireAndRelease(t *testing.T) {
	limiter := newStreamLimiter()

	first, ok := limiter.acquire("alice", 2)
	if !ok {
		t.Fatal("first acquire should succeed")
	}
	second, ok := limiter.acquire("alice", 2)
	if !ok {
		t.Fatal("second acquire should succeed")
	}
	if _, ok := limiter.acquire("alice", 2); ok {
		t.Fatal("third acquire must be rejected at limit 2")
	}
	if got := limiter.count("alice"); got != 2 {
		t.Fatalf("count = %d, want 2", got)
	}
	// 两个名额都得释放，否则后面的断言会被残留名额干扰
	defer second()

	// release 必须可重复调用（handler 里 defer + 错误分支都可能触发）
	first()
	first()
	if got := limiter.count("alice"); got != 1 {
		t.Fatalf("count after double release = %d, want 1", got)
	}
	if _, ok := limiter.acquire("alice", 2); !ok {
		t.Fatal("a slot must be reusable after release")
	}

	// 别的用户不受影响
	if _, ok := limiter.acquire("bob", 2); !ok {
		t.Fatal("bob should not be limited by alice")
	}
}

func TestStreamLimiterDisabled(t *testing.T) {
	limiter := newStreamLimiter()

	// limit <= 0 表示不限制，也不计数
	for range 5 {
		release, ok := limiter.acquire("carol", 0)
		if !ok {
			t.Fatal("limit 0 must never reject")
		}
		release()
	}
	if got := limiter.count("carol"); got != 0 {
		t.Fatalf("count = %d, want 0 when the limit is disabled", got)
	}
}

// 名额归零后要删键，否则长期运行会在 map 里堆满不再活跃的用户。
func TestStreamLimiterForgetsIdleUsers(t *testing.T) {
	limiter := newStreamLimiter()

	release, ok := limiter.acquire("dave", 1)
	if !ok {
		t.Fatal("first acquire should succeed")
	}
	release()
	if len(limiter.active) != 0 {
		t.Fatalf("limiter still keeps %d keys after the last release", len(limiter.active))
	}
}
