package system

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/utils"
	"golang.org/x/sync/errgroup"
	v1 "k8s.io/api/core/v1"
)

type OverviewData struct {
	TotalNodes      int                   `json:"totalNodes"`
	ReadyNodes      int                   `json:"readyNodes"`
	TotalPods       int                   `json:"totalPods"`
	RunningPods     int                   `json:"runningPods"`
	TotalNamespaces int                   `json:"totalNamespaces"`
	TotalServices   int                   `json:"totalServices"`
	PromEnabled     bool                  `json:"prometheusEnabled"`
	Resource        common.ResourceMetric `json:"resource"`
	// Scoped 表示本次统计只覆盖调用者有权限的命名空间：集群级容量（节点数、
	// 可分配 CPU/内存、Prometheus 集群指标）不参与统计，前端据此隐藏集群容量视图。
	Scoped bool `json:"scoped"`
}

// nodeMetrics 保存依据节点列表汇总出的指标。
type nodeMetrics struct {
	total          int
	ready          int
	cpuAllocatable int64 // millicores
	memAllocatable int64 // milli-bytes (matches original MilliValue() contract)
}

// podMetrics 保存依据 pod 列表汇总出的指标。
type podMetrics struct {
	total        int
	running      int
	cpuRequested int64 // millicores
	memRequested int64 // milli-bytes (matches original MilliValue() contract)
	cpuLimited   int64 // millicores
	memLimited   int64 // milli-bytes (matches original MilliValue() contract)
}

func (pm *podMetrics) addPod(pod *v1.Pod) {
	pm.total++
	// 方案：用 int64 累加，而不是 resource.Quantity.Add()
	// 跳过处于终态的 pod；否则会多算
	if pod.Status.Phase != v1.PodSucceeded && pod.Status.Phase != v1.PodFailed {
		for j := range pod.Spec.Containers {
			container := &pod.Spec.Containers[j]
			pm.cpuRequested += container.Resources.Requests.Cpu().MilliValue()
			pm.memRequested += container.Resources.Requests.Memory().MilliValue()

			if container.Resources.Limits != nil {
				if cpu := container.Resources.Limits.Cpu(); cpu != nil {
					pm.cpuLimited += cpu.MilliValue()
				}
				if mem := container.Resources.Limits.Memory(); mem != nil {
					pm.memLimited += mem.MilliValue()
				}
			}
		}
	}
	if utils.IsPodReady(pod) || pod.Status.Phase == v1.PodSucceeded {
		pm.running++
	}
}

func GetOverview(c *gin.Context) {
	ctx := c.Request.Context()

	cs := c.MustGet("cluster").(*cluster.ClientSet)
	user := c.MustGet("user").(model.User)

	// 完整集群访问（直接持有覆盖该集群的角色）可以看到集群级数据；只靠权限绑定组
	// 授权的账号同样允许进入，但只统计它可见的命名空间，且不接触集群容量 —— 403
	// 会让这类账号在控制台首页直接报错。
	fullAccess := rbac.CanAccessCluster(user, cs.Name)
	if !fullAccess && !rbac.CanSeeNamespacesInCluster(user, cs.Name) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	// 命名空间列表先取一次：受限账号的统计范围与命名空间计数都由它决定。
	var namespaces v1.NamespaceList
	if err := cs.K8sClient.List(ctx, &namespaces); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// visible 为 nil 表示不受限（统计整个集群）。
	var visible map[string]struct{}
	nsCount := len(namespaces.Items)
	if !fullAccess {
		visible = make(map[string]struct{}, len(namespaces.Items))
		for i := range namespaces.Items {
			name := namespaces.Items[i].Name
			if rbac.CanAccessNamespace(user, cs.Name, name) {
				visible[name] = struct{}{}
			}
		}
		nsCount = len(visible)
	}

	// 方案：并行获取并计算其余资源类型。
	// 每个 goroutine 独占自己的数据——没有共享状态，也无需互斥锁。
	var nm nodeMetrics
	var pm podMetrics
	var svcCount int

	g, gctx := errgroup.WithContext(ctx)

	// 节点：只有具备集群级访问权限才会计入它们，它们属于容量数据。
	if fullAccess {
		g.Go(func() error {
			var nodes v1.NodeList
			if err := cs.K8sClient.List(gctx, &nodes); err != nil {
				return err
			}
			nm.total = len(nodes.Items)
			// 方案：使用 int64 运算，而不是 resource.Quantity.Add()
			// （避免 big.Int 运算——在累加循环里快约 10-50 倍）
			for i := range nodes.Items {
				node := &nodes.Items[i]
				nm.cpuAllocatable += node.Status.Allocatable.Cpu().MilliValue()
				nm.memAllocatable += node.Status.Allocatable.Memory().MilliValue()
				for _, cond := range node.Status.Conditions {
					if cond.Type == v1.NodeReady && cond.Status == v1.ConditionTrue {
						nm.ready++
						break
					}
				}
			}
			return nil
		})
	}

	// Goroutine 2：列出 pod + 计算资源 requests/limits + 运行中数量
	g.Go(func() error {
		var pods v1.PodList
		if err := cs.K8sClient.List(gctx, &pods); err != nil {
			return err
		}
		for i := range pods.Items {
			pod := &pods.Items[i]
			if visible != nil {
				if _, ok := visible[pod.Namespace]; !ok {
					continue
				}
			}
			pm.addPod(pod)
		}
		return nil
	})

	// Goroutine 3：列出 service（只计数）
	g.Go(func() error {
		var services v1.ServiceList
		if err := cs.K8sClient.List(gctx, &services); err != nil {
			return err
		}
		if visible == nil {
			svcCount = len(services.Items)
			return nil
		}
		for i := range services.Items {
			if _, ok := visible[services.Items[i].Namespace]; ok {
				svcCount++
			}
		}
		return nil
	})

	// 等待所有 goroutine；任一失败则取消上下文
	if err := g.Wait(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 内存由 Value() 以字节返回；为 API 转换为 milli
	// （与原先对 Quantity 使用 MilliValue() 的行为保持一致）
	overview := OverviewData{
		TotalNodes:      nm.total,
		ReadyNodes:      nm.ready,
		TotalPods:       pm.total,
		RunningPods:     pm.running,
		TotalNamespaces: nsCount,
		TotalServices:   svcCount,
		// Prometheus 指标是集群级聚合，受限账号不看。
		PromEnabled: fullAccess && cs.PromClient != nil,
		Scoped:      !fullAccess,
		Resource: common.ResourceMetric{
			CPU: common.Resource{
				Allocatable: nm.cpuAllocatable,
				Requested:   pm.cpuRequested,
				Limited:     pm.cpuLimited,
			},
			Mem: common.Resource{
				Allocatable: nm.memAllocatable,
				Requested:   pm.memRequested,
				Limited:     pm.memLimited,
			},
		},
	}

	c.JSON(http.StatusOK, overview)
}
