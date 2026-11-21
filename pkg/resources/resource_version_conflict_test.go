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
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

// applyConflictTestClient 建一个只有一个 Pod 的假客户端，并记下每次 Update
// 实际带上的 resourceVersion：与库里当前 RV 不一致就按 K8s 的语义回冲突。
// 假客户端会在成功更新后递增 RV，所以当前 RV 要跟着回写的对象走，不能写死。
func applyConflictTestClient(t *testing.T, sent *string) client.Client {
	t.Helper()

	podGVK := schema.GroupVersion{Version: "v1"}.WithKind("Pod")
	podGVR := schema.GroupVersion{Version: "v1"}.WithResource("pods")
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Version: "v1"}})
	mapper.AddSpecific(podGVK, podGVR, schema.GroupVersion{Version: "v1"}.WithResource("pod"), meta.RESTScopeNamespace)

	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(podGVK, &unstructured.Unstructured{})

	live := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Pod",
		"metadata": map[string]any{
			"name":            "app",
			"namespace":       "default",
			"resourceVersion": "9",
			"labels":          map[string]any{"stage": "base"},
		},
		"spec": map[string]any{"containers": []any{
			map[string]any{"name": "main", "image": "nginx"},
		}},
	}}

	currentResourceVersion := "9"
	return fake.NewClientBuilder().WithScheme(scheme).WithRESTMapper(mapper).WithObjects(live).
		WithInterceptorFuncs(interceptor.Funcs{
			Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
				target, ok := obj.(*unstructured.Unstructured)
				if !ok {
					return c.Update(ctx, obj, opts...)
				}
				*sent = target.GetResourceVersion()
				if *sent != currentResourceVersion {
					return apierrors.NewConflict(podGVR.GroupResource(), "app",
						errors.New("the object has been modified; please apply your changes to the latest version and try again"))
				}
				if err := c.Update(ctx, obj, opts...); err != nil {
					return err
				}
				currentResourceVersion = obj.GetResourceVersion()
				return nil
			},
		}).Build()
}

// 回归（缺陷 D-28）：apply 不能把 YAML 里的 resourceVersion 换成服务端当前值。
// 以前无条件覆盖，两个人各自打开 YAML 再提交时后提交者静默获胜，K8s 根本没机会
// 报冲突；现在带 RV 的提交要按 RV 走，冲突回 409，不带 RV 的仍按 live 值补齐。
func TestApplyResourceHonorsSubmittedResourceVersion(t *testing.T) {
	lastUpdatesTestDB(t)
	gin.SetMode(gin.TestMode)

	var sentResourceVersion string
	k8sClient := applyConflictTestClient(t, &sentResourceVersion)
	clientSet := &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{Client: k8sClient}}

	user := model.User{Username: "alice", Roles: []common.Role{{
		Name:       "pod-updater",
		Clusters:   []string{"prod"},
		Namespaces: []string{"default"},
		Resources:  []string{"pods"},
		Verbs:      []string{string(common.VerbUpdate)},
	}}}

	perform := func(manifest string) *httptest.ResponseRecorder {
		body, err := json.Marshal(ApplyResourceRequest{YAML: manifest})
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		router := gin.New()
		router.POST("/apply", func(c *gin.Context) {
			c.Set("cluster", clientSet)
			c.Set("user", user)
			NewResourceApplyHandler().ApplyResource(c)
		})
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/apply", strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, request)
		return recorder
	}

	staleManifest := `apiVersion: v1
kind: Pod
metadata:
  name: app
  namespace: default
  resourceVersion: "6"
  labels:
    stage: stale
spec:
  containers:
  - name: main
    image: nginx
`
	response := perform(staleManifest)
	if response.Code != http.StatusConflict {
		t.Fatalf("stale apply returned %d, want %d; body=%s",
			response.Code, http.StatusConflict, response.Body.String())
	}
	if sentResourceVersion != "6" {
		t.Fatalf("stale apply submitted resourceVersion %q, want the client's 6", sentResourceVersion)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode conflict body: %v", err)
	}
	if payload["code"] != resourceVersionConflictCode {
		t.Fatalf("conflict response has no machine readable code: %v", payload)
	}

	// 拿最新 RV 提交要能正常落地，证明 409 不是把更新路径整个挡死了。
	freshManifest := strings.Replace(staleManifest, `resourceVersion: "6"`, `resourceVersion: "9"`, 1)
	if response = perform(freshManifest); response.Code != http.StatusOK {
		t.Fatalf("fresh apply returned %d, want %d; body=%s",
			response.Code, http.StatusOK, response.Body.String())
	}

	// 不带 RV（等价于 kubectl apply 一份新 manifest）仍按 live 值补齐，行为不变。
	// live 值已经被上面那次成功更新递增过，所以这里要先读再比，不能写死。
	sentResourceVersion = ""
	liveObject := &unstructured.Unstructured{}
	liveObject.SetGroupVersionKind(schema.GroupVersion{Version: "v1"}.WithKind("Pod"))
	if err := k8sClient.Get(context.Background(), client.ObjectKey{Name: "app", Namespace: "default"}, liveObject); err != nil {
		t.Fatalf("read live pod before no-RV apply: %v", err)
	}
	wantResourceVersion := liveObject.GetResourceVersion()
	noRvManifest := `apiVersion: v1
kind: Pod
metadata:
  name: app
  namespace: default
  labels:
    stage: norv
spec:
  containers:
  - name: main
    image: nginx
`
	if response = perform(noRvManifest); response.Code != http.StatusOK {
		t.Fatalf("apply without resourceVersion returned %d, want %d; body=%s",
			response.Code, http.StatusOK, response.Body.String())
	}
	if sentResourceVersion != wantResourceVersion {
		t.Fatalf("apply without resourceVersion submitted %q, want the live %q", sentResourceVersion, wantResourceVersion)
	}

	object := &unstructured.Unstructured{}
	object.SetGroupVersionKind(schema.GroupVersion{Version: "v1"}.WithKind("Pod"))
	if err := k8sClient.Get(context.Background(), client.ObjectKey{Name: "app", Namespace: "default"}, object); err != nil {
		t.Fatalf("get pod after apply: %v", err)
	}
	if labels := object.GetLabels(); labels["stage"] != "norv" {
		t.Fatalf("labels after apply = %#v, want stage=norv", labels)
	}
}

// 回归（缺陷 D-29）：结构化编辑走 PUT，K8s 冲突不能再用一句英文原文冒充 500。
func TestGenericUpdateReturnsConflictStatus(t *testing.T) {
	lastUpdatesTestDB(t)
	gin.SetMode(gin.TestMode)

	var sentResourceVersion string
	direct := fake.NewClientBuilder().WithObjects(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "cm", Namespace: "default", ResourceVersion: "9"},
	}).WithInterceptorFuncs(interceptor.Funcs{
		Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
			sentResourceVersion = obj.GetResourceVersion()
			return apierrors.NewConflict(schema.GroupResource{Resource: "configmaps"}, "cm",
				errors.New("the object has been modified; please apply your changes to the latest version and try again"))
		},
	}).Build()

	cs := &cluster.ClientSet{Name: "cluster-a", K8sClient: &kube.K8sClient{Client: direct}}
	handler := newConfigMapHandler()

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPut, "/api/v1/configmaps/default/cm",
		strings.NewReader(`{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"cm","namespace":"default","resourceVersion":"6"}}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	ctx.Params = gin.Params{{Key: "namespace", Value: "default"}, {Key: "name", Value: "cm"}}
	ctx.Set("cluster", cs)
	ctx.Set("user", model.User{Username: "alice"})

	handler.Update(ctx)

	if recorder.Code != http.StatusConflict {
		t.Fatalf("conflicting update returned %d, want %d; body=%s",
			recorder.Code, http.StatusConflict, recorder.Body.String())
	}
	if sentResourceVersion != "6" {
		t.Fatalf("update submitted resourceVersion %q, want the client's 6", sentResourceVersion)
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode conflict body: %v", err)
	}
	if payload["code"] != resourceVersionConflictCode {
		t.Fatalf("conflict response has no machine readable code: %v", payload)
	}
}
