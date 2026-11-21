package resources

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

// invalidFieldError 造一条 apiserver 的「字段非法」错误：真实场景里
// `field is immutable`、PDB 的 minAvailable 非法百分比都是这一类。
func invalidFieldError(kind, name, path, detail string) error {
	gk := schema.GroupKind{Kind: kind}
	return apierrors.NewInvalid(gk, name, field.ErrorList{
		field.Invalid(field.NewPath(path), "", detail),
	})
}

// 回归（缺陷 D-91）：写失败此前一律 500，apiserver 明确给出的
// 「字段非法 / 不可变 / 已不存在 / 没有权限」全被说成服务端故障，
// 调用方无法区分「重试可能有用」和「重试永远没用」。
func TestWriteFailureMapsAPIErrorSemantics(t *testing.T) {
	configMapResource := schema.GroupResource{Resource: "configmaps"}

	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "乐观并发冲突",
			err:        apierrors.NewConflict(configMapResource, "cm", errors.New("stale")),
			wantStatus: http.StatusConflict,
			wantCode:   resourceVersionConflictCode,
		},
		{
			name:       "字段非法",
			err:        invalidFieldError("PodDisruptionBudget", "pdb", "spec.minAvailable", "must be a numeric string"),
			wantStatus: http.StatusUnprocessableEntity,
		},
		{
			name:       "对象已不存在",
			err:        apierrors.NewNotFound(configMapResource, "cm"),
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "apiserver 拒绝该操作",
			err:        apierrors.NewForbidden(configMapResource, "cm", errors.New("field is immutable")),
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "请求本身不合法",
			err:        apierrors.NewBadRequest("invalid body"),
			wantStatus: http.StatusBadRequest,
		},
		{
			// 未知错误必须仍然是 500：不能把真故障伪装成客户端错误。
			name:       "未知错误保持 500",
			err:        errors.New("admission webhook denied the request"),
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, code := writeFailure(tc.err)
			if status != tc.wantStatus {
				t.Errorf("status = %d, want %d", status, tc.wantStatus)
			}
			if code != tc.wantCode {
				t.Errorf("code = %q, want %q", code, tc.wantCode)
			}
		})
	}
}

// apply 的两条辅助函数必须与 writeFailure 同源，别再各写一套判据。
func TestApplyErrorHelpersReuseWriteFailure(t *testing.T) {
	invalid := invalidFieldError("Deployment", "web", "spec.template", "field is immutable")
	if got, want := applyErrorStatus(invalid), http.StatusUnprocessableEntity; got != want {
		t.Fatalf("applyErrorStatus(invalid) = %d, want %d", got, want)
	}
	if got := applyErrorCode(invalid); got != "" {
		t.Fatalf("applyErrorCode(invalid) = %q, want empty", got)
	}

	conflict := apierrors.NewConflict(
		schema.GroupResource{Resource: "deployments"}, "web", errors.New("stale"))
	if got := applyErrorStatus(conflict); got != http.StatusConflict {
		t.Fatalf("applyErrorStatus(conflict) = %d, want 409", got)
	}
	if got := applyErrorCode(conflict); got != resourceVersionConflictCode {
		t.Fatalf("applyErrorCode(conflict) = %q, want %q", got, resourceVersionConflictCode)
	}
}

// 端到端一层：类型化 PUT 遇到 apiserver 的「非法值」要回 422，不再是 500。
func TestGenericUpdateReportsInvalidAsUnprocessable(t *testing.T) {
	lastUpdatesTestDB(t)
	gin.SetMode(gin.TestMode)

	direct := fake.NewClientBuilder().WithObjects(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "cm", Namespace: "default", ResourceVersion: "9"},
	}).WithInterceptorFuncs(interceptor.Funcs{
		Update: func(_ context.Context, _ client.WithWatch, _ client.Object, _ ...client.UpdateOption) error {
			return invalidFieldError("ConfigMap", "cm", "data.key", "Invalid value")
		},
	}).Build()

	cs := &cluster.ClientSet{Name: "cluster-a", K8sClient: &kube.K8sClient{Client: direct}}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPut, "/api/v1/configmaps/default/cm",
		strings.NewReader(`{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"cm","namespace":"default"}}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	ctx.Params = gin.Params{{Key: "namespace", Value: "default"}, {Key: "name", Value: "cm"}}
	ctx.Set("cluster", cs)
	ctx.Set("user", model.User{Username: "alice"})

	newConfigMapHandler().Update(ctx)

	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid update returned %d, want %d; body=%s",
			recorder.Code, http.StatusUnprocessableEntity, recorder.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	// 原文照给：K8s 的校验消息本地化不了，运维需要的正是这句话。
	if message, _ := payload["error"].(string); !strings.Contains(message, "Invalid value") {
		t.Fatalf("apiserver message lost: %v", payload)
	}
	// 非冲突错误不该带 code，免得前端把它当成「刷新一下就好」。
	if _, ok := payload["code"]; ok {
		t.Fatalf("unexpected machine readable code for an invalid error: %v", payload)
	}
}
