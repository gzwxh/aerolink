package notification

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
)

func postBatchSubscriptions(t *testing.T, router *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/admin/notification-subscriptions/batch", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func decodeBatchResponse(t *testing.T, recorder *httptest.ResponseRecorder) (created []model.NotificationSubscription, skipped []string) {
	t.Helper()
	var payload struct {
		Created []model.NotificationSubscription `json:"created"`
		Skipped []string                         `json:"skipped"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decoding the response %q: %v", recorder.Body.String(), err)
	}
	return payload.Created, payload.Skipped
}

// 「全选」：一次为多个事件建同一套接收者。
func TestBatchCreateSubscriptionsSelectsAllEvents(t *testing.T) {
	newNotificationTestDB(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/admin/notification-subscriptions/batch", HandleCreateNotificationSubscriptions)

	body := `{"events":["remote_login","password_expired","role_assigned"],"channel":"inapp","receiverType":"all_users"}`
	recorder := postBatchSubscriptions(t, router, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
	created, skipped := decodeBatchResponse(t, recorder)
	if len(created) != 3 || len(skipped) != 0 {
		t.Fatalf("created = %d, skipped = %d, want 3/0", len(created), len(skipped))
	}

	var stored int64
	if err := model.DB.Model(&model.NotificationSubscription{}).Count(&stored).Error; err != nil {
		t.Fatalf("counting subscriptions: %v", err)
	}
	if stored != 3 {
		t.Fatalf("stored subscriptions = %d, want 3", stored)
	}

	// 再点一次「全选」：不产生重复行，全部报成跳过。
	recorder = postBatchSubscriptions(t, router, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("second status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
	created, skipped = decodeBatchResponse(t, recorder)
	if len(created) != 0 || len(skipped) != 3 {
		t.Fatalf("second call created = %d, skipped = %d, want 0/3", len(created), len(skipped))
	}
	if err := model.DB.Model(&model.NotificationSubscription{}).Count(&stored).Error; err != nil {
		t.Fatalf("counting subscriptions: %v", err)
	}
	if stored != 3 {
		t.Fatalf("duplicated rows after the second select-all: %d, want 3", stored)
	}
}

// 批量接口复用单条的校验：非法接收人整批不写，并指出是哪个事件。
func TestBatchCreateSubscriptionsRejectsInvalidReceiver(t *testing.T) {
	newNotificationTestDB(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/admin/notification-subscriptions/batch", HandleCreateNotificationSubscriptions)

	body := `{"events":["remote_login","password_expired"],"channel":"inapp","receiverType":"user","receiver":"no-such-user"}`
	recorder := postBatchSubscriptions(t, router, body)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "remote_login") {
		t.Fatalf("error message should name the failing event: %s", recorder.Body.String())
	}

	var stored int64
	if err := model.DB.Model(&model.NotificationSubscription{}).Count(&stored).Error; err != nil {
		t.Fatalf("counting subscriptions: %v", err)
	}
	if stored != 0 {
		t.Fatalf("a rejected batch wrote %d subscriptions, want 0", stored)
	}
}

// 空事件列表与超量都要挡掉。
func TestBatchCreateSubscriptionsValidatesEvents(t *testing.T) {
	newNotificationTestDB(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/admin/notification-subscriptions/batch", HandleCreateNotificationSubscriptions)

	if recorder := postBatchSubscriptions(t, router, `{"events":[],"channel":"inapp","receiverType":"all_users"}`); recorder.Code != http.StatusBadRequest {
		t.Fatalf("empty events status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}

	events := make([]string, 0, maxBatchSubscriptionEvents+1)
	for i := 0; i <= maxBatchSubscriptionEvents; i++ {
		events = append(events, `"remote_login"`)
	}
	tooMany := `{"events":[` + strings.Join(events, ",") + `],"channel":"inapp","receiverType":"all_users"}`
	if recorder := postBatchSubscriptions(t, router, tooMany); recorder.Code != http.StatusBadRequest {
		t.Fatalf("too many events status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

// 订阅列表接口要一并下发「必收」清单，界面据此上锁。
func TestListSubscriptionsReturnsMandatoryEvents(t *testing.T) {
	newNotificationTestDB(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/admin/notification-subscriptions/", HandleListNotificationSubscriptions)

	request := httptest.NewRequest(http.MethodGet, "/admin/notification-subscriptions/", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var payload struct {
		Subscriptions   []model.NotificationSubscription `json:"subscriptions"`
		MandatoryEvents []string                         `json:"mandatoryEvents"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decoding the response: %v", err)
	}
	if len(payload.MandatoryEvents) == 0 {
		t.Fatal("mandatoryEvents is empty: the UI would render every event as optional")
	}
	if !model.NotificationEventMandatoryForAdmins(payload.MandatoryEvents[0]) {
		t.Fatalf("unexpected mandatory event %q", payload.MandatoryEvents[0])
	}
}
