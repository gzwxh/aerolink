package notification

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
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

// 删除订阅的审计详情必须带「事件 → 接收者」与快照：只留自增 ID 认不出删的是哪条订阅。
func TestDeleteNotificationSubscriptionRecordsAuditDetail(t *testing.T) {
	newNotificationTestDB(t)
	gin.SetMode(gin.TestMode)

	var detail common.AdminAuditDetail
	router := gin.New()
	router.POST("/admin/notification-subscriptions/", HandleCreateNotificationSubscription)
	router.DELETE("/admin/notification-subscriptions/:id", func(c *gin.Context) {
		HandleDeleteNotificationSubscription(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	body := `{"event":"remote_login","channel":"email","receiverType":"email","receiver":"ops@example.com"}`
	createRequest := httptest.NewRequest(http.MethodPost, "/admin/notification-subscriptions/", strings.NewReader(body))
	createRequest.Header.Set("Content-Type", "application/json")
	createRecorder := httptest.NewRecorder()
	router.ServeHTTP(createRecorder, createRequest)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want %d: %s", createRecorder.Code, http.StatusCreated, createRecorder.Body.String())
	}
	var created model.NotificationSubscription
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("decoding create response: %v", err)
	}

	deleteRecorder := httptest.NewRecorder()
	router.ServeHTTP(deleteRecorder, httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/admin/notification-subscriptions/%d", created.ID), nil))
	if deleteRecorder.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, want %d: %s", deleteRecorder.Code, http.StatusNoContent, deleteRecorder.Body.String())
	}
	if detail.ResourceName != "remote_login → ops@example.com" {
		t.Fatalf("audit resourceName = %q, want event -> receiver", detail.ResourceName)
	}
	if !strings.Contains(detail.PreviousYAML, "ops@example.com") {
		t.Fatalf("audit snapshot must describe the subscription, got %q", detail.PreviousYAML)
	}
}
