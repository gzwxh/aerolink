package kube

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"aerolink/pkg/wsutil"
	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// blockingLogReader 一直阻塞到 ctx 被取消，再从 Read 返回 io.EOF。
type blockingLogReader struct {
	ctx     context.Context
	stopped chan struct{}
	once    sync.Once
}

func (r *blockingLogReader) Read([]byte) (int, error) {
	<-r.ctx.Done()
	if r.stopped != nil {
		r.once.Do(func() { close(r.stopped) })
	}
	return 0, io.EOF
}

func (r *blockingLogReader) Close() error { return nil }

func batchLogTestPod() corev1.Pod {
	return corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "default", Name: "web"}}
}

// startBatchLogServer 起一个真实的 WebSocket 服务端，并交给 run 一个只连了日志流
// 打开器的 BatchLogHandler（不发真实请求到集群）。
func startBatchLogServer(t *testing.T, open func(context.Context, corev1.Pod) (io.ReadCloser, error),
	run func(handler *BatchLogHandler)) <-chan struct{} {
	t.Helper()

	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsutil.Serve(w, r, func(ws *wsutil.Session) {
			defer close(finished)
			handler := NewBatchLogHandler(ws.Conn, &K8sClient{}, nil)
			handler.openPodLogStream = open
			run(handler)
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
	t.Cleanup(func() {
		_ = conn.Close()
	})
	// 服务端会往连接上写消息，这里持续读掉，避免写侧因为缓冲区满而卡住。
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	return finished
}

func publishedStream(t *testing.T, handler *BatchLogHandler, key string) *PodLogStream {
	t.Helper()
	handler.mu.RLock()
	defer handler.mu.RUnlock()
	return handler.pods[key]
}

// RemovePod 必须能取消一条已经开始的日志流。
func TestBatchLogHandlerRemovePodStopsStream(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	open := func(ctx context.Context, _ corev1.Pod) (io.ReadCloser, error) {
		close(started)
		return &blockingLogReader{ctx: ctx, stopped: stopped}, nil
	}

	results := make(chan error, 1)
	finished := startBatchLogServer(t, open, func(handler *BatchLogHandler) {
		pod := batchLogTestPod()
		handler.AddPod(pod)

		stream := publishedStream(t, handler, "default/web")
		if stream == nil {
			results <- fmt.Errorf("AddPod did not publish the stream")
			return
		}
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			results <- fmt.Errorf("the pod log stream never started")
			return
		}

		handler.RemovePod(pod)
		select {
		case <-stream.Done:
			if err := stream.ctx.Err(); !errors.Is(err, context.Canceled) {
				results <- fmt.Errorf("stream ctx = %w, want context.Canceled", err)
				return
			}
			results <- nil
		case <-time.After(5 * time.Second):
			results <- fmt.Errorf("RemovePod did not stop the pod log stream")
		}
	})

	if err := <-results; err != nil {
		t.Fatal(err)
	}
	<-finished
}

// RemovePod 紧跟在 AddPod 之后（流式协程可能还没被调度）也必须能取消：取消句柄在
// 发布进 l.pods 之前就已就位，而不是由流式协程稍后写入。
//
// 修复前这里既漏取消（读到 nil，协程与日志流一直挂着），又构成数据竞争——流式协程
// 无锁写 Cancel、RemovePod 读它。`go test -race ./pkg/kube/` 可直接复现该竞争。
func TestBatchLogHandlerRemovePodRightAfterAddPod(t *testing.T) {
	results := make(chan error, 1)
	finished := startBatchLogServer(t,
		func(ctx context.Context, _ corev1.Pod) (io.ReadCloser, error) {
			return &blockingLogReader{ctx: ctx}, nil
		},
		func(handler *BatchLogHandler) {
			pod := batchLogTestPod()
			handler.AddPod(pod)

			stream := publishedStream(t, handler, "default/web")
			if stream == nil {
				results <- fmt.Errorf("AddPod did not publish the stream")
				return
			}

			handler.RemovePod(pod)
			select {
			case <-stream.Done:
				results <- nil
			case <-time.After(5 * time.Second):
				results <- fmt.Errorf("RemovePod missed the cancellation of a stream that had not started yet")
			}
		})

	if err := <-results; err != nil {
		t.Fatal(err)
	}
	<-finished
}

// Stop 同样要取消所有在途的流。
func TestBatchLogHandlerStopCancelsStreams(t *testing.T) {
	results := make(chan error, 1)
	finished := startBatchLogServer(t,
		func(ctx context.Context, _ corev1.Pod) (io.ReadCloser, error) {
			return &blockingLogReader{ctx: ctx}, nil
		},
		func(handler *BatchLogHandler) {
			pod := batchLogTestPod()
			handler.AddPod(pod)

			stream := publishedStream(t, handler, "default/web")
			if stream == nil {
				results <- fmt.Errorf("AddPod did not publish the stream")
				return
			}

			handler.Stop()
			select {
			case <-stream.Done:
				results <- nil
			case <-time.After(5 * time.Second):
				results <- fmt.Errorf("Stop did not stop the pod log stream")
			}
		})

	if err := <-results; err != nil {
		t.Fatal(err)
	}
	<-finished
}
