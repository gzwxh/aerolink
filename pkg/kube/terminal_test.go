package kube

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aerolink/pkg/wsutil"
	"github.com/gorilla/websocket"
)

func TestTerminalSessionTransportsInputOutputAndResize(t *testing.T) {
	serverResults := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsutil.Serve(w, r, func(ws *wsutil.Session) {
			session := NewTerminalSession(nil, ws.Conn, "default", "web", "app")
			defer session.Close()

			buffer := make([]byte, 64)
			n, err := session.Read(buffer)
			if err != nil {
				serverResults <- fmt.Errorf("stdin read: %w", err)
				return
			}
			if string(buffer[:n]) != "echo hello\n" {
				serverResults <- fmt.Errorf("stdin read = %q", buffer[:n])
				return
			}
			if _, err := session.Write([]byte("hello\n")); err != nil {
				serverResults <- fmt.Errorf("stdout write: %w", err)
				return
			}
			n, err = session.Read(buffer)
			if err != nil {
				serverResults <- fmt.Errorf("resize read: %w", err)
				return
			}
			if n != 0 {
				serverResults <- fmt.Errorf("resize read = %d", n)
				return
			}
			size := session.Next()
			if size == nil || size.Width != 120 || size.Height != 40 {
				serverResults <- fmt.Errorf("terminal size = %#v", size)
				return
			}
			serverResults <- nil
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
	if err := conn.WriteJSON(TerminalMessage{Type: "stdin", Data: "echo hello\n"}); err != nil {
		t.Fatalf("writing stdin: %v", err)
	}
	var output wsutil.Message
	if err := conn.ReadJSON(&output); err != nil {
		t.Fatalf("reading stdout: %v", err)
	}
	if output.Type != "stdout" || output.Data != "hello\n" {
		t.Fatalf("stdout = %#v", output)
	}
	if err := conn.WriteJSON(TerminalMessage{Type: "resize", Rows: 40, Cols: 120}); err != nil {
		t.Fatalf("writing resize: %v", err)
	}
	if err := <-serverResults; err != nil {
		t.Fatal(err)
	}
}

func TestTerminalSessionRejectsUnknownMessageType(t *testing.T) {
	serverResults := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsutil.Serve(w, r, func(ws *wsutil.Session) {
			session := NewTerminalSession(nil, ws.Conn, "default", "web", "app")
			defer session.Close()
			buffer := make([]byte, 8)
			n, err := session.Read(buffer)
			if err == nil {
				serverResults <- fmt.Errorf("unknown message read = %q, want error", buffer[:n])
				return
			}
			if string(buffer[:n]) != EndOfTransmission {
				serverResults <- fmt.Errorf("unknown message read = %q: %w", buffer[:n], err)
				return
			}
			serverResults <- nil
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
	if err := conn.WriteJSON(TerminalMessage{Type: "unsupported"}); err != nil {
		t.Fatalf("writing unsupported message: %v", err)
	}
	if err := <-serverResults; err != nil {
		t.Fatal(err)
	}
}

// 一次粘贴可能远超 io.Copy 的缓冲：Read 必须把一条消息里没读完的字节留到后续调用，
// 而不是静默丢弃尾部。
func TestTerminalSessionDeliversLargeStdinAcrossReads(t *testing.T) {
	payload := strings.Repeat("A", 200)

	serverResults := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsutil.Serve(w, r, func(ws *wsutil.Session) {
			session := NewTerminalSession(nil, ws.Conn, "default", "web", "app")
			defer session.Close()

			// 故意用小缓冲模拟 io.Copy：一条消息需要多次 Read 才读完。
			var got []byte
			buffer := make([]byte, 64)
			for i := 0; i < 4 && len(got) < len(payload); i++ {
				n, err := session.Read(buffer)
				if err != nil {
					serverResults <- fmt.Errorf("stdin read: %w", err)
					return
				}
				if n == 0 {
					break
				}
				got = append(got, buffer[:n]...)
			}
			if string(got) != payload {
				serverResults <- fmt.Errorf("stdin = %d bytes %q, want %d bytes", len(got), got, len(payload))
				return
			}
			serverResults <- nil
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

	if err := conn.WriteJSON(TerminalMessage{Type: "stdin", Data: payload}); err != nil {
		t.Fatalf("writing large stdin: %v", err)
	}
	// 跟一条不产生 stdin 字节的消息：实现出错时 Read 不会一直阻塞（测试不会挂死）。
	if err := conn.WriteJSON(TerminalMessage{Type: "resize", Rows: 40, Cols: 120}); err != nil {
		t.Fatalf("writing resize: %v", err)
	}
	if err := <-serverResults; err != nil {
		t.Fatal(err)
	}
}

// Close 必须幂等；关闭之后到达的 resize 不能再向 sizeChan 发送——select + default
// 挡不住向已关闭 channel 的发送，那会 panic 掉整个进程。
func TestTerminalSessionCloseIsIdempotentAndDropsLateResize(t *testing.T) {
	serverResults := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsutil.Serve(w, r, func(ws *wsutil.Session) {
			session := NewTerminalSession(nil, ws.Conn, "default", "web", "app")
			session.Close()
			session.Close() // 幂等：重复关闭不得 panic

			buffer := make([]byte, 8)
			n, err := session.Read(buffer)
			if err != nil {
				serverResults <- fmt.Errorf("read after close: %w", err)
				return
			}
			if n != 0 {
				serverResults <- fmt.Errorf("read after close = %d bytes, want 0", n)
				return
			}
			if size := session.Next(); size != nil {
				serverResults <- fmt.Errorf("size after close = %#v, want nil", size)
				return
			}
			serverResults <- nil
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

	if err := conn.WriteJSON(TerminalMessage{Type: "resize", Rows: 40, Cols: 120}); err != nil {
		t.Fatalf("writing resize: %v", err)
	}
	if err := <-serverResults; err != nil {
		t.Fatal(err)
	}
}
