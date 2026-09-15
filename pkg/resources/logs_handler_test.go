package resources

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/wsutil"
)

func TestLogsWebSocketEnforcesRBACAndValidatesOptions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	clientSet := &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{}}
	handler := &LogsHandler{}
	router := gin.New()
	router.GET("/unauthorized/:namespace/:podName", func(c *gin.Context) {
		c.Set("cluster", clientSet)
		c.Set("user", model.User{Username: "alice"})
		handler.HandleLogsWebSocket(c)
	})
	router.GET("/authorized/:namespace/:podName", func(c *gin.Context) {
		c.Set("cluster", clientSet)
		c.Set("user", model.User{Username: "alice", Roles: []common.Role{{
			Name:       "log-reader",
			Clusters:   []string{"prod"},
			Namespaces: []string{"default"},
			Resources:  []string{"pods"},
			Verbs:      []string{"log"},
		}}})
		handler.HandleLogsWebSocket(c)
	})
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	tests := []struct {
		path        string
		wantMessage string
		// beforeUpgrade marks the cases the handler must refuse with an HTTP
		// status instead of establishing a session and sending an error frame.
		beforeUpgrade bool
	}{
		{"/unauthorized/default/web", "does not have permission to log pods", true},
		{"/authorized/default/web?tailLines=invalid", "invalid tailLines parameter", false},
		{"/authorized/default/web?sinceSeconds=invalid", "invalid sinceSeconds parameter", false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			url := "ws" + strings.TrimPrefix(server.URL, "http") + tt.path
			conn, response, err := websocket.DefaultDialer.Dial(url, nil)
			if response != nil {
				defer func() {
					_ = response.Body.Close()
				}()
			}
			if tt.beforeUpgrade {
				if conn != nil {
					_ = conn.Close()
					t.Fatal("unauthorized client must not get an established WebSocket session")
				}
				if err == nil || response == nil {
					t.Fatalf("dialing WebSocket: err=%v, response=%v; want an upgrade rejection", err, response)
				}
				if response.StatusCode != http.StatusForbidden {
					t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusForbidden)
				}
				body, readErr := io.ReadAll(response.Body)
				if readErr != nil {
					t.Fatalf("reading rejection body: %v", readErr)
				}
				if !strings.Contains(string(body), tt.wantMessage) {
					t.Fatalf("rejection body = %q, want it to contain %q", body, tt.wantMessage)
				}
				return
			}
			if err != nil {
				t.Fatalf("dialing WebSocket: %v", err)
			}
			defer func() {
				_ = conn.Close()
			}()
			var message wsutil.Message
			if err := conn.ReadJSON(&message); err != nil {
				t.Fatalf("reading error message: %v", err)
			}
			if message.Type != "error" || !strings.Contains(message.Data, tt.wantMessage) {
				t.Fatalf("message = %#v", message)
			}
		})
	}
}
