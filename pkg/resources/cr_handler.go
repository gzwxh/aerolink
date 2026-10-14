package resources

import (
	"context"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"gorm.io/gorm"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/klog/v2"
	"k8s.io/kubectl/pkg/describe"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/yaml"
)

// CRHandler 依据 CRD 名称处理自定资源的 API 操作
type CRHandler struct {
}

// NewCRHandler 创建一个新的 CRHandler
func NewCRHandler() *CRHandler {
	return &CRHandler{}
}

// getCRDByName 按名称获取 CRD 定义
func (h *CRHandler) getCRDByName(ctx context.Context, client *kube.K8sClient, crdName string) (*apiextensionsv1.CustomResourceDefinition, error) {
	var crd apiextensionsv1.CustomResourceDefinition
	if err := client.Get(ctx, types.NamespacedName{Name: crdName}, &crd); err != nil {
		return nil, err
	}
	return &crd, nil
}

// getGVRFromCRD 从 CRD 中提取 GroupVersionResource
func (h *CRHandler) getGVRFromCRD(crd *apiextensionsv1.CustomResourceDefinition) schema.GroupVersionResource {
	// 默认使用第一个 served 版本
	var version string
	for _, v := range crd.Spec.Versions {
		if v.Served {
			version = v.Name
			break
		}
	}

	return schema.GroupVersionResource{
		Group:    crd.Spec.Group,
		Version:  version,
		Resource: crd.Spec.Names.Plural,
	}
}

func validateCRNamespace(c *gin.Context, crd *apiextensionsv1.CustomResourceDefinition) bool {
	if crd.Spec.Scope != apiextensionsv1.ClusterScoped {
		return true
	}
	namespace := c.Param("namespace")
	if namespace == "" || namespace == common.AllNamespaces {
		return true
	}
	c.JSON(http.StatusBadRequest, gin.H{"error": "cluster-scoped custom resources must use _all as namespace"})
	return false
}

func (h *CRHandler) toYAML(obj *unstructured.Unstructured) string {
	if obj == nil {
		return ""
	}
	copied := obj.DeepCopy()
	copied.SetManagedFields(nil)
	yamlBytes, err := yaml.Marshal(copied)
	if err != nil {
		return ""
	}
	return string(yamlBytes)
}

func (h *CRHandler) recordHistory(c *gin.Context, crd *apiextensionsv1.CustomResourceDefinition, opType string, prev, curr *unstructured.Unstructured, success bool, errMsg string) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	user := c.MustGet("user").(model.User)

	resourceName := ""
	namespace := ""
	if curr != nil {
		resourceName = curr.GetName()
		namespace = curr.GetNamespace()
	}
	if resourceName == "" && prev != nil {
		resourceName = prev.GetName()
	}
	if namespace == "" && prev != nil {
		namespace = prev.GetNamespace()
	}

	history := model.ResourceHistory{
		ClusterName:   cs.Name,
		ResourceType:  crd.Name,
		ResourceName:  resourceName,
		Namespace:     namespace,
		OperationType: opType,
		ResourceYAML:  model.LongText(h.toYAML(curr)),
		PreviousYAML:  model.LongText(h.toYAML(prev)),
		Success:       success,
		ErrorMessage:  errMsg,
		OperatorID:    model.OperatorRef(user.ID),
		OperatorName:  user.Username,
		ClientIP:      c.ClientIP(),
		UserAgent:     common.AuditUserAgent(c.Request.UserAgent()),
	}
	// 带请求上下文：审计事件由此带上 request_id，可与同一次请求的访问日志互相定位。
	// 走统一入口而不是 DB.Create：由 sink 决定落库还是直接归档（见 model.RecordAudit）。
	if err := model.RecordAudit(c.Request.Context(), &history); err != nil {
		klog.Errorf("Failed to create custom resource history: %v", err)
	}
}

func (h *CRHandler) List(c *gin.Context) {
	crdName := c.Param("crd")
	if crdName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "CRD name is required"})
		return
	}
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	ctx := c.Request.Context()

	// 获取 CRD 定义
	crd, err := h.getCRDByName(ctx, cs.K8sClient, crdName)
	if err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "CustomResourceDefinition not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !validateCRNamespace(c, crd) {
		return
	}
	namespace := c.Param("namespace")
	allNamespaces := namespace == "" || namespace == common.AllNamespaces
	user := c.MustGet("user").(model.User)
	if crd.Spec.Scope == apiextensionsv1.ClusterScoped && allNamespaces &&
		!rbac.CanAccess(user, crdName, string(common.VerbGet), cs.Name, common.AllNamespaces) {
		c.JSON(http.StatusForbidden, gin.H{"error": rbac.NoAccess(user.Key(), string(common.VerbGet), crdName, common.AllNamespaces, cs.Name)})
		return
	}

	// 依据 CRD 构造 GVR
	gvr := h.getGVRFromCRD(crd)

	// 构造 unstructured 列表对象
	crList := &unstructured.UnstructuredList{}
	crList.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   gvr.Group,
		Version: gvr.Version,
		Kind:    crd.Spec.Names.ListKind,
	})

	opts := &client.ListOptions{}

	// 处理命名空间参数（针对命名空间级资源）
	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped {
		if !allNamespaces {
			opts.Namespace = namespace
		}
	}
	if labelSelector := c.Query("labelSelector"); labelSelector != "" {
		selector, err := labels.Parse(labelSelector)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid labelSelector parameter: " + err.Error()})
			return
		}
		opts.LabelSelector = selector
	}

	if err := cs.K8sClient.List(ctx, crList, opts); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped && allNamespaces {
		items := crList.Items[:0]
		for i := range crList.Items {
			if rbac.CanAccess(user, crdName, string(common.VerbGet), cs.Name, crList.Items[i].GetNamespace()) {
				items = append(items, crList.Items[i])
			}
		}
		crList.Items = items
	}

	c.JSON(http.StatusOK, crList)
}

func (h *CRHandler) Get(c *gin.Context) {
	crdName := c.Param("crd")
	name := c.Param("name")

	if crdName == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "CRD name and resource name are required"})
		return
	}

	cs := c.MustGet("cluster").(*cluster.ClientSet)
	ctx := c.Request.Context()

	// 获取 CRD 定义
	crd, err := h.getCRDByName(ctx, cs.K8sClient, crdName)
	if err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "CustomResourceDefinition not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !validateCRNamespace(c, crd) {
		return
	}

	// 依据 CRD 构造 GVR
	gvr := h.getGVRFromCRD(crd)

	// 构造 unstructured 对象
	cr := &unstructured.Unstructured{}
	cr.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   gvr.Group,
		Version: gvr.Version,
		Kind:    crd.Spec.Names.Kind,
	})

	var namespacedName types.NamespacedName
	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped {
		namespace := c.Param("namespace")
		// 同时处理常规命名空间与 _all 两种路由
		if namespace == common.AllNamespaces {
			c.JSON(http.StatusBadRequest, gin.H{"error": "This custom resource is namespace-scoped, use /:crd/:namespace/:name endpoint"})
			return
		}
		if namespace == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required for namespaced custom resources"})
			return
		}
		namespacedName = types.NamespacedName{Namespace: namespace, Name: name}
	} else {
		// 集群级资源忽略命名空间参数
		namespacedName = types.NamespacedName{Name: name}
	}

	if err := cs.K8sClient.Get(ctx, namespacedName, cr); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Custom resource not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	cr.SetManagedFields(nil)
	anno := cr.GetAnnotations()
	if anno != nil {
		delete(anno, common.KubectlAnnotation)
	}
	cr.SetAnnotations(anno)
	c.JSON(http.StatusOK, cr)
}

func (h *CRHandler) Create(c *gin.Context) {
	crdName := c.Param("crd")
	if crdName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "CRD name is required"})
		return
	}
	ctx := c.Request.Context()
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	// 获取 CRD 定义
	crd, err := h.getCRDByName(ctx, cs.K8sClient, crdName)
	if err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "CustomResourceDefinition not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !validateCRNamespace(c, crd) {
		return
	}

	// 依据 CRD 构造 GVR
	gvr := h.getGVRFromCRD(crd)

	// 把请求体解析为 unstructured 对象
	var cr unstructured.Unstructured
	if err := c.ShouldBindJSON(&cr); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 设置正确的 GVK
	cr.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   gvr.Group,
		Version: gvr.Version,
		Kind:    crd.Spec.Names.Kind,
	})

	// 为命名空间级资源设置命名空间
	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped {
		namespace := c.Param("namespace")
		if namespace == common.AllNamespaces {
			c.JSON(http.StatusBadRequest, gin.H{"error": "This custom resource is namespace-scoped, use /:crd/:namespace endpoint"})
			return
		}
		if namespace == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required for namespaced custom resources"})
			return
		}
		cr.SetNamespace(namespace)
	}

	var success bool
	var errMsg string
	defer func() {
		h.recordHistory(c, crd, "create", nil, &cr, success, errMsg)
	}()

	if err := cs.K8sClient.Create(ctx, &cr); err != nil {
		errMsg = err.Error()
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	success = true
	c.JSON(http.StatusCreated, cr)
}

func (h *CRHandler) Update(c *gin.Context) {
	crdName := c.Param("crd")
	name := c.Param("name")

	if crdName == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "CRD name and resource name are required"})
		return
	}

	cs := c.MustGet("cluster").(*cluster.ClientSet)
	ctx := c.Request.Context()

	// 获取 CRD 定义
	crd, err := h.getCRDByName(ctx, cs.K8sClient, crdName)
	if err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "CustomResourceDefinition not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !validateCRNamespace(c, crd) {
		return
	}

	// 依据 CRD 构造 GVR
	gvr := h.getGVRFromCRD(crd)

	// 先读取已存在的自定资源
	existingCR := &unstructured.Unstructured{}
	existingCR.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   gvr.Group,
		Version: gvr.Version,
		Kind:    crd.Spec.Names.Kind,
	})

	var namespacedName types.NamespacedName
	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped {
		namespace := c.Param("namespace")
		if namespace == common.AllNamespaces {
			c.JSON(http.StatusBadRequest, gin.H{"error": "This custom resource is namespace-scoped, use /:crd/:namespace/:name endpoint"})
			return
		}
		if namespace == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required for namespaced custom resources"})
			return
		}
		namespacedName = types.NamespacedName{Namespace: namespace, Name: name}
	} else {
		namespacedName = types.NamespacedName{Name: name}
	}

	if err := cs.K8sClient.Get(ctx, namespacedName, existingCR); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Custom resource not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 把请求体解析为 unstructured 对象
	var updatedCR unstructured.Unstructured
	if err := c.ShouldBindJSON(&updatedCR); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 保留重要的元数据
	updatedCR.SetGroupVersionKind(existingCR.GroupVersionKind())
	updatedCR.SetName(name)
	updatedCR.SetResourceVersion(existingCR.GetResourceVersion())
	updatedCR.SetUID(existingCR.GetUID())

	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped {
		updatedCR.SetNamespace(existingCR.GetNamespace())
	}

	previousCR := existingCR.DeepCopy()
	var success bool
	var errMsg string
	defer func() {
		h.recordHistory(c, crd, "update", previousCR, &updatedCR, success, errMsg)
	}()

	if err := cs.K8sClient.Update(ctx, &updatedCR); err != nil {
		errMsg = err.Error()
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	success = true
	c.JSON(http.StatusOK, &updatedCR)
}

// Patch 用 JSON Merge Patch（默认）或 JSON Patch（?patchType=json）更新自定义资源：
// 只提交要改的字段，避免整对象 PUT 在并发编辑时互相覆盖。
// CRD 不支持 strategic-merge patch，所以不提供该选项。
func (h *CRHandler) Patch(c *gin.Context) {
	crdName := c.Param("crd")
	name := c.Param("name")

	if crdName == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "CRD name and resource name are required"})
		return
	}

	cs := c.MustGet("cluster").(*cluster.ClientSet)
	ctx := c.Request.Context()

	patchBytes, err := c.GetRawData()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read patch data"})
		return
	}

	patchType := types.MergePatchType
	if c.Query("patchType") == "json" {
		patchType = types.JSONPatchType
	}

	// 获取 CRD 定义
	crd, err := h.getCRDByName(ctx, cs.K8sClient, crdName)
	if err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "CustomResourceDefinition not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !validateCRNamespace(c, crd) {
		return
	}

	// 依据 CRD 构造 GVR
	gvr := h.getGVRFromCRD(crd)

	// 先读取已存在的自定资源
	existingCR := &unstructured.Unstructured{}
	existingCR.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   gvr.Group,
		Version: gvr.Version,
		Kind:    crd.Spec.Names.Kind,
	})

	var namespacedName types.NamespacedName
	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped {
		namespace := c.Param("namespace")
		if namespace == common.AllNamespaces {
			c.JSON(http.StatusBadRequest, gin.H{"error": "This custom resource is namespace-scoped, use /:crd/:namespace/:name endpoint"})
			return
		}
		if namespace == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required for namespaced custom resources"})
			return
		}
		namespacedName = types.NamespacedName{Namespace: namespace, Name: name}
	} else {
		namespacedName = types.NamespacedName{Name: name}
	}

	if err := cs.K8sClient.Get(ctx, namespacedName, existingCR); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Custom resource not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	previousCR := existingCR.DeepCopy()
	var success bool
	var errMsg string
	defer func() {
		h.recordHistory(c, crd, "patch", previousCR, existingCR, success, errMsg)
	}()

	if err := cs.K8sClient.Patch(ctx, existingCR, client.RawPatch(patchType, patchBytes)); err != nil {
		errMsg = err.Error()
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	success = true
	c.JSON(http.StatusOK, existingCR)
}

func (h *CRHandler) ListHistory(c *gin.Context) {
	if rejectUnsupportedResourceHistory(c) {
		return
	}
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	ctx := c.Request.Context()
	crdName := c.Param("crd")
	resourceName := c.Param("name")
	namespace := c.Param("namespace")

	if crdName == "" || resourceName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "CRD name and resource name are required"})
		return
	}

	crd, err := h.getCRDByName(ctx, cs.K8sClient, crdName)
	if err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "CustomResourceDefinition not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped && (namespace == "" || namespace == common.AllNamespaces) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required for namespaced custom resources"})
		return
	}

	pageSize, err := strconv.Atoi(c.DefaultQuery("pageSize", "10"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pageSize parameter"})
		return
	}
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid page parameter"})
		return
	}

	baseQuery := func() *gorm.DB {
		query := model.DB.Model(&model.ResourceHistory{}).
			Where("cluster_name = ? AND resource_type = ? AND resource_name = ?", cs.Name, crd.Name, resourceName)
		if crd.Spec.Scope == apiextensionsv1.NamespaceScoped {
			return query.Where("namespace = ?", namespace)
		}
		return query.Where("namespace IN ?", []string{"", common.AllNamespaces})
	}

	var total int64
	if err := baseQuery().Count(&total).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	history := []model.ResourceHistory{}
	if err := baseQuery().Preload("Operator", func(db *gorm.DB) *gorm.DB {
		return db.Select("id", "username", "provider")
	}).Order("created_at DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&history).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	totalPages := int(math.Ceil(float64(total) / float64(pageSize)))
	hasNextPage := page < totalPages
	hasPrevPage := page > 1

	c.JSON(http.StatusOK, gin.H{
		"data": history,
		"pagination": gin.H{
			"page":        page,
			"pageSize":    pageSize,
			"total":       total,
			"totalPages":  totalPages,
			"hasNextPage": hasNextPage,
			"hasPrevPage": hasPrevPage,
		},
	})
}

func (h *CRHandler) Delete(c *gin.Context) {
	crdName := c.Param("crd")
	name := c.Param("name")

	if crdName == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "CRD name and resource name are required"})
		return
	}

	ctx := c.Request.Context()
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	// 获取 CRD 定义
	crd, err := h.getCRDByName(ctx, cs.K8sClient, crdName)
	if err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "CustomResourceDefinition not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !validateCRNamespace(c, crd) {
		return
	}

	// 依据 CRD 构造 GVR
	gvr := h.getGVRFromCRD(crd)

	// 构造用于删除的 unstructured 对象
	cr := &unstructured.Unstructured{}
	cr.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   gvr.Group,
		Version: gvr.Version,
		Kind:    crd.Spec.Names.Kind,
	})

	var namespacedName types.NamespacedName
	if crd.Spec.Scope == apiextensionsv1.NamespaceScoped {
		namespace := c.Param("namespace")
		if namespace == common.AllNamespaces {
			c.JSON(http.StatusBadRequest, gin.H{"error": "This custom resource is namespace-scoped, use /:crd/:namespace/:name endpoint"})
			return
		}
		if namespace == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required for namespaced custom resources"})
			return
		}
		namespacedName = types.NamespacedName{Namespace: namespace, Name: name}
		cr.SetNamespace(namespace)
	} else {
		namespacedName = types.NamespacedName{Name: name}
	}
	cr.SetName(name)

	// 先检查该资源是否存在
	if err := cs.K8sClient.Get(ctx, namespacedName, cr); err != nil {
		if errors.IsNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Custom resource not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	forceDelete := c.Query("force") == "true"

	opts := &client.DeleteOptions{
		PropagationPolicy: &[]metav1.DeletionPropagation{metav1.DeletePropagationBackground}[0],
	}
	if forceDelete {
		gracePeriodSeconds := int64(0)
		opts.GracePeriodSeconds = &gracePeriodSeconds
	}

	previousCR := cr.DeepCopy()
	var success bool
	var errMsg string
	defer func() {
		h.recordHistory(c, crd, "delete", previousCR, nil, success, errMsg)
	}()

	if err := cs.K8sClient.Delete(ctx, cr, opts); err != nil {
		errMsg = err.Error()
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if wait := c.Query("wait") != "false"; wait {
		timeout := 1 * time.Minute
		if forceDelete {
			timeout = 3 * time.Second
		}
		err := kube.WaitForResourceDeletion(ctx, cs.K8sClient, cr, timeout)
		if err != nil {
			if forceDelete {
				cr.SetFinalizers([]string{})
				if err := cs.K8sClient.Update(ctx, cr); err != nil {
					klog.Errorf("Failed to remove finalizers for %s/%s: %v", cr.GetNamespace(), cr.GetName(), err)
				}
				err = kube.WaitForResourceDeletion(ctx, cs.K8sClient, cr, 1*time.Second)
				if err == nil {
					success = true
					return
				}
			}
			errMsg = err.Error()
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	success = true
	c.JSON(http.StatusOK, gin.H{"message": "Custom resource deleted successfully"})
}

func (h *CRHandler) Describe(c *gin.Context) {
	crdName := c.Param("crd")
	name := c.Param("name")
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	ctx := c.Request.Context()

	crd, err := h.getCRDByName(ctx, cs.K8sClient, crdName)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !validateCRNamespace(c, crd) {
		return
	}

	gvr := h.getGVRFromCRD(crd)

	// 为 GenericDescriberFor 构造 RESTMapping
	gvk := schema.GroupVersionKind{
		Group:   gvr.Group,
		Version: gvr.Version,
		Kind:    crd.Spec.Names.Kind,
	}

	mapping := &meta.RESTMapping{
		Resource:         gvr,
		GroupVersionKind: gvk,
		Scope:            meta.RESTScopeNamespace,
	}
	if crd.Spec.Scope == apiextensionsv1.ClusterScoped {
		mapping.Scope = meta.RESTScopeRoot
	}
	describer, ok := describe.GenericDescriberFor(mapping, cs.K8sClient.Configuration)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create describer"})
		return
	}
	namespace := c.Param("namespace")
	out, err := describer.Describe(namespace, name, describe.DescriberSettings{
		ShowEvents: true,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"result": out})
}
