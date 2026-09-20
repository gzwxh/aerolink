package terminal

import (
	"context"
	"fmt"
	"time"

	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/utils"
	"github.com/zxh326/kite/pkg/wsutil"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	agentPodWaitTimeout   = 60 * time.Second
	agentPodCheckInterval = 2 * time.Second
)

// waitForAgentPodReady 轮询直到 AgentPodNamespace 中指定的 pod 进入 Ready 状态，
// 期间通过 WebSocket 发送进度点。
func waitForAgentPodReady(ctx context.Context, cs *cluster.ClientSet, ws *wsutil.Session, podName, readyMsg string) error {
	timeout := time.After(agentPodWaitTimeout)
	ticker := time.NewTicker(agentPodCheckInterval)
	defer ticker.Stop()
	_ = ws.SendMessage("info", fmt.Sprintf("waiting for pod %s to be ready", podName))

	var pod *corev1.Pod
	for {
		select {
		case <-ctx.Done():
			// 客户端断开 / 上下文取消不是「就绪」。此前这里返回 nil，调用方会接着
			// attach 一个状态未知的 pod，真实原因被后面那一步的报错掩盖。
			return ctx.Err()
		case <-timeout:
			_ = ws.SendMessage("info", "")
			ws.SendErrorMessage(utils.GetPodErrorMessage(pod))
			return fmt.Errorf("timeout waiting for pod %s to be ready", podName)
		case <-ticker.C:
			var err error
			pod, err = cs.K8sClient.ClientSet.CoreV1().Pods(common.AgentPodNamespace).Get(ctx, podName, metav1.GetOptions{})
			if err != nil {
				continue
			}
			_ = ws.SendMessage("stdout", ".")
			if utils.IsPodReady(pod) {
				_ = ws.SendMessage("info", readyMsg)
				return nil
			}
		}
	}
}
