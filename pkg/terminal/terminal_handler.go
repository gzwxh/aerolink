package terminal

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/wsutil"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/klog/v2"
)

type TerminalHandler struct {
}

func NewTerminalHandler() *TerminalHandler {
	return &TerminalHandler{}
}

// HandleTerminalWebSocket 处理终端会话的 WebSocket 连接
func (h *TerminalHandler) HandleTerminalWebSocket(c *gin.Context) {
	// 从上下文获取集群信息
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	// 获取路径参数
	namespace := c.Param("namespace")
	podName := c.Param("podName")
	container := c.Query("container")

	if namespace == "" || podName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and podName are required"})
		return
	}

	user := c.MustGet("user").(model.User)

	// 在 WebSocket 升级之前完成鉴权：没有权限的客户端
	// 根本不应该拿到已建立的会话。
	if !rbac.CanAccess(user, string(common.Pods), "exec", cs.Name, namespace) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": rbac.NoAccess(user.Key(), string(common.VerbExec), string(common.Pods), namespace, cs.Name),
		})
		return
	}

	wsutil.Serve(c.Writer, c.Request, func(ws *wsutil.Session) {
		// exec 会话与日志流共用同一个每用户名额池（缺陷 D-55）。
		releaseStream, allowed := wsutil.LimitStream(ws, user.Username)
		if !allowed {
			return
		}
		defer releaseStream()

		session := kube.NewTerminalSession(cs.K8sClient, ws.Conn, namespace, podName, container)
		defer session.Close()

		subResource := "exec"
		if c.Query("attach") == "true" {
			var err error
			subResource, err = waitForDebugContainer(ws, cs, namespace, podName, container)
			if err != nil {
				ws.SendErrorMessage(fmt.Sprintf("Unable to connect to debug container %s: %v", container, err))
				return
			}
		}

		if err := session.Start(ws.Context, subResource); err != nil {
			klog.Errorf("Terminal session error: %v", err)
		}
	})
}

type containerLookup struct {
	found       bool
	interactive bool
	statuses    []corev1.ContainerStatus
}

func lookupContainer(pod *corev1.Pod, name string) containerLookup {
	for _, c := range pod.Spec.EphemeralContainers {
		if c.Name == name {
			return containerLookup{true, c.Stdin && c.TTY, pod.Status.EphemeralContainerStatuses}
		}
	}
	for _, c := range pod.Spec.Containers {
		if c.Name == name {
			return containerLookup{true, c.Stdin && c.TTY, pod.Status.ContainerStatuses}
		}
	}
	for _, c := range pod.Spec.InitContainers {
		if c.Name == name {
			return containerLookup{true, c.Stdin && c.TTY, pod.Status.InitContainerStatuses}
		}
	}
	return containerLookup{}
}

// waitForDebugContainer 阻塞直到该容器进入 running 状态，并返回要流式传输的
// 子资源："attach"（容器保持 stdin/tty 打开时），
// 否则为 "exec"。
func waitForDebugContainer(ws *wsutil.Session, cs *cluster.ClientSet, namespace, podName, container string) (string, error) {
	lastMessage := fmt.Sprintf("Waiting for debug container %s to start", container)
	if err := ws.SendMessage("info", lastMessage); err != nil {
		return "", err
	}
	subResource := "exec"
	err := wait.PollUntilContextTimeout(ws.Context, time.Second, 60*time.Second, true, func(ctx context.Context) (bool, error) {
		pod, err := cs.K8sClient.ClientSet.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
		if err != nil {
			return false, err
		}
		if pod.DeletionTimestamp != nil || pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			return false, fmt.Errorf("pod %s is terminating or has completed", podName)
		}
		target := lookupContainer(pod, container)
		if !target.found {
			return false, fmt.Errorf("debug container %s not found", container)
		}
		if target.interactive {
			subResource = "attach"
		}
		for _, status := range target.statuses {
			if status.Name != container {
				continue
			}
			if status.State.Running != nil {
				return true, nil
			}
			if terminated := status.State.Terminated; terminated != nil {
				return false, fmt.Errorf("debug container %s has exited (code %d)", container, terminated.ExitCode)
			}
			if waiting := status.State.Waiting; waiting != nil {
				message := fmt.Sprintf("%s: %s", waiting.Reason, waiting.Message)
				if message != lastMessage {
					lastMessage = message
					if err := ws.SendMessage("info", message); err != nil {
						return false, err
					}
				}
			}
		}
		return false, nil
	})
	if err != nil {
		return "", err
	}
	return subResource, nil
}
