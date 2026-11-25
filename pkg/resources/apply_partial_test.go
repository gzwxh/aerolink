package resources

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/kube"
	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

// newApplyTestMapper 给单个 GVK 建一个命名空间作用域的 RESTMapper，
// 与生产代码里的映射结果一致（singular 这里用不到，同 plural 即可）。
func newApplyTestMapper(gvk schema.GroupVersionKind, gvr schema.GroupVersionResource) meta.RESTMapper {
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{gvk.GroupVersion()})
	mapper.AddSpecific(gvk, gvr, gvr, meta.RESTScopeNamespace)
	return mapper
}

// 回归（缺陷 D-12）：多文档 YAML 的 apply 没有跳对象事务，前面的文档不会因为
// 后面的失败而回滚。以前碰到第一个错误就直接返回，界面只看到一句失败，
// 不知道前面已经建好了哪些对象。现在要求：继续处理剩下的文档，并把
// 成功与失败两部分一起报出来。
func TestApplyResourceReportsPartialSuccess(t *testing.T) {
	lastUpdatesTestDB(t)
	gin.SetMode(gin.TestMode)

	configMapGVK := schema.GroupVersion{Version: "v1"}.WithKind("ConfigMap")
	configMapListGVK := schema.GroupVersion{Version: "v1"}.WithKind("ConfigMapList")
	mapper := newApplyTestMapper(configMapGVK, schema.GroupVersion{Version: "v1"}.WithResource("configmaps"))
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(configMapGVK, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(configMapListGVK, &unstructured.UnstructuredList{})
	k8sClient := fake.NewClientBuilder().WithScheme(scheme).WithRESTMapper(mapper).
		WithInterceptorFuncs(interceptor.Funcs{
			Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
				if obj.GetName() == "second" {
					return errors.New("admission webhook denied the request")
				}
				return c.Create(ctx, obj, opts...)
			},
		}).Build()
	clientSet := &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{Client: k8sClient}}

	user := model.User{Username: "alice", Roles: []common.Role{{
		Name:       "configmap-writer",
		Clusters:   []string{"prod"},
		Namespaces: []string{"default"},
		Resources:  []string{"configmaps"},
		Verbs:      []string{string(common.VerbCreate), string(common.VerbUpdate)},
	}}}

	manifest := `apiVersion: v1
kind: ConfigMap
metadata:
  name: first
  namespace: default
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: second
  namespace: default
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: third
  namespace: default
`
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

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("apply returned %d, want %d; body=%s", recorder.Code, http.StatusInternalServerError, recorder.Body.String())
	}

	var payload struct {
		Error  string `json:"error"`
		Params struct {
			Applied []struct {
				Name string `json:"name"`
			} `json:"applied"`
			Failed []struct {
				Name  string `json:"name"`
				Error string `json:"error"`
			} `json:"failed"`
			Partial bool `json:"partial"`
		} `json:"params"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, recorder.Body.String())
	}
	if !strings.Contains(payload.Error, "admission webhook") {
		t.Fatalf("error text lost: %q", payload.Error)
	}
	if !payload.Params.Partial || len(payload.Params.Applied) != 2 {
		t.Fatalf("applied list wrong: %#v", payload.Params)
	}
	if got := []string{payload.Params.Applied[0].Name, payload.Params.Applied[1].Name}; got[0] != "first" || got[1] != "third" {
		t.Fatalf("applied names = %v, want first and third", got)
	}
	if len(payload.Params.Failed) != 1 || payload.Params.Failed[0].Name != "second" {
		t.Fatalf("failed list = %#v, want only second", payload.Params.Failed)
	}

	// 第三份文档必须真的落地：证明失败之后没有提前中断。
	getObject := func(name string) error {
		object := &unstructured.Unstructured{}
		object.SetGroupVersionKind(configMapGVK)
		return k8sClient.Get(context.Background(), client.ObjectKey{Name: name, Namespace: "default"}, object)
	}
	if err := getObject("third"); err != nil {
		t.Fatalf("third configmap was not created after an earlier failure: %v", err)
	}
	if err := getObject("first"); err != nil {
		t.Fatalf("first configmap missing: %v", err)
	}
	if err := getObject("second"); !apierrors.IsNotFound(err) {
		t.Fatalf("second configmap exists although creation failed: %v", err)
	}
}

// 全部成功时响应形状保持原样，别让调用方因为这次修复而改判读逻辑。
func TestApplyResourceSuccessShapeUnchanged(t *testing.T) {
	lastUpdatesTestDB(t)
	gin.SetMode(gin.TestMode)

	configMapGVK := schema.GroupVersion{Version: "v1"}.WithKind("ConfigMap")
	mapper := newApplyTestMapper(configMapGVK, schema.GroupVersion{Version: "v1"}.WithResource("configmaps"))
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(configMapGVK, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(schema.GroupVersion{Version: "v1"}.WithKind("ConfigMapList"), &unstructured.UnstructuredList{})
	k8sClient := fake.NewClientBuilder().WithScheme(scheme).WithRESTMapper(mapper).Build()
	clientSet := &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{Client: k8sClient}}
	user := model.User{Username: "alice", Roles: []common.Role{{
		Name:      "configmap-writer",
		Clusters:  []string{"prod"},
		Resources: []string{"configmaps"},
		Verbs:     []string{string(common.VerbCreate)},
	}}}

	manifest := `apiVersion: v1
kind: ConfigMap
metadata:
  name: only
  namespace: default
`
	body, _ := json.Marshal(ApplyResourceRequest{YAML: manifest})
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

	if recorder.Code != http.StatusOK {
		t.Fatalf("apply returned %d, want %d; body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload["name"] != "only" || payload["message"] != "Resource applied successfully" {
		t.Fatalf("single-object success shape changed: %#v", payload)
	}
	if _, ok := payload["params"]; ok {
		t.Fatalf("success response should not carry failure params: %#v", payload)
	}
}
