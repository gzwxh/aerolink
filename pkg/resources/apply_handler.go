package resources

import (
	"bufio"
	"errors"
	"io"
	"net/http"
	"strings"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"aerolink/pkg/rbac"
	"github.com/gin-gonic/gin"
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

// resourceVersionConflictCode 是给前端的机器可读码。K8s 的冲突原文既长又不本地化，
// 界面按它换成「对象已被他人修改，请刷新后重试」（见 ui/src/lib/utils.ts 与 locales 的 errors.*）。
const resourceVersionConflictCode = "resource_version_conflict"

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
	// 一份多文档 YAML 里 K8s 没有跳对象事务：已建成的不会因后面的失败而回滚。
	// 以前碰到第一个失败就直接返回，界面只看到「失败」，不知道前面已经落了多少
	// 个对象（缺陷 D-12）。这里改成跟 kubectl apply 一样逐文档继续，最后把
	// 成功与失败两部分一起报出来。
	failedResources := make([]gin.H, 0)
	firstFailureStatus := 0
	firstFailureCode := ""
	firstFailureMessage := ""
	recordFailure := func(status int, code, message, kind, name, namespace string) {
		if firstFailureStatus == 0 {
			firstFailureStatus, firstFailureCode, firstFailureMessage = status, code, message
		}
		failedResources = append(failedResources, gin.H{
			"kind": kind, "name": name, "namespace": namespace, "error": message,
		})
	}

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
		// null 文档（含只有注释的分隔段）没有可应用的内容：跳过而不是报错。
		// 解析失败时忽略这里的错误，由后面的 decode 统一给出报错。
		var docValue interface{}
		if err := syaml.Unmarshal(rawDoc, &docValue); err == nil && docValue == nil {
			continue
		}

		obj := &unstructured.Unstructured{}
		_, _, err = decodeUniversal.Decode(rawDoc, nil, obj)
		if err != nil {
			klog.V(1).Infof("Failed to decode YAML: %v", err)
			recordFailure(http.StatusBadRequest, "", "Invalid YAML format: "+err.Error(), "", "", "")
			continue
		}
		if obj.GetKind() == "" || obj.GetName() == "" {
			recordFailure(http.StatusBadRequest, "", "YAML must include kind and metadata.name",
				obj.GetKind(), obj.GetName(), obj.GetNamespace())
			continue
		}

		gvk := obj.GroupVersionKind()
		mapping, err := cs.K8sClient.RESTMapper().RESTMapping(gvk.GroupKind(), gvk.Version)
		if err != nil {
			recordFailure(http.StatusBadRequest, "", err.Error(), obj.GetKind(), obj.GetName(), obj.GetNamespace())
			continue
		}
		authorizationNamespace := resolveApplyNamespace(obj, mapping, req.Namespace)
		resource := common.HistoryResourceType(mapping.Resource.Resource, mapping.Resource.Group)
		canCreate := rbac.CanAccess(user, resource, string(common.VerbCreate), cs.Name, authorizationNamespace)
		canUpdate := false
		if !canCreate {
			canUpdate = rbac.CanAccess(user, resource, string(common.VerbUpdate), cs.Name, authorizationNamespace)
		}
		if !canCreate && !canUpdate {
			recordFailure(http.StatusForbidden, "",
				rbac.NoAccess(user.Key(), string(common.VerbCreate), resource, authorizationNamespace, cs.Name),
				obj.GetKind(), obj.GetName(), obj.GetNamespace())
			continue
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
				recordFailure(http.StatusForbidden, "",
					rbac.NoAccess(user.Key(), string(common.VerbCreate), resource, authorizationNamespace, cs.Name),
					obj.GetKind(), obj.GetName(), obj.GetNamespace())
				continue
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
				recordFailure(http.StatusForbidden, "",
					rbac.NoAccess(user.Key(), string(common.VerbUpdate), resource, authorizationNamespace, cs.Name),
					obj.GetKind(), obj.GetName(), obj.GetNamespace())
				continue
			}
			// YAML 里写了 resourceVersion 就按它提交，让 K8s 有机会把并发编辑判成冲突；
			// 没写才拿服务端当前值补齐（等价于 kubectl apply 先用 live 对象填充 RV 再更新）。
			// 以前是无条件用 existingObj 的 RV 覆盖，那会把客户端的 RV 主动丢掉：
			// 两个用户各自打开 YAML 再提交，后提交者静默覆盖前一个，谁都不知道。
			if obj.GetResourceVersion() == "" {
				obj.SetResourceVersion(existingObj.GetResourceVersion())
			}
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
		applyHistory := model.ResourceHistory{
			ClusterName:   cs.Name,
			ResourceType:  resource,
			ResourceName:  obj.GetName(),
			Namespace:     obj.GetNamespace(),
			OperationType: "apply",
			// Secret 走 apply 时同样不能把 data/stringData 原值写进审计（缺陷 D-33）。
			ResourceYAML: model.LongText(redactSecretYAML(resource, docYAML)),
			PreviousYAML: model.LongText(redactSecretYAML(resource, string(previousYAML))),
			OperatorID:   model.OperatorRef(user.ID),
			OperatorName: user.Username,
			ClientIP:     c.ClientIP(),
			UserAgent:    common.AuditUserAgent(c.Request.UserAgent()),
			Success:      err == nil,
			ErrorMessage: errMessage,
		}
		_ = model.RecordAudit(c.Request.Context(), &applyHistory)

		if err != nil {
			recordFailure(applyErrorStatus(err), applyErrorCode(err),
				applyErrorMessage(operation, err), obj.GetKind(), obj.GetName(), obj.GetNamespace())
			continue
		}

		klog.Infof("Successfully applied resource: %s/%s", obj.GetKind(), obj.GetName())
		applied := gin.H{
			"kind":      obj.GetKind(),
			"name":      obj.GetName(),
			"namespace": obj.GetNamespace(),
		}
		appliedResources = append(appliedResources, applied)
	}

	// 有文档失败：状态码取第一个失败的类型，但把已落地与失败的对象一起带回去。
	// 明细放在 params 里，跟仓库已有的错误约定一致（ApiError 会把 code/params 透给界面），
	// 界面据此能说清「已下发几个、哪个失败」（缺陷 D-12）。
	if firstFailureStatus != 0 {
		payload := gin.H{
			"error": firstFailureMessage,
			"params": gin.H{
				"applied": appliedResources,
				"failed":  failedResources,
				"count":   len(appliedResources),
				"partial": len(appliedResources) > 0,
			},
		}
		if firstFailureCode != "" {
			payload["code"] = firstFailureCode
		}
		c.JSON(firstFailureStatus, payload)
		return
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

// applyErrorStatus / applyErrorCode / applyErrorMessage 把单个文档的失败映射成对外语义。
// 冲突不是服务端失败：客户端拿的已经是过期版本，回 409 才能让它知道要刷新。
// applyErrorStatus / applyErrorCode 共用 writeFailure：apply 的失败也要按
// apiserver 语义上报，而不是把非法值、不可变、已不存在一律说成 500（D-91）。
func applyErrorStatus(err error) int {
	status, _ := writeFailure(err)
	return status
}

func applyErrorCode(err error) string {
	_, code := writeFailure(err)
	return code
}

func applyErrorMessage(operation string, err error) string {
	switch operation {
	case "create":
		return "Failed to create resource: " + err.Error()
	case "update":
		return "Failed to update resource: " + err.Error()
	default:
		return "Failed to get resource: " + err.Error()
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
