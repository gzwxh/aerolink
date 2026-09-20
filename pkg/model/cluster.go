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
	BadgeEnabled     bool   `json:"badge_enabled" gorm:"type:boolean;default:false"`
	BadgeText        string `json:"badge_text" gorm:"type:varchar(32)"`
	BadgeColor       string `json:"badge_color" gorm:"type:varchar(16)"`
	BadgeIconEnabled bool   `json:"badge_icon_enabled" gorm:"type:boolean;default:false"`
	BadgeIconText    string `json:"badge_icon_text" gorm:"type:varchar(8)"`
	// BadgeIconURL 指向管理员上传的图标（见 ClusterBadgeIcon）。空 = 没有上传过，
	// 图标位回落到 BadgeIconText。
	//
	// 列宽留有余量只是容量考虑，实际写入的是 cluster.BadgeIconPath 生成的短路径。
	// 它只能由上传/删除图标的接口维护，不接受业务请求体直接写——否则那条路径会
	// 与「有字节行 ⇔ URL 指向它」的不变式脱钩（见 cluster_badge_icon.go）。
	BadgeIconURL string `json:"badge_icon_url" gorm:"type:varchar(255)"`
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
