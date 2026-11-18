package model

type Cluster struct {
	Model
	Name                   string       `json:"name" gorm:"type:varchar(100);uniqueIndex;not null"`
	Description            string       `json:"description" gorm:"type:text"`
	Config                 SecretString `json:"config" gorm:"type:text"`
	PrometheusURL          string       `json:"prometheus_url,omitempty" gorm:"type:text"`
	InCluster              bool         `json:"in_cluster" gorm:"type:boolean;default:false"`
	ClusterAgent           bool         `json:"clusterAgent" gorm:"type:boolean;default:false"`
	ClusterAgentTokenHash  string       `json:"-" gorm:"type:varchar(64);index"`
	ClusterAgentPublicKey  string       `json:"-" gorm:"type:varchar(64)"`
	ClusterAgentPrivateKey SecretString `json:"-" gorm:"type:text"`
	IsDefault              bool         `json:"is_default" gorm:"type:boolean;default:false"`
	Enable                 bool         `json:"enable" gorm:"type:boolean;default:true"`

	// 集群徽章：多集群下光看名字分不清用途，用一段短说明（如「测试环境」）+
	// 背景色把集群标出来，展示在顶栏、「当前集群」标签与集群管理列表上。
	// BadgeText 的列宽留余量只是容量考虑：口径由 pkg/cluster 的 validateClusterBadge
	// 收到 16 个字符（界面按整段展示，不截断），收窄列宽反而会让老数据在 AutoMigrate
	// 时出错。
	BadgeEnabled bool   `json:"badge_enabled" gorm:"type:boolean;default:false"`
	BadgeText    string `json:"badge_text" gorm:"type:varchar(32)"`
	// BadgeTextSize 是徽章说明的字号档位（sm / md / lg）。空值等同 md——列不设
	// default，老行的零值就直接按默认档渲染，升级时不需要回填。
	// 取值由 validateClusterBadge 收口，不认识的档位直接 400。
	BadgeTextSize string `json:"badge_text_size" gorm:"type:varchar(8)"`
	// BadgeBold 控制徽章说明是否加粗。
	BadgeBold bool `json:"badge_bold" gorm:"type:boolean;default:false"`
	// BadgeColor 是徽章说明的背景色，也是图标文本在未单独设底色时的默认底色。
	BadgeColor string `json:"badge_color" gorm:"type:varchar(16)"`
	// BadgeTextColor 是说明文本的字色；空值 = 按 BadgeColor 自动取黑/白字。
	BadgeTextColor   string `json:"badge_text_color" gorm:"type:varchar(16)"`
	BadgeIconEnabled bool   `json:"badge_icon_enabled" gorm:"type:boolean;default:false"`
	BadgeIconText    string `json:"badge_icon_text" gorm:"type:varchar(8)"`
	// 图标文本自己的排版（与徽章说明的 BadgeTextSize / BadgeBold 互不影响）：
	// BadgeIconTextSize 空值 = 按所在位置自动取尺寸（历史行为），否则 sm/md/lg；
	// BadgeIconTextColor 空值 = 按底色自动取黑/白字；
	// BadgeIconTextBackground 空值 = 用徽章背景色（BadgeColor）；
	// BadgeIconBold 控制是否加粗。
	BadgeIconTextSize       string `json:"badge_icon_text_size" gorm:"type:varchar(8)"`
	BadgeIconTextColor      string `json:"badge_icon_text_color" gorm:"type:varchar(16)"`
	BadgeIconTextBackground string `json:"badge_icon_text_background" gorm:"type:varchar(16)"`
	BadgeIconBold           bool   `json:"badge_icon_bold" gorm:"type:boolean;default:false"`
	// BadgeIconURL 指向管理员上传的图标（见 ClusterBadgeIcon）。空 = 没有上传过，
	// 图标位回落到 BadgeIconText。
	//
	// 列宽留有余量只是容量考虑，实际写入的是 cluster.BadgeIconPath 生成的短路径。
	// 它只能由上传/删除图标的接口维护，不接受业务请求体直接写——否则那条路径会
	// 与「有字节行 ⇔ URL 指向它」的不变式脱钩（见 cluster_badge_icon.go）。
	BadgeIconURL string `json:"badge_icon_url" gorm:"type:varchar(255)"`

	// Slug 是集群在浏览器地址（/_clusters/<slug>/...）里的稳定短名：创建时固化，
	// 此后不随集群改名变化（已分享的链接优先于可读性）。
	// 列可空且无 default：旧行为 NULL，由 MigrateClusterSlugBackfill 回填；多行 NULL
	// 在 SQLite/MySQL/PostgreSQL 的唯一索引下都合法，不能改成 default ''（R9）。
	Slug *string `json:"slug" gorm:"type:varchar(64);uniqueIndex"`

	// 写操作二次确认：按操作**类别**分别开关，默认全关——升级后行为完全不变，
	// 由管理员在「系统设置 → 集群 → 操作确认」里逐项开启。
	//
	// 判定发生在请求提交给 k8s **之前**，由前端做（见 ui/src/lib/operation-confirm.ts）：
	// 它防的是误触，不是绕过；真要绕过时 RBAC 与 AdminAudit 仍然照常拦与记。
	// 因此这里只是配置位，服务端不参与拦截。
	//
	// 归类口径（与前端 lib/write-operation.ts 的映射表一一对应，改一处要改两处）：
	//   create 新增：创建资源、YAML apply、Helm 安装
	//   update 修改：编辑、标签/注解/镜像、扩缩容、暂停恢复、Pod 改规格、Helm 升级与回滚
	//   delete 删除：单个/批量/强制删除、删除命名空间与节点、Helm 卸载
	//   restart 重启：工作负载 rollout restart（与普通修改同 URL，靠请求体区分，前端显式标注）
	//   nodeMaintenance 节点维护：cordon / uncordon / drain / taint / untaint
	ConfirmCreate          bool `json:"confirm_create" gorm:"type:boolean;default:false"`
	ConfirmUpdate          bool `json:"confirm_update" gorm:"type:boolean;default:false"`
	ConfirmDelete          bool `json:"confirm_delete" gorm:"type:boolean;default:false"`
	ConfirmRestart         bool `json:"confirm_restart" gorm:"type:boolean;default:false"`
	ConfirmNodeMaintenance bool `json:"confirm_node_maintenance" gorm:"type:boolean;default:false"`
}

func AddCluster(cluster *Cluster) error {
	return DB.Create(cluster).Error
}

func GetClusterByName(name string) (*Cluster, error) {
	var cluster Cluster
	if err := DB.Where("name = ?", name).First(&cluster).Error; err != nil {
		return nil, err
	}
	return &cluster, nil
}

func GetClusterBySlug(slug string) (*Cluster, error) {
	var cluster Cluster
	if err := DB.Where("slug = ?", slug).First(&cluster).Error; err != nil {
		return nil, err
	}
	return &cluster, nil
}

func GetClusterByID(id uint) (*Cluster, error) {
	var cluster Cluster
	if err := DB.First(&cluster, id).Error; err != nil {
		return nil, err
	}
	return &cluster, nil
}

func GetClusterByClusterAgentTokenHash(hash string) (*Cluster, error) {
	var cluster Cluster
	if err := DB.Where("cluster_agent_token_hash = ?", hash).First(&cluster).Error; err != nil {
		return nil, err
	}
	return &cluster, nil
}

func UpdateCluster(cluster *Cluster, updates map[string]interface{}) error {
	return DB.Model(cluster).Updates(updates).Error
}

func DeleteCluster(cluster *Cluster) error {
	if err := DB.Delete(cluster).Error; err != nil {
		return err
	}
	// 图标字节以 cluster_id 为主键单独成表，集群行删掉后它就再也取不到了：
	// 在同一次操作里清掉，避免残留孤儿 blob（集群重新导入会拿到新的 id）。
	if err := DeleteClusterBadgeIcon(cluster.ID); err != nil {
		return err
	}
	return nil
}

func ClearDefaultCluster() error {
	return DB.Model(&Cluster{}).Where("is_default = ?", true).Update("is_default", false).Error
}

func DisableCluster(cluster *Cluster) error {
	return DB.Model(cluster).Update("enable", false).Error
}

func EnableCluster(cluster *Cluster) error {
	return DB.Model(cluster).Update("enable", true).Error
}

func ListClusters() ([]*Cluster, error) {
	var clusters []*Cluster
	if err := DB.Find(&clusters).Error; err != nil {
		return nil, err
	}
	return clusters, nil
}

func CountClusters() (count int64, err error) {
	return count, DB.Model(&Cluster{}).Count(&count).Error
}
