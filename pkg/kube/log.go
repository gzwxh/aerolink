package kube

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/gzwxh/aerolink/pkg/wsutil"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/klog/v2"
)

type PodLogStream struct {
	Pod corev1.Pod
	// ctx 与 Cancel 在发布进 BatchLogHandler.pods **之前**就已就位（见 AddPod），
	// 读取方据此可以安全地取消一条尚未开始的流。
	ctx    context.Context
	Cancel context.CancelFunc
	Done   chan struct{}
}

type BatchLogHandler struct {
	conn      *wsutil.Conn
	mu        sync.RWMutex
	pods      map[string]*PodLogStream // key: namespace/name; guarded by mu
	k8sClient *K8sClient
	opts      *corev1.PodLogOptions
	ctx       context.Context
	cancel    context.CancelFunc

	// openPodLogStream 打开某个 pod 的日志流。抽成字段只为让测试注入可控的流，
	// 生产路径固定是 openPodLogStreamFromClient（k8sClient 的 GetLogs）。
	openPodLogStream func(ctx context.Context, pod corev1.Pod) (io.ReadCloser, error)
}

func NewBatchLogHandler(conn *wsutil.Conn, client *K8sClient, opts *corev1.PodLogOptions) *BatchLogHandler {
	ctx, cancel := context.WithCancel(context.Background())
	l := &BatchLogHandler{
		conn:      conn,
		pods:      make(map[string]*PodLogStream),
		k8sClient: client,
		opts:      opts,
		ctx:       ctx,
		cancel:    cancel,
	}
	l.openPodLogStream = l.openPodLogStreamFromClient
	return l
}

func (l *BatchLogHandler) openPodLogStreamFromClient(ctx context.Context, pod corev1.Pod) (io.ReadCloser, error) {
	return l.k8sClient.ClientSet.CoreV1().Pods(pod.Namespace).GetLogs(pod.Name, l.opts).Stream(ctx)
}

func (l *BatchLogHandler) StreamLogs(ctx context.Context) {
	// 启动心跳处理器
	go l.heartbeat(ctx)

	// 等待外部上下文取消或内部取消
	select {
	case <-ctx.Done():
		klog.V(1).Info("External context cancelled, stopping BatchLogHandler")
	case <-l.ctx.Done():
		klog.V(1).Info("Internal context cancelled, stopping BatchLogHandler")
	}

	l.Stop()
}

func (l *BatchLogHandler) startPodLogStream(podStream *PodLogStream) {
	pod := podStream.Pod

	defer func() {
		close(podStream.Done)
	}()

	podLogs, err := l.openPodLogStream(podStream.ctx, pod)
	if err != nil {
		_ = wsutil.SendError(l.conn, fmt.Sprintf("Failed to get pod logs for %s: %v", pod.Name, err))
		return
	}
	defer func() {
		_ = podLogs.Close()
	}()

	var pendingLine bytes.Buffer
	sendLogLine := func(line string) error {
		if line == "" {
			return nil
		}

		l.mu.RLock()
		multiPod := len(l.pods) > 1
		l.mu.RUnlock()

		if multiPod {
			line = fmt.Sprintf("[%s]: %s", pod.Name, line)
		}

		return wsutil.SendMessage(l.conn, "log", line)
	}

	lw := writerFunc(func(p []byte) (int, error) {
		n := len(p)
		for len(p) > 0 {
			newlineIndex := bytes.IndexByte(p, '\n')
			if newlineIndex < 0 {
				_, _ = pendingLine.Write(p)
				return n, nil
			}

			if pendingLine.Len() == 0 {
				if err := sendLogLine(string(p[:newlineIndex])); err != nil {
					return 0, err
				}
			} else {
				_, _ = pendingLine.Write(p[:newlineIndex])
				if err := sendLogLine(pendingLine.String()); err != nil {
					return 0, err
				}
				pendingLine.Reset()
			}

			p = p[newlineIndex+1:]
		}

		return n, nil
	})

	_, err = io.Copy(lw, podLogs)
	if err == nil && pendingLine.Len() > 0 {
		err = sendLogLine(pendingLine.String())
	}
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) {
		_ = wsutil.SendError(l.conn, fmt.Sprintf("Failed to stream pod logs for %s: %v", pod.Name, err))
	}

	_ = wsutil.SendMessage(l.conn, "close", fmt.Sprintf("{\"status\":\"closed\",\"pod\":\"%s\"}", pod.Name))
}

func (l *BatchLogHandler) heartbeat(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			klog.V(1).Info("Heartbeat stopping due to context cancellation")
			return
		case <-l.ctx.Done():
			klog.V(1).Info("Heartbeat stopping due to internal context cancellation")
			return
		default:
			_, _, err := l.conn.ReadMessage()
			if err != nil {
				if !errors.Is(err, io.EOF) {
					klog.Errorf("WebSocket connection error in heartbeat, cancelling internal context: %v", err)
				}
				l.cancel() // Cancel internal context when connection is lost
				return
			}
		}
	}
}

// AddPod 向批量日志处理器新增一个 pod，并开始流式读取它的日志
func (l *BatchLogHandler) AddPod(pod corev1.Pod) {
	key := fmt.Sprintf("%s/%s", pod.Namespace, pod.Name)

	l.mu.Lock()
	if _, exists := l.pods[key]; exists {
		l.mu.Unlock()
		return
	}

	// 取消句柄必须在发布之前就位。此前它由流式协程在发布之后写入，读者可能先读到
	// nil 而漏掉取消，让这条日志流和它的协程一直挂着。
	podCtx, cancel := context.WithCancel(l.ctx)
	podStream := &PodLogStream{
		Pod:    pod,
		ctx:    podCtx,
		Cancel: cancel,
		Done:   make(chan struct{}),
	}
	l.pods[key] = podStream
	l.mu.Unlock()

	// 开始为这个 pod 流式读取
	go l.startPodLogStream(podStream)

	_ = wsutil.SendMessage(l.conn, "pod_added", fmt.Sprintf("{\"pod\":\"%s\",\"namespace\":\"%s\"}",
		pod.Name, pod.Namespace))
}

// RemovePod 从批量日志处理器移除一个 pod，并停止流式读取它的日志
func (l *BatchLogHandler) RemovePod(pod corev1.Pod) {
	key := fmt.Sprintf("%s/%s", pod.Namespace, pod.Name)

	l.mu.Lock()
	podStream, exists := l.pods[key]
	if !exists {
		l.mu.Unlock()
		return
	}
	delete(l.pods, key)
	cancel := podStream.Cancel
	l.mu.Unlock()

	if cancel != nil {
		cancel()
	}

	go func() {
		<-podStream.Done
		_ = wsutil.SendMessage(l.conn, "pod_removed", fmt.Sprintf("{\"pod\":\"%s\",\"namespace\":\"%s\"}",
			pod.Name, pod.Namespace))
	}()
}

func (l *BatchLogHandler) Stop() {
	l.mu.Lock()
	for _, podStream := range l.pods {
		if cancel := podStream.Cancel; cancel != nil {
			cancel()
		}
	}
	l.pods = make(map[string]*PodLogStream)
	l.mu.Unlock()
	l.cancel()
}

// writerFunc 把一个函数适配成 io.Writer，
// 这样我们可以在函数内部创建小 writer 并捕获局部状态。
type writerFunc func([]byte) (int, error)

func (wf writerFunc) Write(p []byte) (int, error) {
	return wf(p)
}
