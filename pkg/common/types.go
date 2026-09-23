package common

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type SearchResult struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Namespace    string `json:"namespace,omitempty"`
	ResourceType string `json:"resourceType"`
	CreatedAt    string `json:"createdAt"`
}

type RelatedResource struct {
	Type       string `json:"type"`
	APIVersion string `json:"apiVersion,omitempty"`
	Name       string `json:"name"`
	Namespace  string `json:"namespace,omitempty"`
}

type Resource struct {
	Allocatable int64 `json:"allocatable"`
	Requested   int64 `json:"requested"`
	Limited     int64 `json:"limited"`
}

type ResourceMetric struct {
	CPU Resource `json:"cpu,omitempty"`
	Mem Resource `json:"memory,omitempty"`
}

type PasswordLoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
	MFACode  string `json:"mfa_code"`
	// CaptchaToken / CaptchaCode 在安全策略启用时
	// 携带登录验证码。
	CaptchaToken string `json:"captcha_token"`
	CaptchaCode  string `json:"captcha_code"`
}

type ImportClustersRequest struct {
	Config    string `json:"config"`
	InCluster bool   `json:"inCluster"`
}

type ClusterInfo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version"`
	IsDefault   bool   `json:"isDefault"`
	Error       string `json:"error,omitempty"`
	// 集群徽章（见 model.Cluster）：只有启用了徽章的集群才下发，
	// 未启用时字段整体省略，前端据此决定是否展示。
	BadgeEnabled     bool   `json:"badgeEnabled,omitempty"`
	BadgeText        string `json:"badgeText,omitempty"`
	BadgeColor       string `json:"badgeColor,omitempty"`
	BadgeIconEnabled bool   `json:"badgeIconEnabled,omitempty"`
	BadgeIconText    string `json:"badgeIconText,omitempty"`
	// BadgeIconURL 只有上传过图标的集群才有；有它时前端优先显示图片，
	// 其次才是 BadgeIconText。
	BadgeIconURL string `json:"badgeIconUrl,omitempty"`
	// 写操作二次确认开关（见 model.Cluster 的 Confirm* 字段）。
	//
	// 必须随集群列表下发：前端在提交 k8s 写请求前要据此决定是否弹确认框，
	// 而它拿到的就是这份列表（见 ui/src/lib/current-cluster.ts 的缓存）。
	ConfirmCreate          bool `json:"confirmCreate,omitempty"`
	ConfirmUpdate          bool `json:"confirmUpdate,omitempty"`
	ConfirmDelete          bool `json:"confirmDelete,omitempty"`
	ConfirmRestart         bool `json:"confirmRestart,omitempty"`
	ConfirmNodeMaintenance bool `json:"confirmNodeMaintenance,omitempty"`
}

type MetricsCell struct {
	CPUUsage      int64 `json:"cpuUsage,omitempty"`
	CPULimit      int64 `json:"cpuLimit,omitempty"`
	CPURequest    int64 `json:"cpuRequest,omitempty"`
	MemoryUsage   int64 `json:"memoryUsage,omitempty"`
	MemoryLimit   int64 `json:"memoryLimit,omitempty"`
	MemoryRequest int64 `json:"memoryRequest,omitempty"`
	Pods          int64 `json:"pods,omitempty"`
	PodsLimit     int64 `json:"podsLimit,omitempty"`
}

type NodeWithMetrics struct {
	*corev1.Node `json:",inline"`
	Metrics      *MetricsCell `json:"metrics"`
}

type NodeListWithMetrics struct {
	Items           []*NodeWithMetrics `json:"items"`
	metav1.TypeMeta `json:",inline"`
	// 标准的列表元数据。
	// 更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds
	// +optional
	metav1.ListMeta `json:"metadata" protobuf:"bytes,1,opt,name=metadata"`
}
