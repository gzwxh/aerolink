package resources

import (
	"bufio"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	serializeryaml "k8s.io/apimachinery/pkg/runtime/serializer/yaml"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/klog/v2"
	"sigs.k8s.io/controller-runtime/pkg/client"
	syaml "sigs.k8s.io/yaml"
)

type ResourceApplyHandler struct {
}

func NewResourceApplyHandler() *ResourceApplyHandler {
	return &ResourceApplyHandler{}
}

type ApplyResourceRequest struct {
	YAML      string `json:"yaml" binding:"required"`
	Namespace string `json:"namespace"`
}

// ApplyResource 把一个或多个 YAML 资源应用到集群
func (h *ResourceApplyHandler) ApplyResource(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	user := c.MustGet("user").(model.User)

	var req ApplyResourceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx := c.Request.Context()
	decodeUniversal := serializeryaml.NewDecodingSerializer(unstructured.UnstructuredJSONScheme)
	reader := utilyaml.NewYAMLReader(bufio.NewReader(strings.NewReader(req.YAML)))
	appliedResources := make([]gin.H, 0, 1)

	for {
		rawDoc, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			klog.V(1).Infof("Failed to read YAML document: %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid YAML format: " + err.Error()})
			return
		}

		docYAML := strings.TrimSpace(string(rawDoc))
		if docYAML == "" {
			continue
		}

		obj := &unstructured.Unstructured{}
		_, _, err = decodeUniversal.Decode(rawDoc, nil, obj)
		if err != nil {
			klog.V(1).Infof("Failed to decode YAML: %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid YAML format: " + err.Error()})
			return
		}
		if obj.GetKind() == "" || obj.GetName() == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "YAML must include kind and metadata.name"})
			return
		}

		gvk := obj.GroupVersionKind()
		mapping, err := cs.K8sClient.RESTMapper().RESTMapping(gvk.GroupKind(), gvk.Version)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		authorizationNamespace := resolveApplyNamespace(obj, mapping, req.Namespace)
		resource := common.HistoryResourceType(mapping.Resource.Resource, mapping.Resource.Group)
		canCreate := rbac.CanAccess(user, resource, string(common.VerbCreate), cs.Name, authorizationNamespace)
		canUpdate := false
		if !canCreate {
			canUpdate = rbac.CanAccess(user, resource, string(common.VerbUpdate), cs.Name, authorizationNamespace)
		}
		if !canCreate && !canUpdate {
			c.JSON(http.StatusForbidden, gin.H{
				"error": rbac.NoAccess(user.Key(), string(common.VerbCreate), resource, authorizationNamespace, cs.Name)})
			return
		}

		existingObj := &unstructured.Unstructured{}
		existingObj.SetGroupVersionKind(obj.GetObjectKind().GroupVersionKind())
		existingObj.SetName(obj.GetName())
		existingObj.SetNamespace(obj.GetNamespace())

		err = cs.K8sClient.Get(ctx, client.ObjectKey{
			Name:      obj.GetName(),
			Namespace: obj.GetNamespace(),
		}, existingObj)

		operation := "get"
		switch {
		case apierrors.IsNotFound(err):
			operation = "create"
			if !canCreate {
				c.JSON(http.StatusForbidden, gin.H{
					"error": rbac.NoAccess(user.Key(), string(common.VerbCreate), resource, authorizationNamespace, cs.Name)})
				return
			}
			err = cs.K8sClient.Create(ctx, obj)
			if err != nil {
				klog.Errorf("Failed to create resource: %v", err)
			}
		case err == nil:
			operation = "update"
			if !canUpdate {
				canUpdate = rbac.CanAccess(user, resource, string(common.VerbUpdate), cs.Name, authorizationNamespace)
			}
			if !canUpdate {
				c.JSON(http.StatusForbidden, gin.H{
					"error": rbac.NoAccess(user.Key(), string(common.VerbUpdate), resource, authorizationNamespace, cs.Name)})
				return
			}
			obj.SetResourceVersion(existingObj.GetResourceVersion())
			err = cs.K8sClient.Update(ctx, obj)
			if err != nil {
				klog.Errorf("Failed to update resource: %v", err)
			}
		default:
			klog.Errorf("Failed to get resource: %v", err)
		}

		previousYAML := []byte{}
		if existingObj.GetResourceVersion() != "" {
			existingObj.SetManagedFields(nil)
			previousYAML, _ = syaml.Marshal(existingObj)
		}
		errMessage := ""
		if err != nil {
			errMessage = err.Error()
		}
		model.DB.Create(&model.ResourceHistory{
			ClusterName:   cs.Name,
			ResourceType:  resource,
			ResourceName:  obj.GetName(),
			Namespace:     obj.GetNamespace(),
			OperationType: "apply",
			ResourceYAML:  model.LongText(docYAML),
			PreviousYAML:  model.LongText(string(previousYAML)),
			OperatorID:    model.OperatorRef(user.ID),
			OperatorName:  user.Username,
			ClientIP:      c.ClientIP(),
			UserAgent:     common.AuditUserAgent(c.Request.UserAgent()),
			Success:       err == nil,
			ErrorMessage:  errMessage,
		})

		if err != nil {
			respondApplyError(c, operation, err)
			return
		}

		klog.Infof("Successfully applied resource: %s/%s", obj.GetKind(), obj.GetName())
		applied := gin.H{
			"kind":      obj.GetKind(),
			"name":      obj.GetName(),
			"namespace": obj.GetNamespace(),
		}
		appliedResources = append(appliedResources, applied)
	}

	if len(appliedResources) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No valid resource YAML found"})
		return
	}
	if len(appliedResources) == 1 {
		payload := gin.H{"message": "Resource applied successfully"}
		for key, value := range appliedResources[0] {
			payload[key] = value
		}
		c.JSON(http.StatusOK, payload)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":   "Resources applied successfully",
		"count":     len(appliedResources),
		"resources": appliedResources,
	})
}

// respondApplyError 把 apply 过程中的错误按操作类型映射为响应。
func respondApplyError(c *gin.Context, operation string, err error) {
	switch operation {
	case "create":
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create resource: " + err.Error()})
	case "update":
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update resource: " + err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get resource: " + err.Error()})
	}
}

// resolveApplyNamespace 决定对象按哪个命名空间做授权，并把命名空间落到对象上：
// 集群级资源按 _all 授权并清空命名空间；否则请求显式指定的命名空间优先，未指定时
// 沿用 YAML 里的值。
func resolveApplyNamespace(obj *unstructured.Unstructured, mapping *meta.RESTMapping, namespaceOverride string) string {
	if mapping.Scope.Name() == meta.RESTScopeNameRoot {
		obj.SetNamespace("")
		return common.AllNamespaces
	}
	if namespaceOverride != "" {
		obj.SetNamespace(namespaceOverride)
		return namespaceOverride
	}
	return obj.GetNamespace()
}
