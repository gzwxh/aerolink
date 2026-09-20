package terminal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/zxh326/kite/pkg/wsutil"
)

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
