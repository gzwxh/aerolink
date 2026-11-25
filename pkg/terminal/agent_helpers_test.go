package terminal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aerolink/pkg/wsutil"
	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func nodeWithStatusArch(arch string) *corev1.Node {
	return &corev1.Node{Status: corev1.NodeStatus{NodeInfo: corev1.NodeSystemInfo{Architecture: arch}}}
}

func nodeWithLabels(labels map[string]string) *corev1.Node {
	return &corev1.Node{ObjectMeta: metav1.ObjectMeta{Labels: labels}}
}

// 架构来源的优先级：kubelet 上报的 NodeInfo > kubernetes.io/arch > beta.kubernetes.io/arch，
// 拿不到时返回空串（调用方因此保持原镜像名，不能把它当成 arm64）。
func TestNodeArchitecture(t *testing.T) {
	cases := []struct {
		name string
		node *corev1.Node
		want string
	}{
		{"nil 节点", nil, ""},
		{"NodeInfo 优先于标签", &corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{corev1.LabelArchStable: "amd64"}},
			Status:     corev1.NodeStatus{NodeInfo: corev1.NodeSystemInfo{Architecture: "arm64"}},
		}, "arm64"},
		{"只有稳定标签", nodeWithLabels(map[string]string{corev1.LabelArchStable: "arm64"}), "arm64"},
		{"只有 beta 标签", nodeWithLabels(map[string]string{"beta.kubernetes.io/arch": "arm64"}), "arm64"},
		{"稳定标签优先于 beta", nodeWithLabels(map[string]string{
			corev1.LabelArchStable: "arm64", "beta.kubernetes.io/arch": "amd64",
		}), "arm64"},
		{"标签值为空", nodeWithLabels(map[string]string{corev1.LabelArchStable: ""}), ""},
		{"什么都没上报", nodeWithStatusArch(""), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nodeArchitecture(tc.node); got != tc.want {
				t.Fatalf("nodeArchitecture() = %q, want %q", got, tc.want)
			}
		})
	}
}

// arm64 节点上的终端镜像要按 -arm64 后缀约定改写（SWR 里的基座都是单架构独立 tag）；
// 不带 tag、digest 引用、已带后缀与非 arm64 节点都必须原样返回。
func TestApplyNodeArchImage(t *testing.T) {
	const swrBusybox = "swr.cn-south-1.myhuaweicloud.com/gzwxh/busybox:latest"

	cases := []struct {
		name  string
		arch  string
		image string
		want  string
	}{
		{"arm64 补后缀", "arm64", swrBusybox, swrBusybox + "-arm64"},
		{"arm64 已带后缀不叠加", "arm64", swrBusybox + "-arm64", swrBusybox + "-arm64"},
		{"amd64 不变", "amd64", swrBusybox, swrBusybox},
		{"架构未知不变", "", swrBusybox, swrBusybox},
		{"其它架构不变", "s390x", swrBusybox, swrBusybox},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := applyNodeArchImage(tc.image, nodeWithStatusArch(tc.arch)); got != tc.want {
				t.Fatalf("applyNodeArchImage(%q, %s) = %q, want %q", tc.image, tc.arch, got, tc.want)
			}
		})
	}

	arm64 := nodeWithStatusArch("arm64")
	shapes := []struct {
		name  string
		image string
		want  string
	}{
		{"无 tag 不改", "busybox", "busybox"},
		{"digest 引用不改", "repo/busybox@sha256:aaaa", "repo/busybox@sha256:aaaa"},
		{"带 tag 又带 digest 不改", "repo/busybox:latest@sha256:aaaa", "repo/busybox:latest@sha256:aaaa"},
		{"空镜像", "", ""},
		{"空 tag 不改", "busybox:", "busybox:"},
		{"registry 带端口只改 tag", "reg:5000/team/busybox:1.2", "reg:5000/team/busybox:1.2-arm64"},
		{"前后空格先清", "  " + swrBusybox + "  ", swrBusybox + "-arm64"},
		{"单段名字也能改", "busybox:1.37", "busybox:1.37-arm64"},
	}
	for _, tc := range shapes {
		t.Run(tc.name, func(t *testing.T) {
			if got := applyNodeArchImage(tc.image, arm64); got != tc.want {
				t.Fatalf("applyNodeArchImage(%q) = %q, want %q", tc.image, got, tc.want)
			}
		})
	}
}

// 客户端断开（ctx 取消）不是「pod 就绪」：此前这里返回 nil，调用方会接着去 attach
// 一个状态未知的 pod，把真实原因掩盖成后面那一步的报错。
//
// cs 传 nil 是刻意的：取消必须先把任何集群访问挡下来，否则这里会直接 panic
// 而不是返回错误。
func TestWaitForAgentPodReadyReportsContextCancellation(t *testing.T) {
	results := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsutil.Serve(w, r, func(ws *wsutil.Session) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			results <- waitForAgentPodReady(ctx, nil, ws, "agent-pod", "ready!")
		})
	}))
	t.Cleanup(server.Close)

	url := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, response, err := websocket.DefaultDialer.Dial(url, nil)
	if response != nil {
		defer func() {
			_ = response.Body.Close()
		}()
	}
	if err != nil {
		t.Fatalf("dialing WebSocket: %v", err)
	}
	defer func() {
		_ = conn.Close()
	}()

	if err := <-results; !errors.Is(err, context.Canceled) {
		t.Fatalf("waitForAgentPodReady() = %v, want context.Canceled", err)
	}
}
