package resources

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
)

// 资源级变更历史只在审计记录落库时可用：sink≠database 时必须**明确拒绝**并给出可本地化的
// code，而不是返回空列表让人以为"这个资源从没被改过"（见 docs/dev/plans/2026-09-20-审计日志parquet归档.md §12.13）。
//
// 这里不需要集群与数据库：判定发生在 handler 的最前面，早于任何取用。
func TestListHistoryRequiresDatabaseSink(t *testing.T) {
	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })
	gin.SetMode(gin.TestMode)

	handler := NewGenericResourceHandler[*corev1.Pod, *corev1.PodList](common.Pods)

	for _, sink := range []string{model.AuditSinkParquet, model.AuditSinkElasticsearch} {
		t.Run(sink, func(t *testing.T) {
			model.AuditSink = sink

			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/pods/default/web/history", nil)

			handler.ListHistory(c)
			if recorder.Code != http.StatusNotImplemented {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotImplemented)
			}

			var body struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("decoding response: %v (body=%s)", err, recorder.Body.String())
			}
			if body.Code != resourceHistoryUnsupportedCode {
				t.Errorf("code = %q, want %q", body.Code, resourceHistoryUnsupportedCode)
			}
		})
	}
}
