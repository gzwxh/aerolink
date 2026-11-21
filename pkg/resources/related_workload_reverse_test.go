package resources

import (
	"context"
	"testing"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// 回归（缺陷 D-71）：Deployment 的「相关资源」只列 Service 与 ConfigMap/Secret/PVC，
// 上面明明配了 HPA、PDB、Ingress，详情页却一项都看不到 —— 反向发现根本没实现。
// （接入 GetRelatedResources 后的整体效果在真机 devops-wxh 上核对，见验收台账 §26。）

func relatedNames(items []common.RelatedResource) []string {
	names := make([]string, 0, len(items))
	for _, item := range items {
		names = append(names, item.Type+"/"+item.Name)
	}
	return names
}

func hasRelated(items []common.RelatedResource, resourceType, name string) bool {
	for _, item := range items {
		if item.Type == resourceType && item.Name == name {
			return true
		}
	}
	return false
}

func newWorkloadRelatedClient(t *testing.T) *kube.K8sClient {
	t.Helper()

	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{
		corev1.AddToScheme,
		appsv1.AddToScheme,
		autoscalingv2.AddToScheme,
		policyv1.AddToScheme,
		networkingv1.AddToScheme,
	} {
		if err := add(scheme); err != nil {
			t.Fatalf("build scheme: %v", err)
		}
	}

	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default",
			Labels: map[string]string{"app": "web"}},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}},
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "main", Image: "nginx"}}},
			},
		},
	}
	scaled := &autoscalingv2.HorizontalPodAutoscaler{
		ObjectMeta: metav1.ObjectMeta{Name: "web-hpa", Namespace: "default"},
		Spec: autoscalingv2.HorizontalPodAutoscalerSpec{
			ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{
				APIVersion: "apps/v1", Kind: "Deployment", Name: "web",
			},
		},
	}
	// scaleTargetRef.kind 留空是 K8s 允许的写法，默认按 Deployment 理解。
	implicitKind := &autoscalingv2.HorizontalPodAutoscaler{
		ObjectMeta: metav1.ObjectMeta{Name: "web-hpa-implicit", Namespace: "default"},
		Spec: autoscalingv2.HorizontalPodAutoscalerSpec{
			ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{Name: "web"},
		},
	}
	otherScaled := &autoscalingv2.HorizontalPodAutoscaler{
		ObjectMeta: metav1.ObjectMeta{Name: "other-hpa", Namespace: "default"},
		Spec: autoscalingv2.HorizontalPodAutoscalerSpec{
			ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{
				APIVersion: "apps/v1", Kind: "StatefulSet", Name: "web",
			},
		},
	}
	matchingPDB := &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Name: "web-pdb", Namespace: "default"},
		Spec: policyv1.PodDisruptionBudgetSpec{
			MinAvailable: &intstr.IntOrString{Type: intstr.Int, IntVal: 1},
			Selector:     &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}},
		},
	}
	// 超集选择器：多一个 label 仍然能选中这批 Pod，应当算关联。
	supersetPDB := &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Name: "web-pdb-superset", Namespace: "default"},
		Spec: policyv1.PodDisruptionBudgetSpec{
			MinAvailable: &intstr.IntOrString{Type: intstr.Int, IntVal: 1},
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{
				"app": "web", "tier": "frontend",
			}},
		},
	}
	otherPDB := &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Name: "other-pdb", Namespace: "default"},
		Spec: policyv1.PodDisruptionBudgetSpec{
			MinAvailable: &intstr.IntOrString{Type: intstr.Int, IntVal: 1},
			Selector:     &metav1.LabelSelector{MatchLabels: map[string]string{"app": "batch"}},
		},
	}
	pathType := networkingv1.PathTypePrefix
	ruleIngress := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "web-ing", Namespace: "default"},
		Spec: networkingv1.IngressSpec{
			Rules: []networkingv1.IngressRule{{Host: "web.example.com", IngressRuleValue: networkingv1.IngressRuleValue{
				HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{{
					Path: "/", PathType: &pathType,
					Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "web-svc"}},
				}}},
			}}},
		},
	}
	defaultBackendIngress := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "web-ing-default", Namespace: "default"},
		Spec: networkingv1.IngressSpec{
			DefaultBackend: &networkingv1.IngressBackend{
				Service: &networkingv1.IngressServiceBackend{Name: "web-svc"},
			},
		},
	}
	otherIngress := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "other-ing", Namespace: "default"},
		Spec: networkingv1.IngressSpec{
			Rules: []networkingv1.IngressRule{{IngressRuleValue: networkingv1.IngressRuleValue{
				HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{{
					Path: "/", PathType: &pathType,
					Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "batch-svc"}},
				}}},
			}}},
		},
	}

	k8sClient := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		deployment, scaled, implicitKind, otherScaled,
		matchingPDB, supersetPDB, otherPDB,
		ruleIngress, defaultBackendIngress, otherIngress,
	).Build()
	return &kube.K8sClient{Client: k8sClient}
}

func TestDiscoverHorizontalPodAutoscalersByTarget(t *testing.T) {
	clientSet := newWorkloadRelatedClient(t)

	got := discoverHorizontalPodAutoscalersByTarget(
		context.Background(), clientSet, "Deployment", "web", "default")

	if !hasRelated(got, string(common.HorizontalPodAutoscalers), "web-hpa") {
		t.Fatalf("显式指向 web 的 HPA 没有列出: %v", relatedNames(got))
	}
	if !hasRelated(got, string(common.HorizontalPodAutoscalers), "web-hpa-implicit") {
		t.Fatalf("scaleTargetRef.kind 留空的 HPA 应按 Deployment 命中: %v", relatedNames(got))
	}
	if hasRelated(got, string(common.HorizontalPodAutoscalers), "other-hpa") {
		t.Fatalf("指向 StatefulSet/web 的 HPA 不该命中 Deployment/web: %v", relatedNames(got))
	}
	// 同名但不同 kind 也不能串味
	other := discoverHorizontalPodAutoscalersByTarget(
		context.Background(), clientSet, "StatefulSet", "web", "default")
	if !hasRelated(other, string(common.HorizontalPodAutoscalers), "other-hpa") ||
		hasRelated(other, string(common.HorizontalPodAutoscalers), "web-hpa") {
		t.Fatalf("按 StatefulSet 查时命中集不对: %v", relatedNames(other))
	}
}

func TestDiscoverPodDisruptionBudgetsByWorkload(t *testing.T) {
	clientSet := newWorkloadRelatedClient(t)
	selector := &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}

	got := discoverPodDisruptionBudgetsByWorkload(
		context.Background(), clientSet, "default", selector)

	if !hasRelated(got, string(common.PodDisruptionBudgets), "web-pdb") {
		t.Fatalf("选择器一致的 PDB 没有列出: %v", relatedNames(got))
	}
	// PDB 选择器是 Pod 标签的超集时选不中这批 Pod，不该算关联。
	if hasRelated(got, string(common.PodDisruptionBudgets), "web-pdb-superset") {
		t.Fatalf("要求额外标签的 PDB 不该命中: %v", relatedNames(got))
	}
	if hasRelated(got, string(common.PodDisruptionBudgets), "other-pdb") {
		t.Fatalf("选择器指向别的负载的 PDB 不该命中: %v", relatedNames(got))
	}

	if got := discoverPodDisruptionBudgetsByWorkload(
		context.Background(), clientSet, "default", nil); got != nil {
		t.Fatalf("selector 为 nil 时应返回空, got %v", relatedNames(got))
	}
}

func TestDiscoverIngressesByServices(t *testing.T) {
	clientSet := newWorkloadRelatedClient(t)
	services := []common.RelatedResource{{
		Type: string(common.Services), Namespace: "default", Name: "web-svc",
	}}

	got := discoverIngressesByServices(context.Background(), clientSet, "default", services)

	if !hasRelated(got, string(common.Ingresses), "web-ing") {
		t.Fatalf("rules 里指向 web-svc 的 Ingress 没列出: %v", relatedNames(got))
	}
	if !hasRelated(got, string(common.Ingresses), "web-ing-default") {
		t.Fatalf("defaultBackend 指向 web-svc 的 Ingress 没列出: %v", relatedNames(got))
	}
	if hasRelated(got, string(common.Ingresses), "other-ing") {
		t.Fatalf("后端是别的 Service 的 Ingress 不该命中: %v", relatedNames(got))
	}

	// 没有相关 Service 时不该去列 Ingress（也别返回空壳结果）
	if got := discoverIngressesByServices(context.Background(), clientSet, "default", nil); got != nil {
		t.Fatalf("无 Service 时应返回空, got %v", relatedNames(got))
	}
	// 跨命名空间的 Service 名单不能把别的命名空间的 Ingress 带进来
	other := discoverIngressesByServices(context.Background(), clientSet, "other", services)
	if other != nil {
		t.Fatalf("namespace 不匹配时应为空, got %v", relatedNames(other))
	}
}
