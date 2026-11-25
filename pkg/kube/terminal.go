package kube

import (
	"context"
	"fmt"
	"log"
	"sync"

	"aerolink/pkg/common"
	"aerolink/pkg/wsutil"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/klog/v2"
)

const EndOfTransmission = "\u0004"

// TerminalMessage 表示通过 WebSocket 发送的消息
type TerminalMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Rows uint16 `json:"rows,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
}

// TerminalSession 管理用于终端通信的 WebSocket 连接
type TerminalSession struct {
	k8sClient *K8sClient
	conn      *wsutil.Conn
	sizeChan  chan *remotecommand.TerminalSize
	namespace string
	podName   string
	container string
	cancel    context.CancelFunc

	// mu 同时保护 closed 与 sizeChan 的发送：exec 结束后 Close 会关闭
	// sizeChan，而读 WebSocket 的 goroutine 可能仍在处理 resize，
	// 向已关闭的 channel 发送会 panic（select + default 也挡不住）。
	mu     sync.Mutex
	closed bool
	// pending 保存一条 stdin 消息里没被 copy 走的部分：io.Copy 的缓冲比
	// 一次粘贴小得多，多余字节必须留到下一次 Read，不能丢。
	pending []byte
}

func NewTerminalSession(client *K8sClient, conn *wsutil.Conn, namespace, podName, container string) *TerminalSession {
	return &TerminalSession{
		k8sClient: client,
		conn:      conn,
		sizeChan:  make(chan *remotecommand.TerminalSize, 10),
		namespace: namespace,
		podName:   podName,
		container: container,
	}
}

func (session *TerminalSession) Start(ctx context.Context, subResource string) error {
	attach := subResource == "attach"
	if attach {
		ctx, session.cancel = context.WithCancel(ctx)
		defer session.cancel()
	}
	req := session.k8sClient.ClientSet.CoreV1().RESTClient().Post().
		Resource(string(common.Pods)).
		Name(session.podName).
		Namespace(session.namespace).
		SubResource(subResource)

	if attach {
		req.VersionedParams(&corev1.PodAttachOptions{
			Container: session.container,
			Stdin:     true,
			Stdout:    true,
			TTY:       true,
		}, scheme.ParameterCodec)
	} else {
		req.VersionedParams(&corev1.PodExecOptions{
			Container: session.container,
			Command:   []string{"sh", "-c", "bash || sh"},
			Stdin:     true,
			Stdout:    true,
			TTY:       true,
		}, scheme.ParameterCodec)
	}
	// 注意：TTY 模式下不带 stderr=true —— stderr 由 stdout 流复用，
	// 同时声明会被服务端以 "cannot exec with tty and stderr" 拒绝。

	exec, err := newRemoteCommandExecutor(session.k8sClient.Configuration, req.URL())
	if err != nil {
		log.Printf("Failed to create executor: %v", err)
		session.SendErrorMessage(fmt.Sprintf("Failed to create executor: %v", err))
		return err
	}

	// 发送初始的连接成功消息
	session.SendMessage("connected", "Terminal connected successfully")

	// 启动 exec 会话
	err = exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:             session,
		Stdout:            session,
		Stderr:            session,
		Tty:               true,
		TerminalSizeQueue: session,
	})

	if err != nil {
		session.SendErrorMessage(err.Error())
		return err
	}

	return nil
}

func (session *TerminalSession) Close() {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return
	}
	session.closed = true
	close(session.sizeChan)
}

func (session *TerminalSession) Read(p []byte) (int, error) {
	// 先把上一条消息没读完的字节交给调用方，再读新的 WebSocket 消息。
	session.mu.Lock()
	if len(session.pending) > 0 {
		n := copy(p, session.pending)
		session.pending = session.pending[n:]
		session.mu.Unlock()
		return n, nil
	}
	session.mu.Unlock()

	var msg TerminalMessage
	err := session.conn.ReadJSON(&msg)
	if err != nil {
		if session.cancel != nil {
			session.cancel()
			return 0, err
		}
		return copy(p, EndOfTransmission), err
	}

	switch msg.Type {
	case "stdin":
		data := []byte(msg.Data)
		n := copy(p, data)
		if n < len(data) {
			session.mu.Lock()
			session.pending = append(session.pending, data[n:]...)
			session.mu.Unlock()
		}
		return n, nil
	case "resize":
		if msg.Rows > 0 && msg.Cols > 0 {
			session.enqueueSize(&remotecommand.TerminalSize{
				Width:  msg.Cols,
				Height: msg.Rows,
			})
		}
	default:
		return copy(p, EndOfTransmission), fmt.Errorf("unknown message type: %s", msg.Type)
	}
	return 0, nil
}

func (session *TerminalSession) Write(p []byte) (int, error) {
	err := wsutil.SendMessage(session.conn, "stdout", string(p))
	if err != nil {
		log.Printf("Write stdout error: %v", err)
		return 0, err
	}
	return len(p), nil
}

// enqueueSize 投递一次窗口尺寸变化；会话已关闭时直接丢弃，
// 避免向已关闭的 sizeChan 发送而 panic。
func (session *TerminalSession) enqueueSize(size *remotecommand.TerminalSize) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return
	}
	select {
	case session.sizeChan <- size:
	default:
	}
}

func (session *TerminalSession) Next() *remotecommand.TerminalSize {
	return <-session.sizeChan
}

func (session *TerminalSession) SendMessage(msgType, data string) {
	if err := wsutil.SendMessage(session.conn, msgType, data); err != nil {
		klog.Errorf("Send message error: %v", err)
	}
}

func (session *TerminalSession) SendErrorMessage(errMsg string) {
	wsutil.SendErrorMessage(session.conn, errMsg)
}
