package terminal

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/kube"
	"aerolink/pkg/model"
	"aerolink/pkg/rbac"
	"aerolink/pkg/utils"
	"aerolink/pkg/wsutil"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/klog/v2"
)

type NodeTerminalHandler struct {
}

func NewNodeTerminalHandler() *NodeTerminalHandler {
	return &NodeTerminalHandler{}
}

// HandleNodeTerminalWebSocket 处理用于节点终端访问的 WebSocket 连接
func (h *NodeTerminalHandler) HandleNodeTerminalWebSocket(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	nodeName := c.Param("nodeName")
	if nodeName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Node name is required"})
		return
	}

	user := c.MustGet("user").(model.User)

	// 在 WebSocket 升级之前完成鉴权。
	if !rbac.CanAccess(user, string(common.Nodes), "exec", cs.Name, "") {
		c.JSON(http.StatusForbidden, gin.H{
			"error": rbac.NoAccess(user.Key(), string(common.VerbExec), string(common.Nodes), "", cs.Name),
		})
		return
	}

	wsutil.Serve(c.Writer, c.Request, func(ws *wsutil.Session) {
		ctx := ws.Context

		// 节点终端与日志/Pod 终端共用同一个每用户名额池（缺陷 D-55）。
		releaseStream, allowed := wsutil.LimitStream(ws, user.Username)
		if !allowed {
			return
		}
		defer releaseStream()
		node, err := cs.K8sClient.ClientSet.CoreV1().Nodes().Get(ctx, nodeName, metav1.GetOptions{})
		if err != nil {
			klog.Errorf("Failed to get node %s: %v", nodeName, err)
			ws.SendErrorMessage(fmt.Sprintf("Failed to get node %s: %v", nodeName, err))
			return
		}
		setting, err := model.GetGeneralSetting()
		if err != nil {
			klog.Errorf("Failed to load general setting: %v", err)
			ws.SendErrorMessage(fmt.Sprintf("Failed to load settings: %v", err))
			return
		}
		nodeTerminalImage := strings.TrimSpace(setting.NodeTerminalImage)
		if nodeTerminalImage == "" {
			nodeTerminalImage = common.NodeTerminalImage
		}
		// Agent Pod 用 Spec.NodeName 绑在这台节点上，而镜像名只有一个全局值：arm64 节点
		// 拿到 amd64 镜像只会 exec format error，所以按节点架构挑带 -arm64 后缀的那份。
		nodeTerminalImage = applyNodeArchImage(nodeTerminalImage, node)
		nodeAgentName, err := h.createNodeAgent(ctx, cs, nodeName, nodeTerminalImage)
		if err != nil {
			klog.Errorf("Failed to create node agent pod: %v", err)
			ws.SendErrorMessage(fmt.Sprintf("Failed to create node agent pod: %v", err))
			return
		}

		// 确保清理节点 agent pod
		defer func() {
			klog.Infof("Cleaning up node agent pod %s", nodeAgentName)
			if err := h.cleanupNodeAgentPod(cs, nodeAgentName); err != nil {
				klog.Errorf("Failed to cleanup node agent pod %s: %v", nodeAgentName, err)
			}
		}()

		if err := waitForAgentPodReady(ctx, cs, ws, nodeAgentName, "ready!"); err != nil {
			klog.Errorf("Failed to wait for pod ready: %v", err)
			ws.SendErrorMessage(fmt.Sprintf("Failed to wait for pod ready: %v", err))
			return
		}

		session := kube.NewTerminalSession(cs.K8sClient, ws.Conn, common.AgentPodNamespace, nodeAgentName, common.NodeTerminalPodName)
		if err := session.Start(ctx, "attach"); err != nil {
			klog.Errorf("Terminal session error: %v", err)
		}
	})
}

func (h *NodeTerminalHandler) createNodeAgent(ctx context.Context, cs *cluster.ClientSet, nodeName, image string) (string, error) {
	podName := utils.GenerateNodeAgentName(nodeName)
	// 定义 aerolink node agent 的 pod spec
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName,
			Namespace: common.AgentPodNamespace,
			Labels: map[string]string{
				"app": podName,
			},
		},
		Spec: corev1.PodSpec{
			NodeName:      nodeName,
			HostNetwork:   true,
			HostPID:       true,
			HostIPC:       true,
			RestartPolicy: corev1.RestartPolicyNever,
			Tolerations: []corev1.Toleration{
				{
					Operator: corev1.TolerationOpExists,
				},
			},
			Volumes: []corev1.Volume{
				{
					Name: "host",
					VolumeSource: corev1.VolumeSource{
						HostPath: &corev1.HostPathVolumeSource{
							Path: "/",
						},
					},
				},
			},
			Containers: []corev1.Container{
				{
					Name:            common.NodeTerminalPodName,
					Image:           image,
					ImagePullPolicy: corev1.PullIfNotPresent,
					Stdin:           true,
					StdinOnce:       true,
					TTY:             true,
					Command:         []string{"/bin/sh", "-c", "chroot /host || (exec /bin/zsh || exec /bin/bash || exec /bin/sh)"},
					SecurityContext: &corev1.SecurityContext{
						Privileged: &[]bool{true}[0],
					},
					VolumeMounts: []corev1.VolumeMount{
						{
							Name:      "host",
							MountPath: "/host",
						},
					},
				},
			},
		},
	}

	object := &corev1.Pod{}
	namespacedName := types.NamespacedName{Name: podName, Namespace: common.AgentPodNamespace}
	if err := cs.K8sClient.Get(ctx, namespacedName, object); err == nil {
		if utils.IsPodErrorOrSuccess(object) {
			if err := cs.K8sClient.Delete(ctx, object); err != nil {
				return "", fmt.Errorf("failed to delete existing aerolink node agent pod: %w", err)
			}
			// 删除是异步的；紧随其后的 Create 会失败
			// 并报 "object is being deleted"，直到 API Server 完成删除。
			err := wait.PollUntilContextTimeout(ctx, 200*time.Millisecond, 10*time.Second, true, func(ctx context.Context) (bool, error) {
				getErr := cs.K8sClient.Get(ctx, namespacedName, &corev1.Pod{})
				if getErr == nil {
					return false, nil
				}
				if apierrors.IsNotFound(getErr) {
					return true, nil
				}
				return false, getErr
			})
			if err != nil {
				return "", fmt.Errorf("timed out waiting for the old aerolink node agent pod %s to be deleted: %w", podName, err)
			}
		} else {
			return podName, nil
		}
	}

	// 创建 pod
	err := cs.K8sClient.Create(ctx, pod)
	if err != nil {
		return "", fmt.Errorf("failed to create aerolink node agent pod: %w", err)
	}

	return podName, nil
}

func (h *NodeTerminalHandler) cleanupNodeAgentPod(cs *cluster.ClientSet, podName string) error {
	return cs.K8sClient.ClientSet.CoreV1().Pods(common.AgentPodNamespace).Delete(
		context.TODO(),
		podName,
		metav1.DeleteOptions{},
	)
}
