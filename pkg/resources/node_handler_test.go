package resources

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	metricsv1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// buildTestScheme 创建一个包含 handler 所需全部类型的 runtime.Scheme。
func buildTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(s))
	require.NoError(t, metricsv1.AddToScheme(s))
	return s
}

// podNodeIndexer 与 pkg/kube/client.go 中注册的索引函数相同。
func podNodeIndexer(obj client.Object) []string {
	pod := obj.(*corev1.Pod)
	if pod.Spec.NodeName == "" {
		return nil
	}
	return []string{pod.Spec.NodeName}
}

// newFakeClientSet 创建一个由 fake controller-runtime client 支撑的 cluster.ClientSet，
// 该 client 支持 spec.nodeName 字段索引器。对象会预先加载进 fake client，
// 因此类似 informer 的索引已经就绪。
// CacheEnabled 设为 true，以走索引查询路径。
func newFakeClientSet(t *testing.T, objs ...client.Object) *cluster.ClientSet {
	t.Helper()
	scheme := buildTestScheme(t)
	cb := fake.NewClientBuilder().
		WithScheme(scheme).
		WithIndex(&corev1.Pod{}, "spec.nodeName", podNodeIndexer)

	for _, o := range objs {
		cb = cb.WithObjects(o)
	}

	fakeClient := cb.Build()

	return &cluster.ClientSet{
		K8sClient: &kube.K8sClient{
			Client:       fakeClient,
			CacheEnabled: true,
		},
	}
}

// newFakeClientSetUncached 创建一个 CacheEnabled=false 的 cluster.ClientSet，
// 以走单次集群级列表的兜底路径。
func newFakeClientSetUncached(t *testing.T, objs ...client.Object) *cluster.ClientSet {
	t.Helper()
	scheme := buildTestScheme(t)
	cb := fake.NewClientBuilder().
		WithScheme(scheme)

	for _, o := range objs {
		cb = cb.WithObjects(o)
	}

	fakeClient := cb.Build()

	return &cluster.ClientSet{
		K8sClient: &kube.K8sClient{
			Client:       fakeClient,
			CacheEnabled: false,
		},
	}
}

// newNodeMetricsClient 用替身 HTTP 服务提供 NodeMetrics 列表
// （生产代码直连 metrics-server，不走 informer 缓存）。
func newNodeMetricsClient(t *testing.T, items ...metricsv1.NodeMetrics) *metricsclient.Clientset {
	t.Helper()
	return newMetricsClientWith(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(&metricsv1.NodeMetricsList{Items: items})
	})
}

// newTestGinContext 创建一个用于测试的 gin.Context，
// 并把给定的 ClientSet 注入到 "cluster" 键（与生产环境中间件一致）。
func newTestGinContext(t *testing.T, cs *cluster.ClientSet) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/v1/nodes", nil)
	ctx.Set("cluster", cs)
	return ctx, rec
}

// makePod 是一个辅助函数，用于创建在指定节点上带资源请求的 corev1.Pod。
func makePod(name, namespace, nodeName string, cpuMillis int64, memoryBytes int64) *corev1.Pod {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
		Spec: corev1.PodSpec{
			NodeName: nodeName,
			Containers: []corev1.Container{
				{
					Name:  "main",
					Image: "busybox",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    *resource.NewMilliQuantity(cpuMillis, resource.DecimalSI),
							corev1.ResourceMemory: *resource.NewQuantity(memoryBytes, resource.BinarySI),
						},
					},
				},
			},
		},
	}
	return p
}

// makeNode 用给定的可分配资源创建一个 corev1.Node。
func makeNode(name string, cpuMillis int64, memoryBytes int64, maxPods int64) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
		},
		Status: corev1.NodeStatus{
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU:    *resource.NewMilliQuantity(cpuMillis, resource.DecimalSI),
				corev1.ResourceMemory: *resource.NewQuantity(memoryBytes, resource.BinarySI),
				corev1.ResourcePods:   *resource.NewQuantity(maxPods, resource.DecimalSI),
			},
		},
	}
}

// makeNodeMetrics 用给定的用量值创建一个 metricsv1.NodeMetrics。
func makeNodeMetrics(name string, cpuMillis int64, memoryBytes int64) *metricsv1.NodeMetrics {
	return &metricsv1.NodeMetrics{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
		},
		Usage: corev1.ResourceList{
			corev1.ResourceCPU:    *resource.NewMilliQuantity(cpuMillis, resource.DecimalSI),
			corev1.ResourceMemory: *resource.NewQuantity(memoryBytes, resource.BinarySI),
		},
	}
}

// decodeNodeListResponse 把 recorder 中的 JSON 响应体解析为 NodeListWithMetrics。
func decodeNodeListResponse(t *testing.T, rec *httptest.ResponseRecorder) *common.NodeListWithMetrics {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, "unexpected status code; body=%s", rec.Body.String())
	var result common.NodeListWithMetrics
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	return &result
}

// ---------- 测试 ----------

// TestNodeHandlerList_PodAssignmentByFieldIndex 校验 List 方法
// 确实使用 spec.nodeName 字段索引器来统计每个节点的 pod 数并
// 汇总资源请求——而不是先拉一次集群级列表再分组。
func TestNodeHandlerList_PodAssignmentByFieldIndex(t *testing.T) {
	// 两个具有已知可分配资源的节点。
	nodeA := makeNode("node-a", 4000, 8*1024*1024*1024, 110)
	nodeB := makeNode("node-b", 8000, 16*1024*1024*1024, 110)

	// 分配给 node-a 的 pod：2 个，CPU 500m+200m，内存 128Mi+256Mi。
	podA1 := makePod("pod-a1", "default", "node-a", 500, 128*1024*1024)
	podA2 := makePod("pod-a2", "kube-system", "node-a", 200, 256*1024*1024)

	// 分配给 node-b 的 pod：1 个，CPU 1000m，内存 512Mi。
	podB1 := makePod("pod-b1", "default", "node-b", 1000, 512*1024*1024)

	// 未调度（没有 nodeName）的 pod——绝不能出现在任何节点的统计中。
	unscheduled := makePod("unscheduled-pod", "default", "", 100, 64*1024*1024)

	// 两个节点的 NodeMetrics。
	metricsA := makeNodeMetrics("node-a", 1200, 2*1024*1024*1024)
	metricsB := makeNodeMetrics("node-b", 3500, 6*1024*1024*1024)

	cs := newFakeClientSet(t,
		nodeA, nodeB,
		podA1, podA2, podB1, unscheduled,
	)
	cs.K8sClient.MetricsClient = newNodeMetricsClient(t, *metricsA, *metricsB)

	ctx, rec := newTestGinContext(t, cs)
	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)

	// 节点应按名称字母序排序。
	require.Len(t, result.Items, 2)
	assert.Equal(t, "node-a", result.Items[0].Name)
	assert.Equal(t, "node-b", result.Items[1].Name)

	// --- node-a 断言 ---
	mA := result.Items[0].Metrics
	require.NotNil(t, mA, "node-a metrics should not be nil")

	// Pod 数量：正好 2（pod-a1 + pod-a2），而不是 4（含 node-b 与未调度的全部 pod）。
	assert.Equal(t, int64(2), mA.Pods, "node-a should have exactly 2 pods")

	// CPU 请求：500 + 200 = 700m
	assert.Equal(t, int64(700), mA.CPURequest, "node-a CPU request should be 700m")

	// 内存请求：128Mi + 256Mi = 384Mi
	assert.Equal(t, int64((128+256)*1024*1024), mA.MemoryRequest, "node-a memory request should be 384Mi")

	// 可分配上限
	assert.Equal(t, int64(4000), mA.CPULimit, "node-a CPU limit should be 4000m")
	assert.Equal(t, int64(8*1024*1024*1024), mA.MemoryLimit, "node-a memory limit should be 8Gi")
	assert.Equal(t, int64(110), mA.PodsLimit, "node-a pods limit should be 110")

	// 来自 NodeMetrics 的用量
	assert.Equal(t, int64(1200), mA.CPUUsage, "node-a CPU usage from metrics")
	assert.Equal(t, int64(2*1024*1024*1024), mA.MemoryUsage, "node-a memory usage from metrics")

	// --- node-b 断言 ---
	mB := result.Items[1].Metrics
	require.NotNil(t, mB, "node-b metrics should not be nil")

	assert.Equal(t, int64(1), mB.Pods, "node-b should have exactly 1 pod")
	assert.Equal(t, int64(1000), mB.CPURequest, "node-b CPU request should be 1000m")
	assert.Equal(t, int64(512*1024*1024), mB.MemoryRequest, "node-b memory request should be 512Mi")
	assert.Equal(t, int64(8000), mB.CPULimit, "node-b CPU limit should be 8000m")
	assert.Equal(t, int64(16*1024*1024*1024), mB.MemoryLimit, "node-b memory limit should be 16Gi")
	assert.Equal(t, int64(3500), mB.CPUUsage, "node-b CPU usage from metrics")
	assert.Equal(t, int64(6*1024*1024*1024), mB.MemoryUsage, "node-b memory usage from metrics")
}

// TestNodeHandlerList_EmptyCluster 校验没有任何节点时 List
// 返回空的 items 数组。
func TestNodeHandlerList_EmptyCluster(t *testing.T) {
	cs := newFakeClientSet(t)
	ctx, rec := newTestGinContext(t, cs)

	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)
	assert.Empty(t, result.Items, "empty cluster should return no nodes")
}

// TestNodeHandlerList_NodesWithoutPods 校验没有已调度 pod 的节点
// 其资源请求与 pod 数都为零。
func TestNodeHandlerList_NodesWithoutPods(t *testing.T) {
	node := makeNode("lonely-node", 4000, 8*1024*1024*1024, 110)
	cs := newFakeClientSet(t, node)

	ctx, rec := newTestGinContext(t, cs)

	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)
	require.Len(t, result.Items, 1)
	assert.Equal(t, "lonely-node", result.Items[0].Name)

	m := result.Items[0].Metrics
	require.NotNil(t, m)
	assert.Equal(t, int64(0), m.Pods, "no pods on this node")
	assert.Equal(t, int64(0), m.CPURequest, "no CPU requests")
	assert.Equal(t, int64(0), m.MemoryRequest, "no memory requests")
	// 可分配资源仍应被填充。
	assert.Equal(t, int64(4000), m.CPULimit)
	assert.Equal(t, int64(8*1024*1024*1024), m.MemoryLimit)
	assert.Equal(t, int64(110), m.PodsLimit)
}

// TestNodeHandlerList_MultipleContainersPerPod 校验一个 pod 中所有容器
// 的资源请求会被累加。
func TestNodeHandlerList_MultipleContainersPerPod(t *testing.T) {
	node := makeNode("multi-container-node", 8000, 16*1024*1024*1024, 110)

	// 含 2 个容器的 pod：一个请求 200m/128Mi，另一个 300m/256Mi。
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "multi-container-pod",
			Namespace: "default",
		},
		Spec: corev1.PodSpec{
			NodeName: "multi-container-node",
			Containers: []corev1.Container{
				{
					Name:  "sidecar",
					Image: "envoy",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    *resource.NewMilliQuantity(200, resource.DecimalSI),
							corev1.ResourceMemory: *resource.NewQuantity(128*1024*1024, resource.BinarySI),
						},
					},
				},
				{
					Name:  "app",
					Image: "myapp",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    *resource.NewMilliQuantity(300, resource.DecimalSI),
							corev1.ResourceMemory: *resource.NewQuantity(256*1024*1024, resource.BinarySI),
						},
					},
				},
			},
		},
	}

	cs := newFakeClientSet(t, node, pod)
	ctx, rec := newTestGinContext(t, cs)

	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)
	require.Len(t, result.Items, 1)

	m := result.Items[0].Metrics
	require.NotNil(t, m)
	assert.Equal(t, int64(1), m.Pods, "1 pod total")
	assert.Equal(t, int64(500), m.CPURequest, "200m + 300m = 500m across containers")
	assert.Equal(t, int64((128+256)*1024*1024), m.MemoryRequest, "128Mi + 256Mi = 384Mi across containers")
}

// TestNodeHandlerList_SortOrder 校验节点按名称字母序返回。
func TestNodeHandlerList_SortOrder(t *testing.T) {
	// 逆序插入，以确保 handler 会对它们排序。
	nodeZ := makeNode("z-node", 1000, 1*1024*1024*1024, 10)
	nodeA := makeNode("a-node", 1000, 1*1024*1024*1024, 10)
	nodeM := makeNode("m-node", 1000, 1*1024*1024*1024, 10)

	cs := newFakeClientSet(t, nodeZ, nodeA, nodeM)
	ctx, rec := newTestGinContext(t, cs)

	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)
	require.Len(t, result.Items, 3)
	assert.Equal(t, "a-node", result.Items[0].Name)
	assert.Equal(t, "m-node", result.Items[1].Name)
	assert.Equal(t, "z-node", result.Items[2].Name)
}

// TestNodeHandlerList_CrossNamespacePods 校验同一节点上来自不同命名空间的 pod
// 会被合并统计。
func TestNodeHandlerList_CrossNamespacePods(t *testing.T) {
	node := makeNode("shared-node", 4000, 8*1024*1024*1024, 110)

	pod1 := makePod("pod-ns1", "namespace-a", "shared-node", 100, 64*1024*1024)
	pod2 := makePod("pod-ns2", "namespace-b", "shared-node", 200, 128*1024*1024)
	pod3 := makePod("pod-ns3", "namespace-c", "shared-node", 300, 256*1024*1024)

	cs := newFakeClientSet(t, node, pod1, pod2, pod3)
	ctx, rec := newTestGinContext(t, cs)

	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)
	require.Len(t, result.Items, 1)

	m := result.Items[0].Metrics
	require.NotNil(t, m)
	assert.Equal(t, int64(3), m.Pods, "3 pods across 3 namespaces")
	assert.Equal(t, int64(600), m.CPURequest, "100+200+300 = 600m")
	assert.Equal(t, int64((64+128+256)*1024*1024), m.MemoryRequest, "64+128+256 = 448Mi")
}

// ===================================================================
// 未缓存路径的测试——覆盖单次集群级列表的兜底分支
// ===================================================================

// TestNodeHandlerList_Uncached_PodAssignment 校验未缓存的兜底路径
// （单次集群级 pod 列表 + 在 Go 中分组）能得到正确的每节点指标。
func TestNodeHandlerList_Uncached_PodAssignment(t *testing.T) {
	nodeA := makeNode("node-a", 4000, 8*1024*1024*1024, 110)
	nodeB := makeNode("node-b", 8000, 16*1024*1024*1024, 110)

	podA1 := makePod("pod-a1", "default", "node-a", 500, 128*1024*1024)
	podA2 := makePod("pod-a2", "kube-system", "node-a", 200, 256*1024*1024)
	podB1 := makePod("pod-b1", "default", "node-b", 1000, 512*1024*1024)
	unscheduled := makePod("unscheduled-pod", "default", "", 100, 64*1024*1024)

	metricsA := makeNodeMetrics("node-a", 1200, 2*1024*1024*1024)
	metricsB := makeNodeMetrics("node-b", 3500, 6*1024*1024*1024)

	cs := newFakeClientSetUncached(t,
		nodeA, nodeB,
		podA1, podA2, podB1, unscheduled,
	)
	cs.K8sClient.MetricsClient = newNodeMetricsClient(t, *metricsA, *metricsB)

	ctx, rec := newTestGinContext(t, cs)
	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)

	require.Len(t, result.Items, 2)
	assert.Equal(t, "node-a", result.Items[0].Name)
	assert.Equal(t, "node-b", result.Items[1].Name)

	// node-a：2 个 pod，700m CPU，384Mi 内存
	mA := result.Items[0].Metrics
	require.NotNil(t, mA)
	assert.Equal(t, int64(2), mA.Pods, "node-a should have 2 pods (uncached)")
	assert.Equal(t, int64(700), mA.CPURequest, "node-a CPU request (uncached)")
	assert.Equal(t, int64((128+256)*1024*1024), mA.MemoryRequest, "node-a memory request (uncached)")
	assert.Equal(t, int64(1200), mA.CPUUsage)
	assert.Equal(t, int64(2*1024*1024*1024), mA.MemoryUsage)

	// node-b：1 个 pod，1000m CPU，512Mi 内存
	mB := result.Items[1].Metrics
	require.NotNil(t, mB)
	assert.Equal(t, int64(1), mB.Pods, "node-b should have 1 pod (uncached)")
	assert.Equal(t, int64(1000), mB.CPURequest, "node-b CPU request (uncached)")
	assert.Equal(t, int64(512*1024*1024), mB.MemoryRequest, "node-b memory request (uncached)")
}

// TestNodeHandlerList_Uncached_EmptyCluster 校验未缓存路径在没有任何节点时的行为。
func TestNodeHandlerList_Uncached_EmptyCluster(t *testing.T) {
	cs := newFakeClientSetUncached(t)
	ctx, rec := newTestGinContext(t, cs)

	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)
	assert.Empty(t, result.Items)
}

// TestNodeHandlerList_Uncached_NodesWithoutPods 校验未缓存路径下
// 没有 pod 被调度的节点。
func TestNodeHandlerList_Uncached_NodesWithoutPods(t *testing.T) {
	node := makeNode("lonely-node", 4000, 8*1024*1024*1024, 110)
	cs := newFakeClientSetUncached(t, node)

	ctx, rec := newTestGinContext(t, cs)
	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)
	require.Len(t, result.Items, 1)

	m := result.Items[0].Metrics
	require.NotNil(t, m)
	assert.Equal(t, int64(0), m.Pods, "no pods (uncached)")
	assert.Equal(t, int64(0), m.CPURequest)
	assert.Equal(t, int64(0), m.MemoryRequest)
	assert.Equal(t, int64(4000), m.CPULimit)
	assert.Equal(t, int64(110), m.PodsLimit)
}

// TestNodeHandlerList_Uncached_MultipleContainersPerPod 校验兜底路径
// 会累加同一个 pod 中所有容器的请求。
func TestNodeHandlerList_Uncached_MultipleContainersPerPod(t *testing.T) {
	node := makeNode("multi-node", 8000, 16*1024*1024*1024, 110)

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "multi-pod", Namespace: "default"},
		Spec: corev1.PodSpec{
			NodeName: "multi-node",
			Containers: []corev1.Container{
				{
					Name: "sidecar", Image: "envoy",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    *resource.NewMilliQuantity(200, resource.DecimalSI),
							corev1.ResourceMemory: *resource.NewQuantity(128*1024*1024, resource.BinarySI),
						},
					},
				},
				{
					Name: "app", Image: "myapp",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    *resource.NewMilliQuantity(300, resource.DecimalSI),
							corev1.ResourceMemory: *resource.NewQuantity(256*1024*1024, resource.BinarySI),
						},
					},
				},
			},
		},
	}

	cs := newFakeClientSetUncached(t, node, pod)
	ctx, rec := newTestGinContext(t, cs)

	handler := NewNodeHandler()
	handler.List(ctx)

	result := decodeNodeListResponse(t, rec)
	require.Len(t, result.Items, 1)

	m := result.Items[0].Metrics
	require.NotNil(t, m)
	assert.Equal(t, int64(1), m.Pods)
	assert.Equal(t, int64(500), m.CPURequest, "200+300=500m (uncached)")
	assert.Equal(t, int64((128+256)*1024*1024), m.MemoryRequest, "128+256=384Mi (uncached)")
}
