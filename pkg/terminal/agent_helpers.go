package terminal

import (
	"context"
	"fmt"
	"strings"
	"time"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/utils"
	"aerolink/pkg/wsutil"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	agentPodWaitTimeout   = 60 * time.Second
	agentPodCheckInterval = 2 * time.Second

	// arm64ImageSuffix 是 arm64 节点要用的镜像 tag 后缀，与公司 SWR 里基座镜像的命名口径
	// 一致（openeuler:24.03-lts-sp4-arm64）：SWR 的多架构 manifest list 解析不可靠，
	// 跨架构一律走独立 tag。
	arm64ImageSuffix = "-arm64"
	// arm64ArchName 用 Kubernetes 的架构取值（kubelet 上报与节点标签都是 GOARCH 口径的
	// arm64，不是 uname 的 aarch64）。
	arm64ArchName = "arm64"
)

// nodeArchitecture 取节点架构：优先 kubelet 上报的 NodeInfo，其次节点标签
// （kubernetes.io/arch，老集群回落 beta.kubernetes.io/arch）。都拿不到时返回空串，
// 调用方据此保持原镜像名，行为与改动前一致。
func nodeArchitecture(node *corev1.Node) string {
	if node == nil {
		return ""
	}
	if arch := node.Status.NodeInfo.Architecture; arch != "" {
		return arch
	}
	for _, key := range []string{corev1.LabelArchStable, "beta.kubernetes.io/arch"} {
		if arch := node.Labels[key]; arch != "" {
			return arch
		}
	}
	return ""
}

// applyNodeArchImage 按目标节点架构改写终端镜像：节点终端的 Agent Pod 是用
// Spec.NodeName 绑到那台节点上的，arm64 节点拿到 amd64 镜像只会 exec format error，
// 而界面上只有一个全局镜像名，所以这里按 tag 后缀约定替节点挑一份能跑的。
//
// 只有「显式带 tag、不是 digest 引用、tag 还没带后缀」三条都满足才改写，其余原样返回：
//   - 不带 tag 的名字（busybox、nginx）多指向上游多架构镜像，加后缀反而把能跑的改坏；
//   - digest 引用的架构已被摘要锁死，改写只会指向不存在的东西。
//
// 改写落空的最坏结果是 ImagePullBackoff；arm64 节点上用 amd64 镜像原本是必定起不来的，
// 所以不为此先去探测仓库里有没有那个 tag（也没有可用的凭据口径）。真遇到不带 -arm64
// 后缀的 arm64 镜像，把完整镜像名直接填进界面即可，后缀已在的不会被叠加。
func applyNodeArchImage(image string, node *corev1.Node) string {
	if nodeArchitecture(node) != arm64ArchName {
		return image
	}
	ref := strings.TrimSpace(image)
	if ref == "" || strings.Contains(ref, "@") {
		return image
	}
	// tag 的分隔符只认最后一个 / 之后的冒号，否则 reg:5000/x 的端口号会被当成 tag。
	sep := strings.LastIndex(ref, ":")
	if sep == -1 || sep < strings.LastIndex(ref, "/") {
		return image
	}
	tag := ref[sep+1:]
	if tag == "" || strings.HasSuffix(tag, arm64ImageSuffix) {
		return image
	}
	return ref[:sep] + ":" + tag + arm64ImageSuffix
}

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
