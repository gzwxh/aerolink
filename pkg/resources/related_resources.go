package resources

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"golang.org/x/sync/errgroup"
	appsv1 "k8s.io/api/apps/v1"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	v1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	policyv1beta1 "k8s.io/api/policy/v1beta1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayapiv1 "sigs.k8s.io/gateway-api/apis/v1"
)

func discoverServices(ctx context.Context, k8sClient *kube.K8sClient, namespace string, selector *metav1.LabelSelector) ([]common.RelatedResource, error) {
	if selector == nil || selector.MatchLabels == nil {
		return []common.RelatedResource{}, nil
	}

	var serviceList corev1.ServiceList
	if err := k8sClient.List(ctx, &serviceList, client.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("failed to list services: %w", err)
	}

	var relatedServices []common.RelatedResource
	for _, service := range serviceList.Items {
		if service.Spec.Selector != nil {
			serviceSelector := labels.SelectorFromSet(service.Spec.Selector)
			if serviceSelector.Matches(labels.Set(selector.MatchLabels)) {
				relatedServices = append(relatedServices, common.RelatedResource{
					Type:      string(common.Services),
					Namespace: service.Namespace,
					Name:      service.Name,
				})
			}
		}
	}

	return relatedServices, nil
}

func discoverIngressServices(namespace string, ingress *v1.Ingress) []common.RelatedResource {
	seen := make(map[string]struct{})
	var relatedServices []common.RelatedResource
	addService := func(svcName string) {
		if _, exist := seen[svcName]; exist {
			return
		}
		seen[svcName] = struct{}{}
		relatedServices = append(relatedServices, common.RelatedResource{
			Type:      string(common.Services),
			Namespace: namespace,
			Name:      svcName,
		})
	}

	for _, rule := range ingress.Spec.Rules {
		if rule.HTTP == nil {
			continue
		}

		for _, path := range rule.HTTP.Paths {
			if path.Backend.Service == nil {
				continue
			}
			addService(path.Backend.Service.Name)
		}
	}
	if ingress.Spec.DefaultBackend != nil && ingress.Spec.DefaultBackend.Service != nil {
		if _, exist := seen[ingress.Spec.DefaultBackend.Service.Name]; !exist {
			addService(ingress.Spec.DefaultBackend.Service.Name)
		}
	}

	return relatedServices
}

// resourceTypeForKind 把 Kind + apiVersion 换算成资源类型（复数形式，前端据此拼链接）。
//
// 此前统一用 strings.ToLower(kind) + "s"：Deployment、StatefulSet 这类恰好对得上，
// 但 Ingress、Endpoints、Policy 以及几乎所有自定义资源都会算错（"ingresss"），
// 前端因此拿到一个不存在的类型。RESTMapper 能给出准确答案；只在它查不出来
// （例如类型未注册、集群不可达）时退回旧写法，保持原有的降级行为。
func resourceTypeForKind(cs *cluster.ClientSet, kind, apiVersion string) string {
	fallback := strings.ToLower(kind) + "s"
	if cs == nil || cs.K8sClient == nil || cs.K8sClient.Client == nil || kind == "" || apiVersion == "" {
		return fallback
	}
	gv, err := schema.ParseGroupVersion(apiVersion)
	if err != nil {
		return fallback
	}
	mapping, err := cs.K8sClient.RESTMapper().RESTMapping(
		schema.GroupKind{Group: gv.Group, Kind: kind}, gv.Version)
	if err != nil {
		return fallback
	}
	return mapping.Resource.Resource
}

func discoverConfigs(namespace string, podSpec *corev1.PodTemplateSpec) []common.RelatedResource {
	if podSpec == nil {
		return []common.RelatedResource{}
	}

	configMapSet := make(map[string]struct{})
	secretSet := make(map[string]struct{})
	pvcSet := make(map[string]struct{})

	// init 容器与运行容器一样会引用 ConfigMap/Secret（checkInUsedConfigs 也是这么算的），
	// 只扫 Containers 会让只被 init 容器引用的配置在「相关资源」里消失。
	containers := podSpec.Spec.Containers
	containers = append(containers, podSpec.Spec.InitContainers...)

	for _, container := range containers {
		for _, envVar := range container.Env {
			if envVar.ValueFrom != nil && envVar.ValueFrom.ConfigMapKeyRef != nil {
				configMapSet[envVar.ValueFrom.ConfigMapKeyRef.Name] = struct{}{}
			}
			if envVar.ValueFrom != nil && envVar.ValueFrom.SecretKeyRef != nil {
				secretSet[envVar.ValueFrom.SecretKeyRef.Name] = struct{}{}
			}
		}
		for _, envFrom := range container.EnvFrom {
			if envFrom.ConfigMapRef != nil {
				configMapSet[envFrom.ConfigMapRef.Name] = struct{}{}
			}
			if envFrom.SecretRef != nil {
				secretSet[envFrom.SecretRef.Name] = struct{}{}
			}
		}
	}

	for _, volume := range podSpec.Spec.Volumes {
		if volume.ConfigMap != nil {
			configMapSet[volume.ConfigMap.Name] = struct{}{}
		}
		if volume.Secret != nil {
			secretSet[volume.Secret.SecretName] = struct{}{}
		}
		if volume.PersistentVolumeClaim != nil {
			pvcSet[volume.PersistentVolumeClaim.ClaimName] = struct{}{}
		}
	}

	var related []common.RelatedResource
	for name := range configMapSet {
		related = append(related, common.RelatedResource{
			Type:      string(common.ConfigMaps),
			Name:      name,
			Namespace: namespace,
		})
	}
	for name := range secretSet {
		related = append(related, common.RelatedResource{
			Type:      string(common.Secrets),
			Name:      name,
			Namespace: namespace,
		})
	}
	for name := range pvcSet {
		related = append(related, common.RelatedResource{
			Type:      string(common.PersistentVolumeClaims),
			Name:      name,
			Namespace: namespace,
		})
	}

	return related
}

func checkInUsedConfigs(spec *corev1.PodTemplateSpec, name string, resourceType string) bool {
	if spec == nil {
		return false
	}

	containers := spec.Spec.Containers
	containers = append(containers, spec.Spec.InitContainers...)
	for _, container := range containers {
		for _, envVar := range container.Env {
			if envVar.ValueFrom != nil {
				if resourceType == string(common.ConfigMaps) && envVar.ValueFrom.ConfigMapKeyRef != nil && envVar.ValueFrom.ConfigMapKeyRef.Name == name {
					return true
				}
				if resourceType == string(common.Secrets) && envVar.ValueFrom.SecretKeyRef != nil && envVar.ValueFrom.SecretKeyRef.Name == name {
					return true
				}
			}
		}
		for _, envFrom := range container.EnvFrom {
			if resourceType == string(common.ConfigMaps) && envFrom.ConfigMapRef != nil && envFrom.ConfigMapRef.Name == name {
				return true
			}
			if resourceType == string(common.Secrets) && envFrom.SecretRef != nil && envFrom.SecretRef.Name == name {
				return true
			}
		}
	}
	for _, volume := range spec.Spec.Volumes {
		if resourceType == string(common.ConfigMaps) && volume.ConfigMap != nil && volume.ConfigMap.Name == name {
			return true
		}
		if resourceType == string(common.Secrets) && volume.Secret != nil && volume.Secret.SecretName == name {
			return true
		}
		if resourceType == string(common.PersistentVolumeClaims) && volume.PersistentVolumeClaim != nil && volume.PersistentVolumeClaim.ClaimName == name {
			return true
		}
	}
	return false
}

// discoveryWorkloads 找出引用了给定 ConfigMap/Secret/PVC 的
// Deployment、StatefulSet 与 DaemonSet。这三个 List 调用相互独立，
// 因此用 errgroup 并行发起。
func discoveryWorkloads(ctx context.Context, k8sClient *kube.K8sClient, namespace string, name string, resourceType string) ([]common.RelatedResource, error) {
	g, gctx := errgroup.WithContext(ctx)

	var deploymentList appsv1.DeploymentList
	var statefulSetList appsv1.StatefulSetList
	var daemonSetList appsv1.DaemonSetList

	g.Go(func() error {
		return k8sClient.List(gctx, &deploymentList, client.InNamespace(namespace))
	})
	g.Go(func() error {
		return k8sClient.List(gctx, &statefulSetList, client.InNamespace(namespace))
	})
	g.Go(func() error {
		return k8sClient.List(gctx, &daemonSetList, client.InNamespace(namespace))
	})

	if err := g.Wait(); err != nil {
		return nil, err
	}

	// Wait 之后每个列表只归本 goroutine 所有——可以安全读取。
	var related []common.RelatedResource
	for _, deployment := range deploymentList.Items {
		if checkInUsedConfigs(&deployment.Spec.Template, name, resourceType) {
			related = append(related, common.RelatedResource{
				Type:      string(common.Deployments),
				Name:      deployment.Name,
				Namespace: deployment.Namespace,
			})
		}
	}
	for _, statefulSet := range statefulSetList.Items {
		if checkInUsedConfigs(&statefulSet.Spec.Template, name, resourceType) {
			related = append(related, common.RelatedResource{
				Type:      string(common.StatefulSets),
				Name:      statefulSet.Name,
				Namespace: statefulSet.Namespace,
			})
		}
	}
	for _, daemonSet := range daemonSetList.Items {
		if checkInUsedConfigs(&daemonSet.Spec.Template, name, resourceType) {
			related = append(related, common.RelatedResource{
				Type:      string(common.DaemonSets),
				Name:      daemonSet.Name,
				Namespace: daemonSet.Namespace,
			})
		}
	}
	return related, nil
}

func discoverPodsByService(ctx context.Context, k8sClient *kube.K8sClient, service *corev1.Service) []common.RelatedResource {
	var endpoints corev1.Endpoints
	if err := k8sClient.Get(ctx, client.ObjectKey{Namespace: service.Namespace, Name: service.Name}, &endpoints); err != nil {
		// Endpoints 可能找不到，这不是致命错误，
		// 例如 ExternalName 类型的 Service。
		return nil
	}

	var relatedPods []common.RelatedResource
	for _, subset := range endpoints.Subsets {
		for _, addr := range subset.Addresses {
			if addr.TargetRef != nil && addr.TargetRef.Kind == "Pod" {
				relatedPods = append(relatedPods, common.RelatedResource{
					Type:      string(common.Pods),
					Namespace: addr.TargetRef.Namespace,
					Name:      addr.TargetRef.Name,
				})
			}
		}
	}
	return relatedPods
}

func discoverPodsByPodDisruptionBudget(ctx context.Context, k8sClient *kube.K8sClient, namespace string, selector *metav1.LabelSelector) ([]common.RelatedResource, error) {
	if selector == nil {
		return []common.RelatedResource{}, nil
	}

	labelSelector, err := metav1.LabelSelectorAsSelector(selector)
	if err != nil {
		return nil, err
	}

	var podList corev1.PodList
	if err := k8sClient.List(ctx, &podList, client.InNamespace(namespace), client.MatchingLabelsSelector{Selector: labelSelector}); err != nil {
		return nil, err
	}

	relatedPods := make([]common.RelatedResource, 0, len(podList.Items))
	for _, pod := range podList.Items {
		relatedPods = append(relatedPods, common.RelatedResource{
			Type:      "pods",
			Namespace: pod.Namespace,
			Name:      pod.Name,
		})
	}

	return relatedPods, nil
}

func discoverPodsByPodDisruptionBudgetV1Beta1(ctx context.Context, k8sClient *kube.K8sClient, namespace string, selector *metav1.LabelSelector) ([]common.RelatedResource, error) {
	if selector == nil || isEmptyLabelSelector(selector) {
		return []common.RelatedResource{}, nil
	}
	return discoverPodsByPodDisruptionBudget(ctx, k8sClient, namespace, selector)
}

func discoverPodDisruptionBudgetsByPod(ctx context.Context, k8sClient *kube.K8sClient, namespace string, podLabels map[string]string) ([]common.RelatedResource, error) {
	if len(podLabels) == 0 {
		return []common.RelatedResource{}, nil
	}

	var pdbList policyv1.PodDisruptionBudgetList
	if err := k8sClient.List(ctx, &pdbList, client.InNamespace(namespace)); err == nil {
		return matchingPodDisruptionBudgetsByPod(pdbList.Items, podLabels), nil
	}

	var betaPDBList policyv1beta1.PodDisruptionBudgetList
	if err := k8sClient.List(ctx, &betaPDBList, client.InNamespace(namespace)); err != nil {
		return nil, err
	}

	return matchingBetaPodDisruptionBudgetsByPod(betaPDBList.Items, podLabels), nil
}

func matchingPodDisruptionBudgetsByPod(items []policyv1.PodDisruptionBudget, podLabels map[string]string) []common.RelatedResource {
	relatedPDBs := make([]common.RelatedResource, 0)
	for _, pdb := range items {
		relatedPDBs = appendMatchingPodDisruptionBudget(relatedPDBs, pdb.Namespace, pdb.Name, pdb.Spec.Selector, podLabels, false)
	}

	return relatedPDBs
}

func matchingBetaPodDisruptionBudgetsByPod(items []policyv1beta1.PodDisruptionBudget, podLabels map[string]string) []common.RelatedResource {
	relatedPDBs := make([]common.RelatedResource, 0)
	for _, pdb := range items {
		relatedPDBs = appendMatchingPodDisruptionBudget(relatedPDBs, pdb.Namespace, pdb.Name, pdb.Spec.Selector, podLabels, true)
	}

	return relatedPDBs
}

func appendMatchingPodDisruptionBudget(relatedPDBs []common.RelatedResource, namespace, name string, selector *metav1.LabelSelector, podLabels map[string]string, beta bool) []common.RelatedResource {
	if selector == nil || beta && isEmptyLabelSelector(selector) {
		return relatedPDBs
	}

	labelSelector, err := metav1.LabelSelectorAsSelector(selector)
	if err != nil {
		return relatedPDBs
	}

	if !labelSelector.Matches(labels.Set(podLabels)) {
		return relatedPDBs
	}

	return append(relatedPDBs, common.RelatedResource{
		Type:      "poddisruptionbudgets",
		Namespace: namespace,
		Name:      name,
	})
}

func isEmptyLabelSelector(selector *metav1.LabelSelector) bool {
	return len(selector.MatchLabels) == 0 && len(selector.MatchExpressions) == 0
}

func getStorageClassRelatedResources(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	name := c.Param("name")
	if _, err := GetResource(c, string(common.StorageClasses), common.AllNamespaces, name); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get resource: " + err.Error()})
		return
	}

	var pvcList corev1.PersistentVolumeClaimList
	if err := cs.K8sClient.List(c.Request.Context(), &pvcList); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to discover PVCs: " + err.Error()})
		return
	}

	user := c.MustGet("user").(model.User)
	result := make([]common.RelatedResource, 0)
	for _, pvc := range pvcList.Items {
		if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != name {
			continue
		}
		if !rbac.CanAccess(user, string(common.PersistentVolumeClaims), string(common.VerbGet), cs.Name, pvc.Namespace) {
			continue
		}
		result = append(result, common.RelatedResource{
			Type:      string(common.PersistentVolumeClaims),
			Name:      pvc.Name,
			Namespace: pvc.Namespace,
		})
	}
	c.JSON(http.StatusOK, result)
}

func getPersistentVolumeClaimRelatedResources(pvc *corev1.PersistentVolumeClaim) []common.RelatedResource {
	result := make([]common.RelatedResource, 0, 2)
	if pvc.Spec.StorageClassName != nil && *pvc.Spec.StorageClassName != "" {
		result = append(result, common.RelatedResource{
			Type: string(common.StorageClasses),
			Name: *pvc.Spec.StorageClassName,
		})
	}
	return append(result, common.RelatedResource{
		Type: string(common.PersistentVolumes),
		Name: pvc.Spec.VolumeName,
	})
}

func GetRelatedResources(c *gin.Context) { //nolint:gocyclo // 各资源的关联发现集中在这里，是有意为之
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	namespace := c.Param("namespace")
	name := c.Param("name")
	resourceType := c.GetString("resource") // Get resource type from context

	resource, err := GetResource(c, resourceType, namespace, name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get resource: " + err.Error()})
		return
	}
	ctx := c.Request.Context()
	var podSpec *corev1.PodTemplateSpec
	var selector *metav1.LabelSelector
	result := make([]common.RelatedResource, 0)

	switch res := resource.(type) {
	case *corev1.Pod:
		podSpec = &corev1.PodTemplateSpec{
			Spec: res.Spec,
		}
		// 对 pod 而言，使用标签作为选择器
		if res.Labels != nil {
			selector = &metav1.LabelSelector{
				MatchLabels: res.Labels,
			}
		}
		if relatedPDBs, err := discoverPodDisruptionBudgetsByPod(ctx, cs.K8sClient, namespace, res.Labels); err == nil {
			result = append(result, relatedPDBs...)
		}
	case *appsv1.Deployment:
		podSpec = &res.Spec.Template
		selector = res.Spec.Selector
	case *appsv1.StatefulSet:
		podSpec = &res.Spec.Template
		selector = res.Spec.Selector
	case *appsv1.DaemonSet:
		podSpec = &res.Spec.Template
		selector = res.Spec.Selector
	case *corev1.Service:
		relatedPods := discoverPodsByService(ctx, cs.K8sClient, res)
		result = append(result, relatedPods...)
	case *corev1.ConfigMap, *corev1.Secret, *corev1.PersistentVolumeClaim:
		if workloads, err := discoveryWorkloads(ctx, cs.K8sClient, namespace, name, resourceType); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to discover workloads: " + err.Error()})
			return
		} else {
			if resourceType == string(common.PersistentVolumeClaims) {
				pvc := res.(*corev1.PersistentVolumeClaim)
				result = append(result, getPersistentVolumeClaimRelatedResources(pvc)...)
			}
			result = append(result, workloads...)
		}
	case *gatewayapiv1.HTTPRoute:
		result = getHTTPRouteRelatedResouces(cs, res, namespace)
	case *autoscalingv2.HorizontalPodAutoscaler:
		result = getAutoScalingRelatedResources(cs, res, namespace)
	case *autoscalingv1.HorizontalPodAutoscaler:
		result = getScaleTargetRelatedResources(cs, res.Spec.ScaleTargetRef.Kind, res.Spec.ScaleTargetRef.APIVersion, res.Spec.ScaleTargetRef.Name, namespace)
	case *v1.Ingress:
		services := discoverIngressServices(namespace, res)
		result = append(result, services...)
	case *policyv1.PodDisruptionBudget:
		if relatedPods, err := discoverPodsByPodDisruptionBudget(ctx, cs.K8sClient, namespace, res.Spec.Selector); err == nil {
			result = append(result, relatedPods...)
		}
	case *policyv1beta1.PodDisruptionBudget:
		if relatedPods, err := discoverPodsByPodDisruptionBudgetV1Beta1(ctx, cs.K8sClient, namespace, res.Spec.Selector); err == nil {
			result = append(result, relatedPods...)
		}
	}

	if podSpec != nil && selector != nil {
		// discoverServices（I/O）与 discoverConfigs（纯 CPU）相互独立；
		// 并行执行以让 I/O 与 CPU 工作重叠。
		g, gctx := errgroup.WithContext(ctx)

		var relatedServices []common.RelatedResource
		g.Go(func() error {
			var err error
			relatedServices, err = discoverServices(gctx, cs.K8sClient, namespace, selector)
			return err
		})

		var related []common.RelatedResource
		g.Go(func() error {
			related = discoverConfigs(namespace, podSpec)
			return nil
		})

		if err := g.Wait(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to discover services: " + err.Error()})
			return
		}

		result = append(result, relatedServices...)
		result = append(result, related...)
	}

	if v, ok := resource.(client.Object); ok {
		for _, owner := range v.GetOwnerReferences() {
			if owner.Kind == "ReplicaSet" {
				// 获取 ReplicaSet 的属主
				rs := &appsv1.ReplicaSet{}
				if err := cs.K8sClient.Get(ctx, client.ObjectKey{Namespace: v.GetNamespace(), Name: owner.Name}, rs); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get ReplicaSet owner: " + err.Error()})
					return
				}
				if len(rs.OwnerReferences) > 0 {
					for _, rsOwner := range rs.OwnerReferences {
						result = append(result, common.RelatedResource{
							Type:       resourceTypeForKind(cs, rsOwner.Kind, rsOwner.APIVersion),
							Name:       rsOwner.Name,
							Namespace:  v.GetNamespace(),
							APIVersion: rsOwner.APIVersion,
						})
					}
				}
			}
			result = append(result, common.RelatedResource{
				Type:       resourceTypeForKind(cs, owner.Kind, owner.APIVersion),
				Name:       owner.Name,
				Namespace:  v.GetNamespace(),
				APIVersion: owner.APIVersion,
			})
		}
	}

	user := c.MustGet("user").(model.User)
	filtered := result[:0]
	for _, related := range result {
		namespace := related.Namespace
		if namespace == "" {
			namespace = common.AllNamespaces
		}
		group := ""
		if separator := strings.IndexByte(related.APIVersion, '/'); separator >= 0 {
			group = related.APIVersion[:separator]
		}
		resourceType := common.HistoryResourceType(related.Type, group)
		if rbac.CanAccess(user, resourceType, string(common.VerbGet), cs.Name, namespace) {
			filtered = append(filtered, related)
		}
	}
	c.JSON(http.StatusOK, filtered)
}

func getHTTPRouteRelatedResouces(cs *cluster.ClientSet, res *gatewayapiv1.HTTPRoute, namespace string) []common.RelatedResource {
	var result []common.RelatedResource
	for _, parentRef := range res.Spec.ParentRefs {
		// parentRef 不写 kind 时就是 Gateway。
		parentKind := "Gateway"
		if parentRef.Kind != nil && *parentRef.Kind != "" {
			parentKind = string(*parentRef.Kind)
		}
		parentAPIVersion := gatewayReferenceAPIVersion(parentRef.Group, gatewayapiv1.GroupVersion.String())
		result = append(result, common.RelatedResource{
			Type:       resourceTypeForKind(cs, parentKind, parentAPIVersion),
			Name:       string(parentRef.Name),
			APIVersion: parentAPIVersion,
			Namespace: func() string {
				if parentRef.Namespace != nil && *parentRef.Namespace != "" {
					return string(*parentRef.Namespace)
				}
				return namespace
			}(),
		})
	}

	for _, rule := range res.Spec.Rules {
		for _, backend := range rule.BackendRefs {
			// backendRef 不写 kind 时就是 Service（core 组）。
			backendKind := "Service"
			defaultAPIVersion := corev1.SchemeGroupVersion.String()
			if backend.Kind != nil && *backend.Kind != "" {
				backendKind = string(*backend.Kind)
				if !strings.EqualFold(backendKind, "Service") {
					defaultAPIVersion = ""
				}
			}
			backendAPIVersion := gatewayReferenceAPIVersion(backend.Group, defaultAPIVersion)
			result = append(result, common.RelatedResource{
				Type: resourceTypeForKind(cs, backendKind, backendAPIVersion),
				Name: string(backend.Name),
				Namespace: func() string {
					if backend.Namespace != nil && *backend.Namespace != "" {
						return string(*backend.Namespace)
					}
					return namespace
				}(),
				APIVersion: backendAPIVersion,
			})
		}
	}
	return result
}

func gatewayReferenceAPIVersion(group *gatewayapiv1.Group, defaultAPIVersion string) string {
	if group == nil {
		return defaultAPIVersion
	}
	groupName := string(*group)
	if groupName == "" {
		return corev1.SchemeGroupVersion.String()
	}
	if groupName == gatewayapiv1.GroupVersion.Group {
		return gatewayapiv1.GroupVersion.String()
	}
	return groupName + "/" + gatewayapiv1.GroupVersion.Version
}

func getAutoScalingRelatedResources(cs *cluster.ClientSet, res *autoscalingv2.HorizontalPodAutoscaler, namespace string) []common.RelatedResource {
	scaleTarget := res.Spec.ScaleTargetRef
	return getScaleTargetRelatedResources(cs, scaleTarget.Kind, scaleTarget.APIVersion, scaleTarget.Name, namespace)
}

func getScaleTargetRelatedResources(cs *cluster.ClientSet, kind, apiVersion, name, namespace string) []common.RelatedResource {
	var result []common.RelatedResource
	result = append(result, common.RelatedResource{
		Type:       resourceTypeForKind(cs, kind, apiVersion),
		APIVersion: apiVersion,
		Name:       name,
		Namespace:  namespace,
	})
	return result
}
