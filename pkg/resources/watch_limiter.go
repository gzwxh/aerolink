package resources

import (
	"sync"
	"time"
)

// watchLimitExceededCode 是限流响应体里的机器可读标识，前端据此降级为轮询
// （与 `ApiError.code` 同一口径，前端不去匹配提示文本）。
const watchLimitExceededCode = "watch_limit_exceeded"

// watchLimitRetryAfter 是限流响应里 Retry-After 的取值：
// 提示调用方（以及中间的代理）多久之后再来试。
const watchLimitRetryAfter = 30 * time.Second

// watchLimiter 按 (用户, 集群) 统计本进程内活跃的资源 watch（SSE）连接数。
//
// 一条 watch 连接会常驻占用一个 apiserver 流与一个浏览器「每源 6 连接」名额，
// 而打开多个标签页 / 多个详情页时连接数会随手翻倍。这里给每个用户在每个集群上
// 设一个上限：超限的新连接直接拒绝（HTTP 429），由前端降级为轮询，
// 而不是让连接数无界增长（P3）。
//
// 只统计本进程：多副本部署时每个副本各自计数，上限是「每副本每用户」，
// 与 SSE 连接本身不跨副本路由的现状一致。
type watchLimiter struct {
	mu    sync.Mutex
	conns map[watchLimiterKey]int
}

type watchLimiterKey struct {
	user    string
	cluster string
}

func newWatchLimiter() *watchLimiter {
	return &watchLimiter{conns: make(map[watchLimiterKey]int)}
}

// acquire 尝试占用一个名额。limit <= 0 表示不限制。
// 返回的 release 必须调用（重复调用安全），否则名额不会释放。
func (l *watchLimiter) acquire(user, cluster string, limit int) (func(), bool) {
	if limit <= 0 {
		return func() {}, true
	}

	key := watchLimiterKey{user: user, cluster: cluster}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conns[key] >= limit {
		return nil, false
	}
	l.conns[key]++

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if n := l.conns[key]; n > 1 {
				l.conns[key] = n - 1
			} else {
				// 删掉归零的键，避免长期运行后 map 里堆满不再活跃的用户。
				delete(l.conns, key)
			}
		})
	}, true
}

// active 返回该 (用户, 集群) 当前的连接数，仅用于测试与排查。
func (l *watchLimiter) active(user, cluster string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.conns[watchLimiterKey{user: user, cluster: cluster}]
}

// podWatchLimiter 是 Pod SSE watch 使用的进程级限额器。
var podWatchLimiter = newWatchLimiter()
