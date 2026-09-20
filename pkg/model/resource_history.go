package model

import (
	"time"
)

// ResourceHistory 是一条审计记录。它记录了操作者、时间、对象、结果与来源，
// 且一旦写入就不再修改（没有任何更新/删除它的接口）。
//
// CreatedAt 除与 cluster_name 等列组成的复合索引外还有一个单列索引：列表默认「不限
// 集群 + 按时间倒序 + 时间窗筛选」、保留策略也只按 created_at 过滤，而复合索引的首列
// 是 cluster_name，这两种查询都用不上它。
type ResourceHistory struct {
	ID          uint      `json:"id" gorm:"primarykey"`
	CreatedAt   time.Time `json:"createdAt" gorm:"index:idx_resource_histories_lookup_with_time,priority:5,sort:desc;index:idx_resource_histories_created_at,sort:desc"`
	UpdatedAt   time.Time `json:"updatedAt"`
	ClusterName string    `json:"clusterName" gorm:"type:varchar(100);not null;index:idx_resource_histories_lookup_with_time,priority:1"`

	ResourceType string `json:"resourceType" gorm:"type:varchar(255);not null;index:idx_resource_histories_lookup_with_time,priority:2"`
	ResourceName string `json:"resourceName" gorm:"type:varchar(255);not null;index:idx_resource_histories_lookup_with_time,priority:3"`
	Namespace    string `json:"namespace" gorm:"type:varchar(100);index:idx_resource_histories_lookup_with_time,priority:4"`

	OperationType   string `json:"operationType" gorm:"type:varchar(50);not null;index"`
	OperationSource string `json:"operationSource" gorm:"type:varchar(20);not null;default:'manual';index"`

	ResourceYAML LongText `json:"resourceYaml"`
	PreviousYAML LongText `json:"previousYaml"`

	Success      bool   `json:"success" gorm:"type:boolean"`
	ErrorMessage string `json:"errorMessage" gorm:"type:text"`

	// ClientIP / UserAgent 记录事件来源（等保三级安全审计）：审计记录必须能追溯到
	// 发起方与所用客户端。两者都取自请求，未经过 HTTP 的写入（定时任务、AI 工具）
	// 会留空。
	ClientIP  string `json:"clientIp" gorm:"type:varchar(64);index"`
	UserAgent string `json:"userAgent" gorm:"type:varchar(255)"`

	// OperatorID 指向操作者，用于按人筛选。账号被删除时置空（SET NULL）而不是
	// 级联删除记录：审计记录必须独立于被审计对象存在（等保三级安全审计要求）。
	OperatorID *uint `json:"operatorId" gorm:"index"`
	Operator   *User `json:"operator" gorm:"foreignKey:OperatorID;constraint:OnDelete:SET NULL"`
	// OperatorName 是写入时的操作者用户名快照：即使账号后来被删除或改名，
	// 审计记录仍能追溯到具体的人。
	OperatorName string `json:"operatorName" gorm:"type:varchar(255);index"`
}

// OperatorRef 返回操作者 ID 的可空引用，供资源历史写入使用。
func OperatorRef(id uint) *uint {
	return &id
}

func (ResourceHistory) TableName() string {
	return "resource_histories"
}
