package resources

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/kube"
	"aerolink/pkg/middleware"
	"github.com/gin-gonic/gin"
	dto "github.com/prometheus/client_model/go"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/rest"
	toolscache "k8s.io/client-go/tools/cache"
	metricsv1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// stubPodCache 只实现 hub 真正用到的方法（GetInformer），
// 其余 cache.Cache 方法由嵌入的接口兜底（调用即 panic，测试不会走到）。
type stubPodCache struct {
	cache.Cache
	informer *stubPodInformer
}

func (s *stubPodCache) GetInformer(context.Context, client.Object, ...cache.InformerGetOption) (cache.Informer, error) {
	return s.informer, nil
}

type stubPodInformer struct {
	cache.Informer
	handler   toolscache.ResourceEventHandler
	addCalls  int
	removeCal int
}

func (s *stubPodInformer) AddEventHandler(handler toolscache.ResourceEventHandler) (toolscache.ResourceEventHandlerRegistration, error) {
	s.handler = handler
	s.addCalls++
	return nil, nil
}

func (s *stubPodInformer) RemoveEventHandler(toolscache.ResourceEventHandlerRegistration) error {
	s.removeCal++
	return nil
}

func newPodWatchHubFixture(t *testing.T, clusterName string) (*cluster.ClientSet, *podWatchHub, *stubPodInformer) {
	t.Helper()
	informer := &stubPodInformer{}
	cs := &cluster.ClientSet{
		Name:      clusterName,
		K8sClient: &kube.K8sClient{Cache: &stubPodCache{informer: informer}},
	}
	hub, err := acquirePodWatchHub(cs)
	if err != nil {
		t.Fatalf("acquirePodWatchHub returned error: %v", err)
	}
	t.Cleanup(hub.close)
	if informer.handler == nil {
		t.Fatal("hub 未在 informer 上注册事件处理器")
	}
	return cs, hub, informer
}

// TestPodWatchHubSharesOneUpstreamWatch 覆盖 P1 的核心：无论多少连接，
// 每个集群只有一条上游 watch；hub 关闭后指标回落，并注销事件处理器。
func TestPodWatchHubSharesOneUpstreamWatch(t *testing.T) {
	const clusterName = "hub-shared-watch-cluster"
	cs, hub, informer := newPodWatchHubFixture(t, clusterName)

	if got := upstreamWatchGaugeValue(t, clusterName); got != 1 {
		t.Fatalf("upstream watches = %v, want 1", got)
	}

	// 同一客户端的后续请求必须复用同一个 hub，而不是各建一条上游 watch。
	again, err := acquirePodWatchHub(cs)
	if err != nil {
		t.Fatalf("second acquirePodWatchHub returned error: %v", err)
	}
	if again != hub {
		t.Fatal("同一客户端应复用同一个 hub")
	}
	if informer.addCalls != 1 {
		t.Fatalf("informer handler 注册次数 = %d, want 1", informer.addCalls)
	}
	if got := upstreamWatchGaugeValue(t, clusterName); got != 1 {
		t.Fatalf("upstream watches after second acquire = %v, want 1", got)
	}

	hub.close()
	if got := upstreamWatchGaugeValue(t, clusterName); got != 0 {
		t.Fatalf("upstream watches after close = %v, want 0", got)
	}
	if informer.removeCal != 1 {
		t.Fatalf("informer handler 注销次数 = %d, want 1", informer.removeCal)
	}
}

// TestPodWatchHubFiltersEvents 覆盖过滤口径：namespace、labelSelector 与 fieldSelector
// 都必须与直连 watch 一致，避免把不该看到的 Pod 推给用户。
func TestPodWatchHubFiltersEvents(t *testing.T) {
	_, hub, informer := newPodWatchHubFixture(t, "hub-filter-cluster")

	defaultWeb, err := hub.subscribe("default", "app=web", "")
	if err != nil {
		t.Fatalf("subscribe default: %v", err)
	}
	t.Cleanup(defaultWeb.Close)
	onNodeA, err := hub.subscribe("", "", "spec.nodeName=node-a")
	if err != nil {
		t.Fatalf("subscribe nodeSelector: %v", err)
	}
	t.Cleanup(onNodeA.Close)

	informer.handler.OnAdd(&corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-a", Namespace: "default", Labels: map[string]string{"app": "web"}},
		Spec:       corev1.PodSpec{NodeName: "node-a"},
	}, false)

	event, ok := receivePodWatchEvent(defaultWeb.Events(), time.Second)
	if !ok {
		t.Fatal("namespace+label 匹配的订阅者未收到事件")
	}
	if event.Pod == nil || event.Pod.Name != "web-a" || event.Type != watch.Added {
		t.Fatalf("事件内容不符: %+v", event)
	}
	if _, ok := receivePodWatchEvent(onNodeA.Events(), time.Second); !ok {
		t.Fatal("fieldSelector 匹配的订阅者未收到事件")
	}

	// 命名空间不匹配、标签不匹配、node 不匹配：两个订阅者都不该收到。
	informer.handler.OnAdd(&corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "kube-system", Labels: map[string]string{"app": "db"}},
		Spec:       corev1.PodSpec{NodeName: "node-b"},
	}, false)
	if unexpected, ok := receivePodWatchEvent(defaultWeb.Events(), 100*time.Millisecond); ok {
		t.Fatalf("不应收到被过滤的事件: %+v", unexpected)
	}
	if unexpected, ok := receivePodWatchEvent(onNodeA.Events(), 100*time.Millisecond); ok {
		t.Fatalf("不应收到被过滤的事件: %+v", unexpected)
	}
}

// TestPodWatchHubDropsSlowSubscriber 覆盖背压策略：消费不过来的订阅者被断开
// （通道关闭，前端据此重连并重新拿快照），而不是阻塞 informer 的事件协程。
func TestPodWatchHubDropsSlowSubscriber(t *testing.T) {
	_, hub, informer := newPodWatchHubFixture(t, "hub-slow-cluster")

	slow, err := hub.subscribe("", "", "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	t.Cleanup(slow.Close)

	// 不消费任何事件：投满缓冲后继续投递应触发断开。
	for i := 0; i < subscriberBuffer+2; i++ {
		informer.handler.OnAdd(&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "pod", Namespace: "default"},
		}, false)
	}

	deadline := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-slow.Events():
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("慢订阅者未被断开")
		}
	}
}

// TestPodWatchHubSharesPodMetricsPerInterval 覆盖 P1 的另一半：同一个周期内，
// 集群内所有连接共用一次 Pod 用量读取（而不是每连接各读一次）；跨周期刷新，
// 不同命名空间各自成一份快照；带 labelSelector 的连接仍各自读取、不污染共享快照。
func TestPodWatchHubSharesPodMetricsPerInterval(t *testing.T) {
	const clusterName = "hub-shared-metrics-cluster"

	// metrics-server 不支持 watch（405），这里用替身 HTTP 服务确认用量只走直连 List。
	var listCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		listCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(&metricsv1.PodMetricsList{Items: []metricsv1.PodMetrics{{
			ObjectMeta: metav1.ObjectMeta{Name: "web-a", Namespace: "default"},
			Containers: []metricsv1.ContainerMetrics{{
				Name:  "app",
				Usage: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m")},
			}},
		}}})
	}))
	t.Cleanup(server.Close)

	metricsClient, err := metricsclient.NewForConfig(&rest.Config{Host: server.URL})
	if err != nil {
		t.Fatalf("构造 metrics 客户端失败: %v", err)
	}

	informer := &stubPodInformer{}
	cs := &cluster.ClientSet{
		Name: clusterName,
		K8sClient: &kube.K8sClient{
			MetricsClient: metricsClient,
			Cache:         &stubPodCache{informer: informer},
		},
	}
	hub, err := acquirePodWatchHub(cs)
	if err != nil {
		t.Fatalf("acquirePodWatchHub returned error: %v", err)
	}
	t.Cleanup(hub.close)

	ctx := context.Background()
	const interval = time.Hour

	first, err := hub.podMetricsMap(ctx, cs, "default", interval)
	if err != nil {
		t.Fatalf("podMetricsMap returned error: %v", err)
	}
	if got := listCalls.Load(); got != 1 {
		t.Fatalf("首次读取的 List 次数 = %d, want 1", got)
	}
	if len(first) != 1 {
		t.Fatalf("用量条目数 = %d, want 1 (%v)", len(first), first)
	}
	if _, ok := first["default/web-a"]; !ok {
		t.Fatalf("缺少 default/web-a 的用量: %v", first)
	}

	// 同周期内第二个连接（同一命名空间）必须复用，不得再读一次上游。
	if _, err := hub.podMetricsMap(ctx, cs, "default", interval); err != nil {
		t.Fatalf("second podMetricsMap returned error: %v", err)
	}
	if got := listCalls.Load(); got != 1 {
		t.Fatalf("同周期复用的 List 次数 = %d, want 1", got)
	}

	// 全部命名空间与空 namespace 是同一份数据，与具体命名空间互不共用。
	for _, ns := range []string{common.AllNamespaces, ""} {
		if _, err := hub.podMetricsMap(ctx, cs, ns, interval); err != nil {
			t.Fatalf("podMetricsMap(%q) returned error: %v", ns, err)
		}
	}
	if got := listCalls.Load(); got != 2 {
		t.Fatalf("全部命名空间的 List 次数 = %d, want 2", got)
	}

	// 跨周期（interval 为 0 表示快照立即过期）必须重新读取。
	if _, err := hub.podMetricsMap(ctx, cs, "default", 0); err != nil {
		t.Fatalf("refreshing podMetricsMap returned error: %v", err)
	}
	if got := listCalls.Load(); got != 3 {
		t.Fatalf("跨周期刷新的 List 次数 = %d, want 3", got)
	}

	// 带 labelSelector 的连接不满足共享前提：退回每连接各自读取，且不写入共享快照。
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginCtx, _ := gin.CreateTestContext(recorder)
	ginCtx.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	ginCtx.Set("cluster", cs)

	handler := &PodHandler{}
	if metricsMap := handler.watchMetricsMap(ginCtx, cs, hub, "default", "app=web", interval); metricsMap == nil {
		t.Fatal("带 labelSelector 的退回路径不应返回 nil")
	}
	if got := listCalls.Load(); got != 4 {
		t.Fatalf("带 labelSelector 的 List 次数 = %d, want 4", got)
	}
	if _, err := hub.podMetricsMap(ctx, cs, "default", interval); err != nil {
		t.Fatalf("podMetricsMap after selector fallback returned error: %v", err)
	}
	if got := listCalls.Load(); got != 4 {
		t.Fatalf("退回路径污染了共享快照，List 次数 = %d, want 4", got)
	}
}

func receivePodWatchEvent(events <-chan podWatchEvent, timeout time.Duration) (podWatchEvent, bool) {
	select {
	case event, ok := <-events:
		return event, ok
	case <-time.After(timeout):
		return podWatchEvent{}, false
	}
}

// upstreamWatchGaugeValue 读取 aerolink_watch_upstream_watches 当前值。
func upstreamWatchGaugeValue(t *testing.T, clusterName string) float64 {
	t.Helper()
	var metric dto.Metric
	if err := middleware.WatchUpstreamWatches.WithLabelValues(clusterName).Write(&metric); err != nil {
		t.Fatalf("读取 aerolink_watch_upstream_watches 失败: %v", err)
	}
	return metric.GetGauge().GetValue()
}
