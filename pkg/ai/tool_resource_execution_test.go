package ai

import (
	"context"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/kube"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestObjectToYAML(t *testing.T) {
	if got := objectToYAML(nil); got != "" {
		t.Fatalf("expected empty string for nil object, got %q", got)
	}

	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name": "example",
			},
		},
	}
	obj.SetManagedFields([]metav1.ManagedFieldsEntry{{Manager: "test"}})

	got := objectToYAML(obj)
	if strings.Contains(got, "managedFields") {
		t.Fatalf("expected managedFields to be removed, got %q", got)
	}
}

func TestRedactSensitiveResourceData(t *testing.T) {
	tests := []struct {
		name     string
		resource resourceInfo
	}{
		{name: "secret", resource: resourceInfo{Kind: "Secret"}},
		{name: "configmap", resource: resourceInfo{Kind: "ConfigMap"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			obj := &unstructured.Unstructured{
				Object: map[string]interface{}{
					"data": map[string]interface{}{
						"token": "abc",
					},
					"stringData": map[string]interface{}{
						"password": "secret",
					},
					"binaryData": map[string]interface{}{
						"blob": "YWJj",
					},
				},
			}

			redactSensitiveResourceData(tc.resource, obj)

			for _, key := range []string{"data", "stringData", "binaryData"} {
				raw := obj.Object[key].(map[string]interface{})
				for field, value := range raw {
					if value != "***" {
						t.Fatalf("expected %s.%s to be redacted, got %#v", key, field, value)
					}
				}
			}
		})
	}
}

func TestResourceSummaryDetails(t *testing.T) {
	tests := []struct {
		name string
		kind string
		item unstructured.Unstructured
		want []string
	}{
		{
			name: "pod",
			kind: "pod",
			item: unstructured.Unstructured{
				Object: map[string]interface{}{
					"status": map[string]interface{}{
						"phase": "Running",
						"containerStatuses": []interface{}{
							map[string]interface{}{"ready": true, "restartCount": float64(2)},
							map[string]interface{}{"ready": false, "restartCount": float64(1)},
						},
						"podIP": "10.0.0.1",
					},
					"spec": map[string]interface{}{
						"nodeName": "node-a",
					},
				},
			},
			want: []string{"phase=Running", "ready=1/2", "restarts=3", "podIP=10.0.0.1", "node=node-a"},
		},
		{
			name: "deployment",
			kind: "deployment",
			item: unstructured.Unstructured{
				Object: map[string]interface{}{
					"status": map[string]interface{}{
						"readyReplicas":     int64(2),
						"updatedReplicas":   int64(3),
						"availableReplicas": int64(1),
					},
					"spec": map[string]interface{}{
						"replicas": int64(4),
					},
				},
			},
			want: []string{"ready=2/4", "updated=3", "available=1"},
		},
		{
			name: "service",
			kind: "service",
			item: unstructured.Unstructured{
				Object: map[string]interface{}{
					"spec": map[string]interface{}{
						"type":      "ClusterIP",
						"clusterIP": "10.96.0.1",
					},
					"status": map[string]interface{}{
						"loadBalancer": map[string]interface{}{
							"ingress": []interface{}{
								map[string]interface{}{"hostname": "b.example.com"},
								map[string]interface{}{"ip": "1.2.3.4"},
							},
						},
					},
				},
			},
			want: []string{"type=ClusterIP", "clusterIP=10.96.0.1", "external=1.2.3.4,b.example.com"},
		},
		{
			name: "node",
			kind: "node",
			item: unstructured.Unstructured{
				Object: map[string]interface{}{
					"metadata": map[string]interface{}{
						"labels": map[string]interface{}{
							"node-role.kubernetes.io/control-plane": "",
							"node-role.kubernetes.io/":              "",
						},
					},
					"status": map[string]interface{}{
						"conditions": []interface{}{
							map[string]interface{}{"type": "Ready", "status": "True"},
						},
						"nodeInfo": map[string]interface{}{
							"kubeletVersion": "v1.30.1",
						},
					},
				},
			},
			want: []string{"ready=True", "kubelet=v1.30.1", "roles=control-plane,worker"},
		},
		{
			name: "namespace",
			kind: "namespace",
			item: unstructured.Unstructured{
				Object: map[string]interface{}{
					"status": map[string]interface{}{
						"phase": "Active",
					},
				},
			},
			want: []string{"phase=Active", "status=Active"},
		},
		{
			name: "job",
			kind: "job",
			item: unstructured.Unstructured{
				Object: map[string]interface{}{
					"status": map[string]interface{}{
						"active":    int64(1),
						"succeeded": int64(2),
						"failed":    int64(3),
					},
				},
			},
			want: []string{"active=1", "succeeded=2", "failed=3"},
		},
		{
			name: "pvc",
			kind: "pvc",
			item: unstructured.Unstructured{
				Object: map[string]interface{}{
					"status": map[string]interface{}{
						"phase": "Bound",
						"capacity": map[string]interface{}{
							"storage": "10Gi",
						},
					},
					"spec": map[string]interface{}{
						"storageClassName": "fast",
					},
				},
			},
			want: []string{"phase=Bound", "status=Bound", "storageClass=fast", "capacity=10Gi"},
		},
		{
			name: "labels fallback",
			kind: "unknown",
			item: unstructured.Unstructured{
				Object: map[string]interface{}{
					"metadata": map[string]interface{}{
						"labels": map[string]interface{}{
							"d": "4",
							"b": "2",
							"a": "1",
							"c": "3",
						},
					},
				},
			},
			want: []string{"labels=a=1,b=2,c=3"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resourceSummaryDetails(tc.kind, tc.item)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("unexpected details:\nwant: %#v\ngot:  %#v", tc.want, got)
			}
		})
	}
}

func TestAsInt64(t *testing.T) {
	tests := []struct {
		name   string
		value  interface{}
		want   int64
		wantOK bool
	}{
		{name: "int", value: int(4), want: 4, wantOK: true},
		{name: "float32", value: float32(2.5), want: 2, wantOK: true},
		{name: "uint64", value: uint64(7), want: 7, wantOK: true},
		{name: "overflow", value: uint64(math.MaxInt64) + 1, wantOK: false},
		{name: "unsupported", value: "nope", wantOK: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := asInt64(tc.value)
			if ok != tc.wantOK {
				t.Fatalf("unexpected ok: want %v, got %v", tc.wantOK, ok)
			}
			if ok && got != tc.want {
				t.Fatalf("unexpected value: want %d, got %d", tc.want, got)
			}
		})
	}
}

// describe_resource 不能把 Secret / ConfigMap 的明文送进模型上下文：kubectl 的
// describer 会打印 ConfigMap 的全部值，以及 service-account-token 类型 Secret 的
// token。这两类资源应改走已脱敏的对象视图。
func TestDescribeResourceRedactsSensitiveKinds(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("building scheme: %v", err)
	}
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "sa-token", Namespace: "default"},
		Type:       corev1.SecretTypeServiceAccountToken,
		Data:       map[string][]byte{"token": []byte("super-secret-token")},
	}
	fakeClient := fake.NewClientBuilder().WithScheme(scheme).WithObjects(secret).Build()
	// Configuration 指向一个不可达的地址：修复生效时根本不会构造 describer，
	// 一旦绕过脱敏分支就会在这里失败，而不是静默去打印明文。
	cs := &cluster.ClientSet{Name: "cluster-a", K8sClient: &kube.K8sClient{
		Client:        fakeClient,
		Configuration: &rest.Config{Host: "http://127.0.0.1:1"},
	}}

	got, isError := executeDescribeResource(context.Background(), cs, map[string]interface{}{
		"kind":      "Secret",
		"name":      "sa-token",
		"namespace": "default",
	})
	if isError {
		t.Fatalf("describe returned an error: %s", got)
	}
	if strings.Contains(got, "super-secret-token") {
		t.Fatalf("secret data leaked into the tool output: %q", got)
	}
	if !strings.Contains(got, "***") {
		t.Fatalf("expected a redacted manifest, got %q", got)
	}
}

// isSensitiveResourceKind 是脱敏与 describe 绕行的共同判定：大小写/空格不敏感。
func TestIsSensitiveResourceKind(t *testing.T) {
	for _, kind := range []string{"Secret", "secret", " ConfigMap ", "configmap"} {
		if !isSensitiveResourceKind(kind) {
			t.Errorf("isSensitiveResourceKind(%q) = false, want true", kind)
		}
	}
	for _, kind := range []string{"Deployment", "Pod", ""} {
		if isSensitiveResourceKind(kind) {
			t.Errorf("isSensitiveResourceKind(%q) = true, want false", kind)
		}
	}
}
