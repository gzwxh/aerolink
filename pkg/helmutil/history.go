package helmutil

import (
	"context"

	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
	release "helm.sh/helm/v4/pkg/release/v1"
	"k8s.io/klog/v2"
)

// RecordReleaseHistory 写入一条 Helm release 的操作审计。clientIP / userAgent 为
// 发起方信息（等保三级安全审计）；自动升级等没有 HTTP 请求的场景传空字符串。
func RecordReleaseHistory(clusterName string, operatorID uint, source, opType, name, namespace, clientIP, userAgent string, prev, curr *release.Release, success bool, err error) {
	if curr != nil {
		name = curr.Name
		namespace = curr.Namespace
	} else if prev != nil {
		name = prev.Name
		namespace = prev.Namespace
	}

	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	resourceYAML := ReleaseToYAML(curr)
	if opType == "delete" {
		resourceYAML = ""
	}
	// OperatorName 走写入时的快照；这里只知道 ID，需要时补查一次（自动升级
	// 任务只有 CreatorID）。
	operatorName := ""
	if operatorID != 0 {
		if user, uerr := model.GetUserByID(uint64(operatorID)); uerr == nil && user != nil {
			operatorName = user.Username
		}
	}
	history := model.ResourceHistory{
		ClusterName:     clusterName,
		ResourceType:    string(common.HelmReleases),
		ResourceName:    name,
		Namespace:       namespace,
		OperationType:   opType,
		OperationSource: source,
		ResourceYAML:    model.LongText(resourceYAML),
		PreviousYAML:    model.LongText(ReleaseToYAML(prev)),
		Success:         success,
		ErrorMessage:    errMsg,
		ClientIP:        clientIP,
		UserAgent:       common.AuditUserAgent(userAgent),
		OperatorID:      model.OperatorRef(operatorID),
		OperatorName:    operatorName,
	}
	// 自动升级等非 HTTP 场景没有请求上下文：传 context.TODO()（与传 nil 行为一致）。
	if err := model.RecordAudit(context.TODO(), &history); err != nil {
		klog.Errorf("Failed to create helm release history: %v", err)
	}
}
