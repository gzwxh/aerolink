package resources

import (
	"context"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/wsutil"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/klog/v2"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type LogsHandler struct {
}

func NewLogsHandler() *LogsHandler {
	return &LogsHandler{}
}

// HandleLogsWebSocket 处理用于日志流式传输的 WebSocket 连接
func (h *LogsHandler) HandleLogsWebSocket(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	user := c.MustGet("user").(model.User)
	namespace := c.Param("namespace")
	podName := c.Param("podName")
	if namespace == "" || podName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and podName are required"})
		return
	}

	// 在 WebSocket 升级之前完成鉴权。
	if !rbac.CanAccess(user, string(common.Pods), "log", cs.Name, namespace) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": rbac.NoAccess(user.Key(), string(common.VerbLog), string(common.Pods), namespace, cs.Name),
		})
		return
	}

	wsutil.Serve(c.Writer, c.Request, func(ws *wsutil.Session) {
		ctx := ws.Context

		// 一条日志流就是一条常驻的 apiserver 日志流，按用户限并发（缺陷 D-55）。
		releaseStream, ok := wsutil.LimitStream(ws, user.Username)
		if !ok {
			return
		}
		defer releaseStream()

		container := c.Query("container")
		tailLines := c.DefaultQuery("tailLines", "100")
		timestamps := c.DefaultQuery("timestamps", "true")
		previous := c.DefaultQuery("previous", "false")
		sinceSeconds := c.Query("sinceSeconds")

		tail, err := strconv.ParseInt(tailLines, 10, 64)
		if err != nil {
			ws.SendErrorMessage("invalid tailLines parameter")
			return
		}
		timestampsBool := timestamps == "true"
		previousBool := previous == "true"
		tailPtr := &tail
		if *tailPtr == -1 {
			tailPtr = nil
		}

		// 构造日志选项
		logOptions := &corev1.PodLogOptions{
			Container:  container,
			Follow:     true,
			Timestamps: timestampsBool,
			TailLines:  tailPtr,
			Previous:   previousBool,
		}

		if sinceSeconds != "" {
			since, err := strconv.ParseInt(sinceSeconds, 10, 64)
			if err != nil {
				ws.SendErrorMessage("invalid sinceSeconds parameter")
				return
			}
			logOptions.SinceSeconds = &since
		}

		labelSelector := c.Query("labelSelector")
		bl := kube.NewBatchLogHandler(ws.Conn, cs.K8sClient, logOptions)

		// "_all" 是控制台的通配符，不是真实的命名空间：
		// 在调用 Kubernetes API 之前把它映射为 API 约定的空命名空间
		// （表示所有命名空间）。
		listNamespace := namespace
		if listNamespace == common.AllNamespaces {
			listNamespace = ""
		}

		if podName == common.AllNamespaces && labelSelector != "" {
			selector, err := metav1.ParseToLabelSelector(labelSelector)
			if err != nil {
				ws.SendErrorMessage("invalid labelSelector parameter: " + err.Error())
				return
			}
			labelSelectorOption, err := metav1.LabelSelectorAsSelector(selector)
			if err != nil {
				ws.SendErrorMessage("failed to convert labelSelector: " + err.Error())
				return
			}

			podList := &corev1.PodList{}
			var listOpts []client.ListOption
			listOpts = append(listOpts, client.InNamespace(listNamespace))
			listOpts = append(listOpts, client.MatchingLabelsSelector{Selector: labelSelectorOption})
			if err := cs.K8sClient.List(ctx, podList, listOpts...); err != nil {
				ws.SendErrorMessage("failed to list pods: " + err.Error())
				return
			}
			for _, pod := range podList.Items {
				if pod.Status.Phase == corev1.PodRunning {
					bl.AddPod(pod)
				}
			}

			go h.watchPods(ctx, cs, listNamespace, labelSelectorOption, bl)
		} else {
			if podName == common.AllNamespaces {
				ws.SendErrorMessage("streaming all pods requires a labelSelector")
				return
			}
			bl.AddPod(corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      podName,
					Namespace: listNamespace,
				},
			})
		}

		bl.StreamLogs(ctx)
	})
}

func (h *LogsHandler) watchPods(ctx context.Context, cs *cluster.ClientSet, namespace string, labelSelector labels.Selector, bl *kube.BatchLogHandler) {
	listOptions := metav1.ListOptions{
		LabelSelector: labelSelector.String(),
	}

	watchInterface, err := cs.K8sClient.ClientSet.CoreV1().Pods(namespace).Watch(ctx, listOptions)
	if err != nil {
		return
	}
	defer watchInterface.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-watchInterface.ResultChan():
			if !ok {
				return
			}

			pod, ok := event.Object.(*corev1.Pod)
			if !ok {
				continue
			}

			klog.V(4).Infof("Pod %s in namespace %s is %s, event Type: %s", pod.Name, pod.Namespace, pod.Status.Phase, event.Type)

			switch event.Type {
			case watch.Added, watch.Modified:
				if pod.Status.Phase == corev1.PodRunning {
					bl.AddPod(*pod)
				} else {
					bl.RemovePod(*pod)
				}
			case watch.Deleted:
				bl.RemovePod(*pod)
			}
		}
	}
}
