package resources

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/middleware"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/watch"
	toolscache "k8s.io/client-go/tools/cache"
	"k8s.io/klog/v2"
	metricsv1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
)

// errPodWatchCacheUnavailable 表示该集群没有可用的 informer 缓存
// （DISABLE_CACHE=true、客户端已停用，或缓存尚未就绪）。
// 调用方拿到它时必须显式退回直连 watch，不要静默降级成「什么都不推」。
var errPodWatchCacheUnavailable = errors.New("informer cache unavailable for pod watch")

// podWatchEvent 是 hub 广播给订阅者的一条事件。
// Pod 指向缓存对象的只读副本：同一事件的这一份副本由所有订阅者共享，
// 订阅者只能读（writeSSE / reducePod / GetPodMetrics 都是只读），不得修改。
type podWatchEvent struct {
	Type watch.EventType
	Pod  *corev1.Pod
}

// subscriberBuffer 是单个订阅者的事件缓冲长度。
// 缓冲满说明该订阅者消费不过来（前端卡住或网络慢），此时断开它，
// 而不是阻塞 informer 的事件处理协程——那会拖慢本集群的所有连接。
const subscriberBuffer = 64

// podWatchHub 把「一个集群一条上游 pod watch」共享给进程内所有 SSE 连接。
//
// 上游的 LIST/WATCH 由 controller-runtime 的 informer 缓存维护（每集群 1 条），
// hub 只做分发：拿到缓存事件后按订阅者的 namespace / labelSelector / fieldSelector
// 过滤并广播。这样打开页面的用户数不再等于上游 watch 数（P1）。
type podWatchHub struct {
	cluster   string
	client    *kube.K8sClient
	stopCh    chan struct{}
	closeOnce sync.Once

	// deregister 注销 informer 上的事件处理器。
	deregister func()

	mu            sync.Mutex
	subscriptions map[*podWatchSubscription]struct{}
	stopped       bool

	// metricsMu 保护 metricsSnapshots：每周期只做一次用量读取，供本集群所有连接复用。
	metricsMu        sync.Mutex
	metricsSnapshots map[string]podMetricsSnapshot
}

// podMetricsSnapshot 是最近一次为某个命名空间（空字符串表示全部命名空间）算出的 Pod 用量。
type podMetricsSnapshot struct {
	at         time.Time
	metricsMap map[string]metricsv1.PodMetrics
}

// podWatchHubs 以「客户端指针」为键：集群重建会换一个新的 K8sClient，
// 于是天然拿到新 hub，旧 hub 随旧客户端停用而关闭。
var (
	podWatchHubsMu sync.Mutex
	podWatchHubs   = map[*kube.K8sClient]*podWatchHub{}
)

// acquirePodWatchHub 返回该集群的共享 pod watch hub，不存在则创建。
// 缓存不可用时返回 errPodWatchCacheUnavailable。
func acquirePodWatchHub(cs *cluster.ClientSet) (*podWatchHub, error) {
	k8sClient := cs.K8sClient
	if k8sClient == nil || k8sClient.Cache == nil {
		return nil, errPodWatchCacheUnavailable
	}

	podWatchHubsMu.Lock()
	defer podWatchHubsMu.Unlock()

	if hub, ok := podWatchHubs[k8sClient]; ok {
		return hub, nil
	}
	// 客户端已停用（集群被移除或 kubeconfig 变更触发重建）：不要挂到已停止的缓存上。
	select {
	case <-k8sClient.Done():
		return nil, errPodWatchCacheUnavailable
	default:
	}

	// 缓存里的 pod informer 通常已经在跑（列表接口就走它），这里只是取句柄；
	// 未启动时 GetInformer 会构建并启动它——仍然只有 1 条上游 watch。
	informer, err := k8sClient.Cache.GetInformer(context.Background(), &corev1.Pod{})
	if err != nil {
		return nil, fmt.Errorf("failed to get pod informer: %w", err)
	}

	hub := &podWatchHub{
		cluster:          cs.Name,
		client:           k8sClient,
		stopCh:           make(chan struct{}),
		subscriptions:    make(map[*podWatchSubscription]struct{}),
		metricsSnapshots: make(map[string]podMetricsSnapshot),
	}
	// 全局只挂这一个处理器：若每个连接各挂一个，每次事件会被复制成「连接数」份。
	registration, err := informer.AddEventHandler(toolscache.ResourceEventHandlerFuncs{
		AddFunc:    func(obj any) { hub.publish(watch.Added, obj) },
		UpdateFunc: func(_, newObj any) { hub.publish(watch.Modified, newObj) },
		DeleteFunc: func(obj any) { hub.publish(watch.Deleted, obj) },
	})
	if err != nil {
		return nil, fmt.Errorf("failed to subscribe pod informer: %w", err)
	}
	hub.deregister = func() { _ = informer.RemoveEventHandler(registration) }

	podWatchHubs[k8sClient] = hub
	// 一个 hub 只对应一条上游 watch（informer 的那条），无论后面挂多少个连接。
	middleware.WatchUpstreamWatches.WithLabelValues(cs.Name).Inc()
	klog.Infof("pod watch hub started for cluster %s (shared informer cache)", cs.Name)

	// 客户端被停用时清理自己，避免订阅者挂在一个再也不会推事件的 hub 上。
	go func() {
		select {
		case <-k8sClient.Done():
		case <-hub.stopCh:
		}
		hub.close()
	}()

	return hub, nil
}

// podMetricsMap 返回该集群（可指定命名空间）的 Pod 用量映射。
//
// 用量读取只取决于集群与命名空间、与登录用户无关，所以同一个周期内只读一次、
// 由该集群的所有连接共用（P1：消掉「每连接各算一份」的重复计算）。
// 返回的 map 是共享只读数据：可以遍历，也可以交给 GetPodMetrics 读取，但不得修改。
func (h *podWatchHub) podMetricsMap(ctx context.Context, cs *cluster.ClientSet, namespace string, interval time.Duration) (map[string]metricsv1.PodMetrics, error) {
	// "_all" 与空 namespace 表示同一份数据，归一化后共用同一份快照。
	if namespace == common.AllNamespaces {
		namespace = ""
	}

	h.metricsMu.Lock()
	defer h.metricsMu.Unlock()

	if snapshot, ok := h.metricsSnapshots[namespace]; ok && time.Since(snapshot.at) < interval {
		return snapshot.metricsMap, nil
	}

	metricsMap, err := listPodMetrics(ctx, cs, namespace, "")
	if err != nil {
		return nil, err
	}
	h.metricsSnapshots[namespace] = podMetricsSnapshot{at: time.Now(), metricsMap: metricsMap}
	return metricsMap, nil
}

// subscribe 注册一个订阅者。namespace 为空表示所有命名空间；
// selector 为空表示不过滤。解析失败会直接报错（fail-closed）。
func (h *podWatchHub) subscribe(namespace, labelSelector, fieldSelector string) (*podWatchSubscription, error) {
	sub := &podWatchSubscription{
		hub:       h,
		events:    make(chan podWatchEvent, subscriberBuffer),
		namespace: namespace,
	}
	if labelSelector != "" {
		selector, err := labels.Parse(labelSelector)
		if err != nil {
			return nil, fmt.Errorf("invalid labelSelector parameter: %w", err)
		}
		sub.labels = selector
	}
	if fieldSelector != "" {
		selector, err := fields.ParseSelector(fieldSelector)
		if err != nil {
			return nil, fmt.Errorf("invalid fieldSelector parameter: %w", err)
		}
		sub.fields = selector
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stopped {
		return nil, errPodWatchCacheUnavailable
	}
	h.subscriptions[sub] = struct{}{}
	return sub, nil
}

// publish 把缓存事件广播给所有匹配的订阅者。它在 informer 的事件处理协程里执行，
// 因此绝不阻塞：消费不过来的订阅者会被直接断开。
func (h *podWatchHub) publish(eventType watch.EventType, obj any) {
	pod, ok := podFromWatchObject(obj)
	if !ok {
		return
	}
	// 缓存对象是所有消费者共享的，交给订阅者前统一复制一份（见 podWatchEvent 的说明）。
	event := podWatchEvent{Type: eventType, Pod: pod.DeepCopy()}

	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subscriptions {
		if !sub.matches(event.Pod) {
			continue
		}
		select {
		case sub.events <- event:
		default:
			// 断开慢订阅者：它会重连并重新拿快照，状态自愈。
			klog.Warningf("pod watch hub for cluster %s dropped an unresponsive subscriber", h.cluster)
			h.removeLocked(sub)
		}
	}
}

// removeLocked 移除并关闭订阅者；调用方必须持有 h.mu。
// 事件通道只在这里关闭，从而与 publish 的发送互斥，避免向已关闭通道发送。
func (h *podWatchHub) removeLocked(sub *podWatchSubscription) {
	if _, ok := h.subscriptions[sub]; !ok {
		return
	}
	delete(h.subscriptions, sub)
	close(sub.events)
}

func (h *podWatchHub) close() {
	h.closeOnce.Do(func() {
		close(h.stopCh)
		if h.deregister != nil {
			h.deregister()
		}

		podWatchHubsMu.Lock()
		if podWatchHubs[h.client] == h {
			delete(podWatchHubs, h.client)
		}
		podWatchHubsMu.Unlock()

		h.mu.Lock()
		h.stopped = true
		for sub := range h.subscriptions {
			close(sub.events)
		}
		h.subscriptions = make(map[*podWatchSubscription]struct{})
		h.mu.Unlock()

		middleware.WatchUpstreamWatches.WithLabelValues(h.cluster).Dec()
		klog.Infof("pod watch hub stopped for cluster %s", h.cluster)
	})
}

// podWatchSubscription 是单个 SSE 连接在 hub 上的订阅。
type podWatchSubscription struct {
	hub       *podWatchHub
	events    chan podWatchEvent
	namespace string
	labels    labels.Selector
	fields    fields.Selector
}

// Events 返回事件通道；通道被关闭表示订阅已结束，调用方应结束该连接的推送。
func (s *podWatchSubscription) Events() <-chan podWatchEvent {
	return s.events
}

// Close 注销订阅；重复调用是安全的。
func (s *podWatchSubscription) Close() {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	s.hub.removeLocked(s)
}

func (s *podWatchSubscription) matches(pod *corev1.Pod) bool {
	if s.namespace != "" && pod.Namespace != s.namespace {
		return false
	}
	if s.labels != nil && !s.labels.Matches(labels.Set(pod.Labels)) {
		return false
	}
	if s.fields != nil && !s.fields.Matches(podFieldSet(pod)) {
		return false
	}
	return true
}

// podFieldSet 只暴露 fieldSelector 实际会用到的字段，
// 与 apiserver 对 Pod 支持的字段选择器子集保持一致。
func podFieldSet(pod *corev1.Pod) fields.Set {
	return fields.Set{
		"metadata.name":      pod.Name,
		"metadata.namespace": pod.Namespace,
		"spec.nodeName":      pod.Spec.NodeName,
	}
}

func podFromWatchObject(obj any) (*corev1.Pod, bool) {
	switch typed := obj.(type) {
	case *corev1.Pod:
		return typed, true
	case toolscache.DeletedFinalStateUnknown:
		if pod, ok := typed.Obj.(*corev1.Pod); ok {
			return pod, true
		}
	}
	return nil, false
}

// directPodWatch 是缓存不可用时的直连事件源，也就是 P1 之前的形态：
// 每条 SSE 连接各建一条上游 watch。返回的通道关闭表示 watch 已结束，
// 调用方必须执行第二个返回值做清理。
func directPodWatch(ctx context.Context, cs *cluster.ClientSet, namespace string, opts metav1.ListOptions) (<-chan podWatchEvent, func(), error) {
	watchInterface, err := cs.K8sClient.ClientSet.CoreV1().Pods(namespace).Watch(ctx, opts)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to start watch: %w", err)
	}

	middleware.WatchUpstreamWatches.WithLabelValues(cs.Name).Inc()
	events := make(chan podWatchEvent)
	go func() {
		defer close(events)
		defer watchInterface.Stop()
		defer middleware.WatchUpstreamWatches.WithLabelValues(cs.Name).Dec()
		for event := range watchInterface.ResultChan() {
			item := podWatchEvent{Type: event.Type}
			if pod, ok := event.Object.(*corev1.Pod); ok {
				item.Pod = pod
			}
			select {
			case events <- item:
			case <-ctx.Done():
				return
			}
		}
	}()

	return events, func() { watchInterface.Stop() }, nil
}
