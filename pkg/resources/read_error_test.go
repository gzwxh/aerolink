package resources

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// 回归（验收台账 D-114）：集群里没装某个 API 类型时，列表接口原本回 HTTP 500 +
// 一句英文 `no matches for kind "X" in version "Y"`。前端只能靠正则匹配这句话
// 才降级成「资源类型不可用」，而 500 在监控与用户眼里都是「平台坏了」。

func TestReadFailureMapsNoMatchToNotFound(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "kind 在该版本不存在",
			err:        &meta.NoKindMatchError{GroupKind: schema.GroupKind{Group: "certificates.k8s.io", Kind: "ClusterTrustBundle"}, SearchedVersions: []string{"v1alpha1"}},
			wantStatus: http.StatusNotFound,
			wantCode:   resourceTypeUnavailableCode,
		},
		{
			name:       "资源本身没有映射",
			err:        &meta.NoResourceMatchError{PartialResource: schema.GroupVersionResource{Resource: "podgroups"}},
			wantStatus: http.StatusNotFound,
			wantCode:   resourceTypeUnavailableCode,
		},
		{
			name:       "包装过的 NoMatch 也要认",
			err:        errors.Join(errors.New("while listing"), &meta.NoKindMatchError{}),
			wantStatus: http.StatusNotFound,
			wantCode:   resourceTypeUnavailableCode,
		},
		{
			name:       "真正的服务端故障仍是 500",
			err:        errors.New("connection refused"),
			wantStatus: http.StatusInternalServerError,
			wantCode:   "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, code := readFailure(tc.err)
			if status != tc.wantStatus || code != tc.wantCode {
				t.Errorf("readFailure() = %d/%q, want %d/%q", status, code, tc.wantStatus, tc.wantCode)
			}
		})
	}
}

func TestRespondReadFailureKeepsMessageAndAddsCode(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// NoMatch：状态码改为 404，但**错误文本必须原样保留**——
	// 线上还有前端靠那句英文的正则做降级（utils.ts 的 CRD_NOT_INSTALLED_RE）。
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	respondReadFailure(ctx, &meta.NoKindMatchError{
		GroupKind:        schema.GroupKind{Group: "scheduling.k8s.io", Kind: "PodGroup"},
		SearchedVersions: []string{"v1alpha2"},
	})
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d, want 404; body=%s", recorder.Code, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v; body=%s", err, recorder.Body.String())
	}
	message, _ := payload["error"].(string)
	if want := `no matches for kind "PodGroup" in version "scheduling.k8s.io/v1alpha2"`; message != want {
		t.Errorf("错误文本被改写了: got %q want %q", message, want)
	}
	if payload["code"] != resourceTypeUnavailableCode {
		t.Errorf("缺少机器可读码: %v", payload)
	}

	// 其他故障：仍是 500，且不该凭空多出 code 字段。
	other := httptest.NewRecorder()
	otherCtx, _ := gin.CreateTestContext(other)
	respondReadFailure(otherCtx, errors.New("etcdserver: request timed out"))
	if other.Code != http.StatusInternalServerError {
		t.Errorf("状态码 = %d, want 500", other.Code)
	}
	var otherPayload map[string]any
	_ = json.Unmarshal(other.Body.Bytes(), &otherPayload)
	if _, ok := otherPayload["code"]; ok {
		t.Errorf("非 NoMatch 的失败不该带 code: %v", otherPayload)
	}
}
