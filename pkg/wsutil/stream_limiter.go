package wsutil

import (
	"fmt"
	"sync"

	"github.com/zxh326/kite/pkg/common"
	"k8s.io/klog/v2"
)

// StreamLimitExceededCode 是超限错误帧里的机器可读标识（与 watch 限流的
// `watch_limit_exceeded` 同一口径），前端要按码而不是按文案判断。
const StreamLimitExceededCode = "stream_limit_exceeded"

// streamLimiter 按用户统计本进程内活跃的**流式会话**（Pod 日志、Pod 终端、
// 节点终端、kubectl 终端）总数。
//
// 每一条这样的连接都常驻占用一条到 apiserver 的日志流 / exec 流，并且不会随
// 标签页增多而回收：多人多标签一起打开时，AeroLink、apiserver、kubelet 三处的
// 连接与内存会同步无界上涨（验收台账 D-55）。这里给每个用户一个并发上限，
// 超限的新会话被明确拒绝并给出原因，而不是把整台集群拖慢。
//
// 只统计本进程：多副本部署时每个副本各自计数，上限是「每副本每用户」，
// 与 WebSocket 连接本身不跨副本路由的现状一致。
type streamLimiter struct {
	mu     sync.Mutex
	active map[string]int
}

func newStreamLimiter() *streamLimiter {
	return &streamLimiter{active: make(map[string]int)}
}

// 日志与终端共用一个限额器：它们抢的是同一类资源（apiserver 流）。
var streams = newStreamLimiter()

// acquire 尝试占用一个名额。limit <= 0 表示不限制。
// 返回的 release 必须调用（重复调用安全），否则名额永不释放。
func (l *streamLimiter) acquire(username string, limit int) (func(), bool) {
	if limit <= 0 {
		return func() {}, true
	}

	l.mu.Lock()
	if l.active[username] >= limit {
		l.mu.Unlock()
		return nil, false
	}
	l.active[username]++
	l.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if n := l.active[username]; n > 1 {
				l.active[username] = n - 1
			} else {
				// 删掉归零的键，避免长期运行后 map 里堆满不再活跃的用户。
				delete(l.active, username)
			}
		})
	}, true
}

// count 返回该用户当前占用的会话数，仅用于测试与排查。
func (l *streamLimiter) count(username string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.active[username]
}

// AcquireStream 为用户登记一次流式会话（日志与终端共用同一个名额池）。
// 超限返回 false，调用方应当先给客户端发一条带 code=StreamLimitExceededCode
// 的错误帧说明原因，再结束会话。
func AcquireStream(username string, limit int) (func(), bool) {
	return streams.acquire(username, limit)
}

// ActiveStreams 返回该用户当前活跃的流式会话数。
func ActiveStreams(username string) int {
	return streams.count(username)
}

// LimitStream 在会话开始时占用一个每用户名额。占用失败时已经把原因（带
// StreamLimitExceededCode）发给客户端并返回 ok=false，调用方直接 return；
// 成功时返回的 release 必须 defer。
func LimitStream(ws *Session, username string) (func(), bool) {
	release, ok := AcquireStream(username, common.MaxStreamsPerUser)
	if !ok {
		klog.Warningf("拒绝用户 %s 的新流式会话：已达每用户上限 %d",
			username, common.MaxStreamsPerUser)
		if err := SendErrorCode(ws.Conn, StreamLimitExceededCode,
			fmt.Sprintf("已达单用户并发上限（%d 个日志/终端会话）。请先关闭其它标签页或已有会话再试。",
				common.MaxStreamsPerUser)); err != nil {
			klog.V(1).Infof("发送流式会话超限提示失败: %v", err)
		}
		return func() {}, false
	}
	return release, true
}
