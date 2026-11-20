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
	// Password 只用于兼容尚未升级的客户端/工具；新版前端发送 PasswordEnc。
	// 这里不能加 binding:"required"：只加密文时明文字段必然为空。
	Password string `json:"password"`
	// PasswordEnc 是口令的 RSA-OAEP 密文（见 pkg/transportkey）。
	PasswordEnc string `json:"password_enc"`
	MFACode     string `json:"mfa_code"`
	// MFACodeEnc 是动态码的密文；动态码同样是 60 秒内可用的凭据。
	MFACodeEnc string `json:"mfa_code_enc"`
	// CaptchaToken / CaptchaCode 在安全策略启用时
	// 携带登录验证码。
	CaptchaToken string `json:"captcha_token"`
	CaptchaCode  string `json:"captcha_code"`
}

type ImportClustersRequest struct {
	Config    string `json:"config"`
	InCluster bool   `json:"inCluster"`
	// Slugs 按 context name 逐行指定 URL 短名（/_clusters/<slug>/... 用）；
	// 未指定的 context 走自动生成。整批校验失败则一条都不写。
	Slugs map[string]string `json:"slugs,omitempty"`
}

type ClusterInfo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version"`
	IsDefault   bool   `json:"isDefault"`
	Error       string `json:"error,omitempty"`
	// DNSDomain 是集群的 DNS 服务域（从 coredns Corefile 解析，见 cluster.ClientSet
	// 的 DNSDomain）：工作负载详情用它拼集群内可解析的域名。解析失败时省略，
	// 前端回落 cluster.local。
	DNSDomain string `json:"dnsDomain,omitempty"`
	// Slug 是集群在浏览器地址里的稳定短名（注意：与 API 路径 /_clusters/<集群名>
	// 同形不同源，后者是编码后的集群名，见方案文档 §3.1）。
	Slug string `json:"slug,omitempty"`
	// Stale 表示该集群的数据可能已过期：平台距最后一次成功访问它的 API server
	// 已超过陈旧阈值，或 informer 的 watch 刚报过错。仅供提示，不影响可用性判定。
	Stale bool `json:"stale,omitempty"`
	// StaleSince 是最后一次成功访问该集群 API server 的时间（RFC3339）。
	// 语义是「此后拿到的数据可能不新」，从未成功访问过时为空。
	StaleSince  string `json:"staleSince,omitempty"`
	StaleReason string `json:"staleReason,omitempty"`
	// 集群徽章（见 model.Cluster）：只有启用了徽章的集群才下发，
	// 未启用时字段整体省略，前端据此决定是否展示。
	BadgeEnabled            bool   `json:"badgeEnabled,omitempty"`
	BadgeText               string `json:"badgeText,omitempty"`
	BadgeTextSize           string `json:"badgeTextSize,omitempty"`
	BadgeBold               bool   `json:"badgeBold,omitempty"`
	BadgeColor              string `json:"badgeColor,omitempty"`
	BadgeTextColor          string `json:"badgeTextColor,omitempty"`
	BadgeIconEnabled        bool   `json:"badgeIconEnabled,omitempty"`
	BadgeIconText           string `json:"badgeIconText,omitempty"`
	BadgeIconTextSize       string `json:"badgeIconTextSize,omitempty"`
	BadgeIconTextColor      string `json:"badgeIconTextColor,omitempty"`
	BadgeIconTextBackground string `json:"badgeIconTextBackground,omitempty"`
	BadgeIconBold           bool   `json:"badgeIconBold,omitempty"`
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
