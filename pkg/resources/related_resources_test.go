package resources

import (
	"testing"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/kube"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	gatewayapiv1 "sigs.k8s.io/gateway-api/apis/v1"
)

func newRelatedResourceClientSet(t *testing.T) *cluster.ClientSet {
	t.Helper()

	ingressGV := schema.GroupVersion{Group: "networking.k8s.io", Version: "v1"}
	policyGV := schema.GroupVersion{Group: "example.com", Version: "v1"}
	gatewayGV := schema.GroupVersion{Group: gatewayapiv1.GroupVersion.Group, Version: gatewayapiv1.GroupVersion.Version}
	coreGV := corev1.SchemeGroupVersion

	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{ingressGV, policyGV, gatewayGV, coreGV})
	mapper.AddSpecific(ingressGV.WithKind("Ingress"),
		ingressGV.WithResource("ingresses"), ingressGV.WithResource("ingress"), meta.RESTScopeNamespace)
	mapper.AddSpecific(policyGV.WithKind("Policy"),
		policyGV.WithResource("policies"), policyGV.WithResource("policy"), meta.RESTScopeNamespace)
	mapper.AddSpecific(gatewayGV.WithKind("Gateway"),
		gatewayGV.WithResource("gateways"), gatewayGV.WithResource("gateway"), meta.RESTScopeNamespace)
	mapper.AddSpecific(gatewayGV.WithKind("HTTPRoute"),
		gatewayGV.WithResource("httproutes"), gatewayGV.WithResource("httproute"), meta.RESTScopeNamespace)
	mapper.AddSpecific(coreGV.WithKind("Service"),
		coreGV.WithResource("services"), coreGV.WithResource("service"), meta.RESTScopeNamespace)

	k8sClient := fake.NewClientBuilder().
		WithScheme(runtime.NewScheme()).
		WithRESTMapper(mapper).
		Build()
	return &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{Client: k8sClient}}
}

// 资源类型必须来自 RESTMapper：此前统一用 kind + "s"，Ingress、自定义资源、Gateway API
// 的类型会算成 "ingresss"、"policys"，前端据此拼出来的链接指向不存在的资源。
func TestResourceTypeForKindUsesRESTMapper(t *testing.T) {
	cs := newRelatedResourceClientSet(t)

	cases := []struct {
		name       string
		cs         *cluster.ClientSet
		kind       string
		apiVersion string
		want       string
	}{
		{"Ingress", cs, "Ingress", "networking.k8s.io/v1", "ingresses"},
		{"自定义资源", cs, "Policy", "example.com/v1", "policies"},
		{"core 组", cs, "Service", "v1", "services"},
		{"未注册的类型退回旧写法", cs, "Deployment", "apps/v1", "deployments"},
		{"缺少 apiVersion 退回旧写法", cs, "Ingress", "", "ingresss"},
		{"缺少 kind 退回旧写法", cs, "", "networking.k8s.io/v1", "s"},
		{"没有集群客户端退回旧写法", nil, "Ingress", "networking.k8s.io/v1", "ingresss"},
		{"客户端未初始化退回旧写法", &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{}},
			"Ingress", "networking.k8s.io/v1", "ingresss"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resourceTypeForKind(tc.cs, tc.kind, tc.apiVersion); got != tc.want {
				t.Fatalf("resourceTypeForKind(%q, %q) = %q, want %q", tc.kind, tc.apiVersion, got, tc.want)
			}
		})
	}
}

// HTTPRoute 的 parentRef/backendRef 同样要走 RESTMapper：Service 之外的 kind
// （Ingress、自定义后端）在旧写法下类型是错的。
func TestGetHTTPRouteRelatedResourcesResolvesTypes(t *testing.T) {
	cs := newRelatedResourceClientSet(t)

	gatewayGroup := gatewayapiv1.Group(gatewayapiv1.GroupVersion.Group)
	routeKind := gatewayapiv1.Kind("HTTPRoute")
	ingressGroup := gatewayapiv1.Group("networking.k8s.io")
	ingressKind := gatewayapiv1.Kind("Ingress")

	res := &gatewayapiv1.HTTPRoute{Spec: gatewayapiv1.HTTPRouteSpec{
		CommonRouteSpec: gatewayapiv1.CommonRouteSpec{
			ParentRefs: []gatewayapiv1.ParentReference{{
				Group: &gatewayGroup,
				Kind:  &routeKind,
				Name:  "parent-route",
			}},
		},
		Rules: []gatewayapiv1.HTTPRouteRule{{
			BackendRefs: []gatewayapiv1.HTTPBackendRef{{
				BackendRef: gatewayapiv1.BackendRef{
					BackendObjectReference: gatewayapiv1.BackendObjectReference{
						Group: &ingressGroup,
						Kind:  &ingressKind,
						Name:  "web-ingress",
					},
				},
			}},
		}},
	}}

	want := map[string]string{
		"parent-route": "httproutes",
		"web-ingress":  "ingresses",
	}
	got := make(map[string]string)
	for _, item := range getHTTPRouteRelatedResouces(cs, res, "default") {
		got[item.Name] = item.Type
	}
	for name, wantType := range want {
		if got[name] != wantType {
			t.Errorf("related type for %s = %q, want %q (all: %#v)", name, got[name], wantType, got)
		}
	}
}

// 不写 kind 时的默认值保持不变：parentRef 默认 Gateway、backendRef 默认 Service（core 组）。
func TestGetHTTPRouteRelatedResourcesKeepsKindDefaults(t *testing.T) {
	cs := newRelatedResourceClientSet(t)

	res := &gatewayapiv1.HTTPRoute{Spec: gatewayapiv1.HTTPRouteSpec{
		CommonRouteSpec: gatewayapiv1.CommonRouteSpec{
			ParentRefs: []gatewayapiv1.ParentReference{{Name: "default-gateway"}},
		},
		Rules: []gatewayapiv1.HTTPRouteRule{{
			BackendRefs: []gatewayapiv1.HTTPBackendRef{{
				BackendRef: gatewayapiv1.BackendRef{
					BackendObjectReference: gatewayapiv1.BackendObjectReference{Name: "api"},
				},
			}},
		}},
	}}

	got := make(map[string]common.RelatedResource)
	for _, item := range getHTTPRouteRelatedResouces(cs, res, "default") {
		got[item.Name] = item
	}

	gateway := got["default-gateway"]
	if gateway.Type != string(common.Gateways) || gateway.APIVersion != gatewayapiv1.GroupVersion.String() {
		t.Errorf("default parentRef = %#v, want type %q at %q",
			gateway, common.Gateways, gatewayapiv1.GroupVersion.String())
	}

	service := got["api"]
	if service.Type != string(common.Services) || service.APIVersion != corev1.SchemeGroupVersion.String() {
		t.Errorf("default backendRef = %#v, want type %q at %q",
			service, common.Services, corev1.SchemeGroupVersion.String())
	}
}

// HPA 的 scaleTargetRef 也走同一条换算，而不是 kind + "s"。
func TestGetScaleTargetRelatedResourcesUsesRESTMapper(t *testing.T) {
	cs := newRelatedResourceClientSet(t)

	related := getScaleTargetRelatedResources(cs, "Ingress", "networking.k8s.io/v1", "web", "default")
	if len(related) != 1 {
		t.Fatalf("getScaleTargetRelatedResources() = %#v, want one entry", related)
	}
	if related[0].Type != "ingresses" || related[0].Name != "web" || related[0].Namespace != "default" {
		t.Fatalf("scaleTargetRef = %#v, want ingresses/web in default", related[0])
	}
}

// init 容器与运行容器一样会引用 ConfigMap/Secret，相关资源里不能漏掉它们引用的配置。
func TestDiscoverConfigsIncludesInitContainers(t *testing.T) {
	podSpec := &corev1.PodTemplateSpec{Spec: corev1.PodSpec{
		Containers: []corev1.Container{{
			Name: "app",
			EnvFrom: []corev1.EnvFromSource{{
				ConfigMapRef: &corev1.ConfigMapEnvSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: "app-config"},
				},
			}},
		}},
		InitContainers: []corev1.Container{{
			Name: "init",
			EnvFrom: []corev1.EnvFromSource{{
				SecretRef: &corev1.SecretEnvSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: "init-secret"},
				},
			}},
		}},
		Volumes: []corev1.Volume{{
			Name: "data",
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "data-pvc"},
			},
		}},
	}}

	related := discoverConfigs("default", podSpec)
	got := make(map[string]bool, len(related))
	for _, item := range related {
		got[item.Type+"="+item.Name] = true
	}

	for _, want := range []string{
		string(common.ConfigMaps) + "=app-config",
		string(common.Secrets) + "=init-secret",
		string(common.PersistentVolumeClaims) + "=data-pvc",
	} {
		if !got[want] {
			t.Errorf("discoverConfigs() is missing %s: %#v", want, related)
		}
	}
}
