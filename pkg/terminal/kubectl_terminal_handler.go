package terminal

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/utils"
	"github.com/zxh326/kite/pkg/wsutil"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/klog/v2"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/zxh326/kite/pkg/common"
)

const (
	kubectlAdminSA = "aerolink-kubectl-admin"
)

type KubectlTerminalHandler struct {
}

func NewKubectlTerminalHandler() *KubectlTerminalHandler {
	return &KubectlTerminalHandler{}
}

func (h *KubectlTerminalHandler) HandleKubectlTerminalWebSocket(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	user := c.MustGet("user").(model.User)

	// 只有管理员可以使用 kubectl 终端；鉴权必须在
	// WebSocket 升级之前完成（下面的功能开关同样如此）。
	if !rbac.IsAdministrator(user) {
		c.JSON(http.StatusForbidden, gin.H{"error": "kubectl terminal is only available to admin users"})
		return
	}

	setting, err := model.GetGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load settings: %v", err)})
		return
	}
	if !setting.KubectlEnabled {
		c.JSON(http.StatusForbidden, gin.H{"error": "kubectl terminal is disabled"})
		return
	}
	kubectlImage := strings.TrimSpace(setting.KubectlImage)
	if kubectlImage == "" {
		kubectlImage = common.KubectlTerminalImage
	}

	wsutil.Serve(c.Writer, c.Request, func(ws *wsutil.Session) {
		ctx := ws.Context

		// 确保共享的管理员 ServiceAccount 与 ClusterRoleBinding 已存在
		if err := h.ensureAdminServiceAccount(ctx, cs); err != nil {
			klog.Errorf("Failed to ensure kubectl admin SA: %v", err)
			ws.SendErrorMessage(fmt.Sprintf("Failed to setup kubectl terminal: %v", err))
			return
		}

		instanceID := utils.GenerateKubectlAgentName(user.Key())

		podName, err := h.createKubectlAgent(ctx, cs, instanceID, kubectlImage)
		if err != nil {
			klog.Errorf("Failed to create kubectl agent pod: %v", err)
			ws.SendErrorMessage(fmt.Sprintf("Failed to create kubectl agent pod: %v", err))
			_ = h.cleanupPod(cs, instanceID)
			return
		}

		defer func() {
			klog.Infof("Cleaning up kubectl pod %s", instanceID)
			if err := h.cleanupPod(cs, instanceID); err != nil {
				klog.Errorf("Failed to cleanup kubectl pod %s: %v", instanceID, err)
			}
		}()

		if err := waitForAgentPodReady(ctx, cs, ws, podName, "kubectl agent ready!"); err != nil {
			klog.Errorf("Failed to wait for kubectl agent pod ready: %v", err)
			ws.SendErrorMessage(fmt.Sprintf("Failed to wait for kubectl agent pod ready: %v", err))
			return
		}

		session := kube.NewTerminalSession(cs.K8sClient, ws.Conn, common.AgentPodNamespace, podName, common.KubectlTerminalPodName)
		if err := session.Start(ctx, "attach"); err != nil {
			klog.Errorf("Kubectl terminal session error: %v", err)
		}
	})
}

// ensureAdminServiceAccount 在不存在时创建一次 cluster-admin 的 ServiceAccount。
func (h *KubectlTerminalHandler) ensureAdminServiceAccount(ctx context.Context, cs *cluster.ClientSet) error {
	labels := map[string]string{
		"app.kubernetes.io/managed-by": "aerolink",
		"aerolink.io/component":        "kubectl-terminal",
	}

	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      kubectlAdminSA,
			Namespace: common.AgentPodNamespace,
			Labels:    labels,
		},
	}
	if err := cs.K8sClient.Create(ctx, sa); client.IgnoreAlreadyExists(err) != nil {
		return fmt.Errorf("failed to create ServiceAccount: %w", err)
	}

	crb := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:   kubectlAdminSA,
			Labels: labels,
		},
		Subjects: []rbacv1.Subject{
			{
				Kind:      "ServiceAccount",
				Name:      kubectlAdminSA,
				Namespace: common.AgentPodNamespace,
			},
		},
		RoleRef: rbacv1.RoleRef{
			Kind:     "ClusterRole",
			Name:     "cluster-admin",
			APIGroup: "rbac.authorization.k8s.io",
		},
	}
	if err := cs.K8sClient.Create(ctx, crb); client.IgnoreAlreadyExists(err) != nil {
		return fmt.Errorf("failed to create ClusterRoleBinding: %w", err)
	}

	return nil
}

func (h *KubectlTerminalHandler) createKubectlAgent(ctx context.Context, cs *cluster.ClientSet, instanceID, image string) (string, error) {
	podName := instanceID

	gracePeriod := int64(0)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName,
			Namespace: common.AgentPodNamespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "aerolink",
				"aerolink.io/component":        "kubectl-terminal",
				"aerolink.io/kubectl-session":  instanceID,
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy:                 corev1.RestartPolicyNever,
			ServiceAccountName:            kubectlAdminSA,
			AutomountServiceAccountToken:  &[]bool{true}[0],
			Hostname:                      "kubectl",
			TerminationGracePeriodSeconds: &gracePeriod,
			Containers: []corev1.Container{
				{
					Name:            common.KubectlTerminalPodName,
					Image:           image,
					ImagePullPolicy: corev1.PullIfNotPresent,
					Stdin:           true,
					StdinOnce:       true,
					TTY:             true,
					Command:         []string{"bash", "-c", `exec bash`},
				},
			},
		},
	}

	if err := cs.K8sClient.Create(ctx, pod); err != nil {
		return "", fmt.Errorf("failed to create kubectl agent pod: %w", err)
	}

	return podName, nil
}

// cleanupPod 只删除该会话专属的 pod（管理员 SA/CRB 是长期存在的）。
func (h *KubectlTerminalHandler) cleanupPod(cs *cluster.ClientSet, instanceID string) error {
	ctx := context.TODO()
	opts := []client.DeleteAllOfOption{
		client.InNamespace(common.AgentPodNamespace),
		client.MatchingLabels{"aerolink.io/kubectl-session": instanceID},
		client.PropagationPolicy(metav1.DeletePropagationBackground),
	}
	return cs.K8sClient.DeleteAllOf(ctx, &corev1.Pod{}, opts...)
}
