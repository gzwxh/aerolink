package resources

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/klog/v2"
	"k8s.io/kubectl/pkg/drain"
	metricsv1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type NodeHandler struct {
	*GenericResourceHandler[*corev1.Node, *corev1.NodeList]
}

func NewNodeHandler() *NodeHandler {
	return &NodeHandler{
		GenericResourceHandler: NewGenericResourceHandler[*corev1.Node, *corev1.NodeList](common.Nodes),
	}
}

// DrainNode 通过驱逐所有 pod 来腾空一个节点
func (h *NodeHandler) DrainNode(c *gin.Context) {
	nodeName := c.Param("name")
	ctx := c.Request.Context()
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	user := c.MustGet("user").(model.User)
	// 解析请求体中的 drain 选项
	var drainRequest struct {
		Force            bool `json:"force"`
		GracePeriod      int  `json:"gracePeriod"`
		DeleteLocal      bool `json:"deleteLocalData"`
		IgnoreDaemonsets bool `json:"ignoreDaemonsets"`
		// Timeout 大于 0 时，超过这么多秒后中止 drain。
		Timeout int `json:"timeout"`
	}

	if err := c.ShouldBindJSON(&drainRequest); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body: " + err.Error()})
		return
	}

	// 先获取该节点，确认它存在
	var node corev1.Node
	if err := cs.K8sClient.Get(ctx, types.NamespacedName{Name: nodeName}, &node); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Node not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	drainer := &drain.Helper{
		Ctx:                 ctx,
		Client:              cs.K8sClient.ClientSet,
		Force:               drainRequest.Force,
		GracePeriodSeconds:  drainRequest.GracePeriod,
		IgnoreAllDaemonSets: drainRequest.IgnoreDaemonsets,
		DeleteEmptyDirData:  drainRequest.DeleteLocal,
		Out:                 io.Discard,
		ErrOut:              io.Discard,
	}
	if drainRequest.Timeout > 0 {
		drainer.Timeout = time.Duration(drainRequest.Timeout) * time.Second
	}

	podDeleteList, errs := drainer.GetPodsForDeletion(nodeName)
	if len(errs) > 0 {
		errMsg := ""
		for i, item := range errs {
			if i > 0 {
				errMsg += "; "
			}
			errMsg += item.Error()
		}
		c.JSON(http.StatusConflict, gin.H{"error": errMsg})
		return
	}

	pods := podDeleteList.Pods()
	for _, pod := range pods {
		if !rbac.CanAccess(user, string(common.Pods), string(common.VerbUpdate), cs.Name, pod.Namespace) {
			c.JSON(http.StatusForbidden, gin.H{"error": rbac.NoAccess(user.Key(), string(common.VerbUpdate), string(common.Pods), pod.Namespace, cs.Name)})
			return
		}
		if !rbac.CanAccess(user, string(common.Pods), string(common.VerbDelete), cs.Name, pod.Namespace) {
			c.JSON(http.StatusForbidden, gin.H{"error": rbac.NoAccess(user.Key(), string(common.VerbDelete), string(common.Pods), pod.Namespace, cs.Name)})
			return
		}
	}

	if err := drain.RunCordonOrUncordon(drainer, &node, false); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to cordon node: " + err.Error()})
		return
	}

	if err := drainer.DeleteOrEvictPods(pods); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to drain node: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":  fmt.Sprintf("Node %s drained successfully", nodeName),
		"node":     node.Name,
		"pods":     len(pods),
		"warnings": podDeleteList.Warnings(),
	})
}

func (h *NodeHandler) markNodeSchedulable(ctx context.Context, client *kube.K8sClient, nodeName string, schedulable bool) error {
	// 获取当前节点
	var node corev1.Node
	if err := client.Get(ctx, types.NamespacedName{Name: nodeName}, &node); err != nil {
		return err
	}
	node.Spec.Unschedulable = !schedulable
	if err := client.Update(ctx, &node); err != nil {
		return err
	}
	return nil
}

// CordonNode 把节点标记为不可调度
func (h *NodeHandler) CordonNode(c *gin.Context) {
	nodeName := c.Param("name")
	ctx := c.Request.Context()
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	if err := h.markNodeSchedulable(ctx, cs.K8sClient, nodeName, false); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Node not found"})
			return
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"message": fmt.Sprintf("Node %s cordoned successfully", nodeName),
	})
}

// UncordonNode 把节点标记为可调度
func (h *NodeHandler) UncordonNode(c *gin.Context) {
	nodeName := c.Param("name")
	ctx := c.Request.Context()
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	if err := h.markNodeSchedulable(ctx, cs.K8sClient, nodeName, true); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Node not found"})
			return
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"message": fmt.Sprintf("Node %s uncordoned successfully", nodeName),
	})
}

// TaintNode 为节点新增或更新污点
func (h *NodeHandler) TaintNode(c *gin.Context) {
	nodeName := c.Param("name")
	ctx := c.Request.Context()
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	// 解析请求体中的污点信息
	var taintRequest struct {
		Key    string `json:"key" binding:"required"`
		Value  string `json:"value"`
		Effect string `json:"effect" binding:"required,oneof=NoSchedule PreferNoSchedule NoExecute"`
	}

	if err := c.ShouldBindJSON(&taintRequest); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body: " + err.Error()})
		return
	}

	// 获取当前节点
	var node corev1.Node
	if err := cs.K8sClient.Get(ctx, types.NamespacedName{Name: nodeName}, &node); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Node not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 构造新的污点
	newTaint := corev1.Taint{
		Key:    taintRequest.Key,
		Value:  taintRequest.Value,
		Effect: corev1.TaintEffect(taintRequest.Effect),
	}

	// 如果相同 key 的污点已存在就更新它，否则新增污点
	found := false
	for i, taint := range node.Spec.Taints {
		if taint.Key == taintRequest.Key {
			node.Spec.Taints[i] = newTaint
			found = true
			break
		}
	}

	if !found {
		node.Spec.Taints = append(node.Spec.Taints, newTaint)
	}

	// 更新节点
	if err := cs.K8sClient.Update(ctx, &node); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to taint node: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": fmt.Sprintf("Node %s tainted successfully", nodeName),
		"node":    node.Name,
		"taint":   newTaint,
	})
}

// UntaintNode 移除节点上的一个污点
func (h *NodeHandler) UntaintNode(c *gin.Context) {
	nodeName := c.Param("name")
	ctx := c.Request.Context()
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	// 解析请求体中要移除的污点 key
	var untaintRequest struct {
		Key string `json:"key" binding:"required"`
	}

	if err := c.ShouldBindJSON(&untaintRequest); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body: " + err.Error()})
		return
	}

	// 获取当前节点
	var node corev1.Node
	if err := cs.K8sClient.Get(ctx, types.NamespacedName{Name: nodeName}, &node); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Node not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 查找并移除指定 key 的污点
	originalLength := len(node.Spec.Taints)
	var newTaints []corev1.Taint
	for _, taint := range node.Spec.Taints {
		if taint.Key != untaintRequest.Key {
			newTaints = append(newTaints, taint)
		}
	}
	node.Spec.Taints = newTaints

	if len(newTaints) == originalLength {
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("Taint with key '%s' not found on node", untaintRequest.Key)})
		return
	}

	// 更新节点
	if err := cs.K8sClient.Update(ctx, &node); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to untaint node: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":         fmt.Sprintf("Taint with key '%s' removed from node %s successfully", untaintRequest.Key, nodeName),
		"node":            node.Name,
		"removedTaintKey": untaintRequest.Key,
	})
}

func (h *NodeHandler) List(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	labelSelector := c.Query("labelSelector")

	var listOpts []client.ListOption
	if labelSelector != "" {
		selector, err := labels.Parse(labelSelector)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid labelSelector parameter: " + err.Error()})
			return
		}
		listOpts = append(listOpts, client.MatchingLabelsSelector{Selector: selector})
	}
	if c.Query("limit") != "" {
		limit, err := strconv.ParseInt(c.Query("limit"), 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
			return
		}
		listOpts = append(listOpts, client.Limit(limit))
	}
	if c.Query("continue") != "" {
		listOpts = append(listOpts, client.Continue(c.Query("continue")))
	}
	var nodes corev1.NodeList
	if err := paginationClient(c, cs).List(c.Request.Context(), &nodes, listOpts...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list nodes: " + err.Error()})
		return
	}
	// 缓存路径会带一个假 continue token，抹掉它，免得前端拿它反复翻页。
	if listMeta, err := meta.ListAccessor(&nodes); err == nil && listMeta.GetContinue() == cacheContinueToken {
		listMeta.SetContinue("")
	}

	nodeMetricsMap := buildNodeMetricsMap(listNodeMetrics(c.Request.Context(), cs, labelSelector))
	nodeResourceRequests := listNodeResourceRequests(c.Request.Context(), cs.K8sClient, nodes.Items)

	result := &common.NodeListWithMetrics{
		TypeMeta: nodes.TypeMeta,
		ListMeta: nodes.ListMeta,
		Items:    []*common.NodeWithMetrics{},
	}
	result.Items = make([]*common.NodeWithMetrics, len(nodes.Items))
	for i, node := range nodes.Items {
		metricsCell := &common.MetricsCell{}
		metricsCell.CPULimit = node.Status.Allocatable.Cpu().MilliValue()
		metricsCell.MemoryLimit = node.Status.Allocatable.Memory().Value()
		metricsCell.PodsLimit = node.Status.Allocatable.Pods().Value()

		if nm, ok := nodeMetricsMap[node.Name]; ok {
			if cpuQuantity, ok := nm.Usage["cpu"]; ok {
				metricsCell.CPUUsage = cpuQuantity.MilliValue()
			}
			if memQuantity, ok := nm.Usage["memory"]; ok {
				metricsCell.MemoryUsage = memQuantity.Value()
			}
		}
		if requests, exists := nodeResourceRequests[node.Name]; exists {
			metricsCell.CPURequest = requests.CPURequest
			metricsCell.MemoryRequest = requests.MemoryRequest
			metricsCell.Pods = requests.Pods
		}
		result.Items[i] = &common.NodeWithMetrics{
			Node:    &node,
			Metrics: metricsCell,
		}
	}
	sort.Slice(result.Items, func(i, j int) bool {
		return result.Items[i].Name < result.Items[j].Name
	})
	c.JSON(http.StatusOK, result)
}

func (h *NodeHandler) registerCustomRoutes(group *gin.RouterGroup) {
	group.PUT("/_all/:name/drain", h.DrainNode)
	group.PUT("/_all/:name/cordon", h.CordonNode)
	group.PUT("/_all/:name/uncordon", h.UncordonNode)
	group.PUT("/_all/:name/taint", h.TaintNode)
	group.PUT("/_all/:name/untaint", h.UntaintNode)
}

// listNodeMetrics 直连 metrics-server 读节点用量：metrics.k8s.io 不支持 watch，
// 经客户端缓存读取会建 informer，让 ListAndWatch 每轮都以 405 失败重试。
func listNodeMetrics(ctx context.Context, cs *cluster.ClientSet, labelSelector string) []metricsv1.NodeMetrics {
	if cs.K8sClient.MetricsClient == nil {
		return nil
	}
	metricsList, err := cs.K8sClient.MetricsClient.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})
	if err != nil {
		klog.Warningf("Failed to list node metrics: %v", err)
		return nil
	}
	return metricsList.Items
}

func buildNodeMetricsMap(nodeMetrics []metricsv1.NodeMetrics) map[string]metricsv1.NodeMetrics {
	metricsMap := make(map[string]metricsv1.NodeMetrics, len(nodeMetrics))
	for _, nodeMetric := range nodeMetrics {
		metricsMap[nodeMetric.Name] = nodeMetric
	}
	return metricsMap
}

func listNodeResourceRequests(ctx context.Context, k8sClient *kube.K8sClient, nodes []corev1.Node) map[string]common.MetricsCell {
	if !k8sClient.CacheEnabled {
		return listNodeResourceRequestsFromAllPods(ctx, k8sClient)
	}

	nodeResourceRequests := make(map[string]common.MetricsCell, len(nodes))
	for _, node := range nodes {
		var nodePods corev1.PodList
		if err := k8sClient.List(ctx, &nodePods, client.MatchingFields{"spec.nodeName": node.Name}); err != nil {
			klog.Warningf("Failed to list pods for node %s: %v", node.Name, err)
			continue
		}

		var metrics common.MetricsCell
		for i := range nodePods.Items {
			addPodResources(&metrics, &nodePods.Items[i])
		}
		nodeResourceRequests[node.Name] = metrics
	}
	return nodeResourceRequests
}

func listNodeResourceRequestsFromAllPods(ctx context.Context, k8sClient *kube.K8sClient) map[string]common.MetricsCell {
	var allPods corev1.PodList
	if err := k8sClient.List(ctx, &allPods); err != nil {
		klog.Warningf("Failed to list pods: %v", err)
		return map[string]common.MetricsCell{}
	}

	nodeResourceRequests := make(map[string]common.MetricsCell)
	for i := range allPods.Items {
		pod := &allPods.Items[i]
		if pod.Spec.NodeName == "" {
			continue
		}

		metrics := nodeResourceRequests[pod.Spec.NodeName]
		addPodResources(&metrics, pod)
		nodeResourceRequests[pod.Spec.NodeName] = metrics
	}
	return nodeResourceRequests
}

func addPodResources(metrics *common.MetricsCell, pod *corev1.Pod) {
	metrics.Pods++
	for _, container := range pod.Spec.Containers {
		if cpuRequest := container.Resources.Requests.Cpu(); cpuRequest != nil {
			metrics.CPURequest += cpuRequest.MilliValue()
		}
		if memoryRequest := container.Resources.Requests.Memory(); memoryRequest != nil {
			metrics.MemoryRequest += memoryRequest.Value()
		}
	}
}
