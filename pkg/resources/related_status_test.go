package resources

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/cluster"
	"github.com/gzwxh/aerolink/pkg/kube"
	"github.com/gzwxh/aerolink/pkg/model"
	appsv1 "k8s.io/api/apps/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// 回归（缺陷 D-147）：对象已经不在了的时候 /related 回 HTTP 500。
// 关联发现常在被删对象的残留意图上发起（列表刚刷新完、详情页还开着），
// 把「不在了」报成「服务坏了」会让前端重试、也让告警分不出真假。
// 写路径在 D-91 已按 apiserver 语义映射状态码，读路径这里是同一处漏网。
func TestGetRelatedResourcesReturnsNotFound(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// GetResource 靠包级注册表分发处理器，它只在 RegisterRoutes 里才被填；
	// 单测不跑路由，这里直接构造一份，测完还原。
	previous := handlers
	handlers = newResourceHandlers()
	t.Cleanup(func() { handlers = previous })

	scheme := runtime.NewScheme()
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatalf("adding appsv1 to scheme: %v", err)
	}
	// 夹具里没有任何 Deployment：Get 必然返回 NotFound
	k8sClient := fake.NewClientBuilder().WithScheme(scheme).Build()
	cs := &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{Client: k8sClient}}

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet,
		"/api/v1/deployments/default/gone/related", nil)
	ctx.Params = gin.Params{
		{Key: "namespace", Value: "default"},
		{Key: "name", Value: "gone"},
	}
	ctx.Set("cluster", cs)
	ctx.Set("user", model.User{Username: "alice"})
	ctx.Set("resource", "deployments")

	GetRelatedResources(ctx)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("缺失对象的 /related 返回 %d, want 404; body=%s",
			recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "resource_not_found") {
		t.Fatalf("响应应带机器可读码 resource_not_found, got %s", recorder.Body.String())
	}
}
