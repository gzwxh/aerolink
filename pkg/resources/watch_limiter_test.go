package resources

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"aerolink/pkg/rbac"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// TestWatchLimiterEnforcesPerUserClusterLimit 覆盖 P3 的计数口径：
// 名额按 (用户, 集群) 独立计算，超限拒绝，release 之后名额可被复用。
func TestWatchLimiterEnforcesPerUserClusterLimit(t *testing.T) {
	limiter := newWatchLimiter()

	releaseA1, ok := limiter.acquire("alice", "cluster-a", 2)
	if !ok {
		t.Fatal("第 1 个连接应被接受")
	}
	releaseA2, ok := limiter.acquire("alice", "cluster-a", 2)
	if !ok {
		t.Fatal("第 2 个连接应被接受")
	}
	if _, ok := limiter.acquire("alice", "cluster-a", 2); ok {
		t.Fatal("超过上限的连接应被拒绝")
	}

	// 换集群、换用户各自独立计数：别人满员不该影响自己。
	if _, ok := limiter.acquire("alice", "cluster-b", 2); !ok {
		t.Fatal("另一个集群不应受 cluster-a 的占用影响")
	}
	if _, ok := limiter.acquire("bob", "cluster-a", 2); !ok {
		t.Fatal("另一个用户不应受 alice 的占用影响")
	}

	releaseA1()
	if _, ok := limiter.acquire("alice", "cluster-a", 2); !ok {
		t.Fatal("释放后名额应可复用")
	}
	// release 幂等：重复调用不能把别人占用的名额一起放掉。
	releaseA1()
	if got := limiter.active("alice", "cluster-a"); got != 2 {
		t.Fatalf("active(alice, cluster-a) = %d, want 2", got)
	}

	releaseA2()
	if got := limiter.active("alice", "cluster-a"); got != 1 {
		t.Fatalf("active(alice, cluster-a) = %d, want 1", got)
	}
}

// TestWatchLimiterDisabled 覆盖 limit <= 0（AEROLINK_MAX_WATCH_PER_USER=0）时不限制。
func TestWatchLimiterDisabled(t *testing.T) {
	limiter := newWatchLimiter()

	for i := 0; i < 100; i++ {
		release, ok := limiter.acquire("alice", "cluster-a", 0)
		if !ok {
			t.Fatalf("第 %d 个连接在关闭限额时仍被拒绝", i+1)
		}
		t.Cleanup(release)
	}
	if got := limiter.active("alice", "cluster-a"); got != 0 {
		t.Fatalf("关闭限额时不应计数，active = %d", got)
	}
}

// TestPodWatchRejectsOverLimitConnections 覆盖 P3 的服务端行为：同一用户在同一集群上
// 的并发 watch 超过 AEROLINK_MAX_WATCH_PER_USER 时，新连接在建立上游 watch 之前
// 就被拒绝（429 + 机器可读的 code + Retry-After），前端据此降级为轮询；
// 连接释放后名额可以复用。
func TestPodWatchRejectsOverLimitConnections(t *testing.T) {
	originalLimit := common.MaxWatchPerUser
	common.MaxWatchPerUser = 2
	t.Cleanup(func() { common.MaxWatchPerUser = originalLimit })

	originalLimiter := podWatchLimiter
	podWatchLimiter = newWatchLimiter()
	t.Cleanup(func() { podWatchLimiter = originalLimiter })

	originalConfig := rbac.RBACConfig
	t.Cleanup(func() { rbac.RBACConfig = originalConfig })

	// 上游 watch 挂住不返回，让连接持续占住名额。
	watchServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
	}))
	t.Cleanup(watchServer.Close)

	clientSet, err := kubernetes.NewForConfig(&rest.Config{Host: watchServer.URL})
	if err != nil {
		t.Fatal(err)
	}

	roles := []common.Role{{
		Name:       "pod-default-reader",
		Clusters:   []string{"cluster-a"},
		Namespaces: []string{"default"},
		Resources:  []string{string(common.Pods)},
		Verbs:      []string{string(common.VerbGet)},
	}}
	rbac.RBACConfig = &common.RolesConfig{
		Roles: roles,
		RoleMapping: []common.RoleMapping{
			{Name: "pod-default-reader", Users: []string{"alice"}},
		},
	}
	fixture := newPodAPITestFixture(t, podAPITestConfig{
		user:              model.User{Username: "alice", Roles: roles},
		clusterAClientSet: clientSet,
	})

	server := httptest.NewServer(fixture.router)
	t.Cleanup(server.Close)

	watchURL := server.URL + "/api/v1/pods/default/watch"
	var cancels []context.CancelFunc
	t.Cleanup(func() {
		for _, cancel := range cancels {
			cancel()
		}
	})

	openWatch := func() *http.Response {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, watchURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = response.Body.Close() })
		cancels = append(cancels, cancel)
		return response
	}

	for i := 0; i < common.MaxWatchPerUser; i++ {
		//nolint:bodyclose // 连接需保持打开以占用限额名额，body 由 openWatch 注册的 t.Cleanup 关闭
		if response := openWatch(); response.StatusCode != http.StatusOK {
			t.Fatalf("第 %d 条连接返回 %d, want %d", i+1, response.StatusCode, http.StatusOK)
		}
	}
	waitForWatchConnections(t, "alice", "cluster-a", common.MaxWatchPerUser)

	//nolint:bodyclose // 读完 body 后已显式 Close，另有 openWatch 注册的 t.Cleanup 兜底
	overLimit := openWatch()
	if overLimit.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("超限连接返回 %d, want %d", overLimit.StatusCode, http.StatusTooManyRequests)
	}
	if got := overLimit.Header.Get("Retry-After"); got != "30" {
		t.Fatalf("Retry-After = %q, want %q", got, "30")
	}
	body, err := io.ReadAll(overLimit.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), watchLimitExceededCode) {
		t.Fatalf("超限响应缺少 code %q; body=%s", watchLimitExceededCode, body)
	}
	// 被拒绝的连接不占用名额，也不该把计数打乱。
	if got := podWatchLimiter.active("alice", "cluster-a"); got != common.MaxWatchPerUser {
		t.Fatalf("被拒绝后 active = %d, want %d", got, common.MaxWatchPerUser)
	}

	// 断开一条后名额释放，新连接可以正常建立。
	cancels[0]()
	waitForWatchConnections(t, "alice", "cluster-a", common.MaxWatchPerUser-1)
	//nolint:bodyclose // 连接需保持打开以占用限额名额，body 由 openWatch 注册的 t.Cleanup 关闭
	if response := openWatch(); response.StatusCode != http.StatusOK {
		t.Fatalf("释放名额后连接返回 %d, want %d", response.StatusCode, http.StatusOK)
	}
}

// waitForWatchConnections 等待限额计数落到期望值：连接的释放在服务端 goroutine 里完成，
// 测试需要给它一点时间。
func waitForWatchConnections(t *testing.T, user, cluster string, want int) {
	t.Helper()

	deadline := time.Now().Add(5 * time.Second)
	for {
		if got := podWatchLimiter.active(user, cluster); got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("等待 %s/%s 的连接数降到 %d 超时，当前 = %d", user, cluster, want, podWatchLimiter.active(user, cluster))
		}
		time.Sleep(10 * time.Millisecond)
	}
}
