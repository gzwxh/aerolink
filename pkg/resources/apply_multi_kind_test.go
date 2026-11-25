package resources

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/kube"
	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

// 「创建资源」弹窗的空模板模式允许多文档 YAML：一份文件里可以同时有多个
// 不同类型的资源（如 Deployment + StatefulSet），且各自命名空间由 YAML 决定。
// 这里走真实的 ApplyResource 路由，确认两个对象都落地而不是只处理第一份。
func TestApplyResourceCreatesMultipleWorkloadKinds(t *testing.T) {
	lastUpdatesTestDB(t)
	gin.SetMode(gin.TestMode)

	appsV1 := schema.GroupVersion{Group: "apps", Version: "v1"}
	deploymentGVK := appsV1.WithKind("Deployment")
	deploymentGVR := appsV1.WithResource("deployments")
	statefulSetGVK := appsV1.WithKind("StatefulSet")
	statefulSetGVR := appsV1.WithResource("statefulsets")

	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{appsV1})
	mapper.AddSpecific(deploymentGVK, deploymentGVR, deploymentGVR, meta.RESTScopeNamespace)
	mapper.AddSpecific(statefulSetGVK, statefulSetGVR, statefulSetGVR, meta.RESTScopeNamespace)

	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(deploymentGVK, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(deploymentGVK.GroupVersion().WithKind("DeploymentList"), &unstructured.UnstructuredList{})
	scheme.AddKnownTypeWithName(statefulSetGVK, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(statefulSetGVK.GroupVersion().WithKind("StatefulSetList"), &unstructured.UnstructuredList{})

	// fake client 把多个 GVK 注册成同一个 *unstructured.Unstructured 类型时，
	// managedFields 跟踪会拿错 Kind；这里用拦截器记录 Create 调用本身，
	// 只验证 handler 把每份文档都按各自的 Kind/命名空间下发。
	type createdResource struct {
		Kind      string
		Name      string
		Namespace string
	}
	created := make([]createdResource, 0, 2)
	k8sClient := fake.NewClientBuilder().WithScheme(scheme).WithRESTMapper(mapper).
		WithInterceptorFuncs(interceptor.Funcs{
			Create: func(_ context.Context, _ client.WithWatch, obj client.Object, _ ...client.CreateOption) error {
				created = append(created, createdResource{
					Kind:      obj.GetObjectKind().GroupVersionKind().Kind,
					Name:      obj.GetName(),
					Namespace: obj.GetNamespace(),
				})
				return nil
			},
		}).Build()
	clientSet := &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{Client: k8sClient}}

	user := model.User{Username: "alice", Roles: []common.Role{{
		Name:       "workload-writer",
		Clusters:   []string{"prod"},
		Namespaces: []string{"team-a", "team-b"},
		Resources:  []string{"deployments", "statefulsets"},
		Verbs:      []string{string(common.VerbCreate), string(common.VerbUpdate)},
	}}}

	// 请求不带 namespace（空模板模式下界面不再传覆盖值），每个对象落到自己的命名空间。
	manifest := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: team-a
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.21
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
  namespace: team-b
spec:
  serviceName: db
  replicas: 1
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
      - name: postgres
        image: postgres:16
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

	if recorder.Code != http.StatusOK {
		t.Fatalf("apply returned %d, want %d; body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var payload struct {
		Count     int `json:"count"`
		Resources []struct {
			Kind      string `json:"kind"`
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"resources"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, recorder.Body.String())
	}
	if payload.Count != 2 || len(payload.Resources) != 2 {
		t.Fatalf("applied count = %d, resources = %#v; want 2", payload.Count, payload.Resources)
	}

	applied := map[string]struct {
		namespace string
	}{
		"Deployment/web": {namespace: "team-a"},
		"StatefulSet/db": {namespace: "team-b"},
	}
	for _, resource := range payload.Resources {
		want, ok := applied[resource.Kind+"/"+resource.Name]
		if !ok {
			t.Fatalf("unexpected applied resource: %#v", resource)
		}
		if resource.Namespace != want.namespace {
			t.Fatalf("%s namespace = %q, want %q", resource.Kind+"/"+resource.Name, resource.Namespace, want.namespace)
		}
	}

	// 两个不同类型的对象都必须真的下发：各在一份文档里，且各用自己的命名空间。
	want := map[string]string{
		"Deployment/web": "team-a",
		"StatefulSet/db": "team-b",
	}
	if len(created) != len(want) {
		t.Fatalf("create calls = %#v, want %d", created, len(want))
	}
	for _, resource := range created {
		key := resource.Kind + "/" + resource.Name
		if resource.Namespace != want[key] {
			t.Fatalf("create %s in namespace %q, want %q", key, resource.Namespace, want[key])
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Fatalf("missing create calls: %#v", want)
	}
}
