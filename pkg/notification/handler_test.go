package notification

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

// 管理员在「通知 → 订阅」里选「全体用户」时提交的就是这一份请求体：
// 不带 receiver / receiverId，服务端要接受它并落一条 receiver_type=all_users 的订阅。
func TestCreateSubscriptionAcceptsAllUsersReceiver(t *testing.T) {
	newNotificationTestDB(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/admin/notification-subscriptions/", HandleCreateNotificationSubscription)

	body := `{"event":"remote_login","channel":"inapp","receiverType":"all_users"}`
	request := httptest.NewRequest(http.MethodPost, "/admin/notification-subscriptions/", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}

	var created model.NotificationSubscription
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("decoding the response: %v", err)
	}
	if created.ReceiverType != model.NotificationReceiverAllUsers {
		t.Fatalf("receiverType = %q, want %q", created.ReceiverType, model.NotificationReceiverAllUsers)
	}
	if created.ReceiverID != 0 || created.Receiver != "" {
		t.Fatalf("all-users subscription kept a concrete receiver: id=%d receiver=%q", created.ReceiverID, created.Receiver)
	}

	// 未知的接收者类型仍然要被拒绝，别让新分支把校验整体短路掉。
	bad := `{"event":"remote_login","channel":"inapp","receiverType":"everyone"}`
	badRequest := httptest.NewRequest(http.MethodPost, "/admin/notification-subscriptions/", strings.NewReader(bad))
	badRequest.Header.Set("Content-Type", "application/json")
	badRecorder := httptest.NewRecorder()
	router.ServeHTTP(badRecorder, badRequest)
	if badRecorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown receiverType status = %d, want %d", badRecorder.Code, http.StatusBadRequest)
	}
}
