// 各自的不变式也不同（见下）；为了消掉相似度而把它们抽象成一张泛型 blob 表，会把「谁拥有这行字节」
// 这个与安全相关的约束藏进参数里，反而更难审阅。
//
//nolint:dupl // 与 user_avatar.go 结构相同是有意为之：两者是两张独立的表（不同主体、不同主键列与类型），
package model

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ClusterBadgeIcon 是管理员为集群上传的徽章图标字节（一个集群最多一行）。
//
// 单独成表而不是把 data: URL 塞进 clusters.badge_icon_url：clusters 行会被集群
// 列表、集群同步等路径整行读取，混进最大 1 MiB 的 blob 会拖慢这些高频路径。
// 字节只在 GET /api/clusters/:id/badge-icon 时按主键取一次。
//
// 不变式：这一行存在的当前提是 clusters.badge_icon_url 正指向它
// （见 cluster.BadgeIconPath）。写 badge_icon_url 的只有上传与删除图标两条路径，
// 它们必须成对维护，否则会留下永远取不到的孤儿行。
type ClusterBadgeIcon struct {
	// autoIncrement:false：主键是「集群 id」而不是自增列，
	// 否则 MySQL / PostgreSQL 会额外挂一个 AUTO_INCREMENT / 序列。
	ClusterID uint `gorm:"primaryKey;autoIncrement:false" json:"cluster_id"`
	// ContentType 只可能是白名单里的值（image/png、image/jpeg），
	// 由内容嗅探得出，不采用客户端声明的类型。
	ContentType string `gorm:"type:varchar(50);not null" json:"content_type"`
	// Data 用 []byte 而不是带 type 标签的列：GORM 会按方言落成
	// longblob（MySQL）/ bytea（PostgreSQL）/ blob（SQLite）。
	Data []byte `gorm:"not null" json:"-"`
	// Size 是 len(Data) 的冗余副本，用于在不读 blob 的前提下统计与生成 ETag。
	Size int64 `gorm:"not null" json:"size"`
	// ContentHash 是图片字节的哈希，拼进 URL（?v=<hash>）作为浏览器缓存键。
	//
	// 用内容哈希而不是自增版本号：删除图标会删掉整行，自增号会从 1 重新开始，
	// 于是「删掉再传一张新的」会拿到与历史某次相同的 URL —— 而那是 1 年强缓存的
	// URL，浏览器会继续显示旧图。内容寻址没有这个问题。
	ContentHash string    `gorm:"type:varchar(64);not null" json:"content_hash"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// GetClusterBadgeIcon 读取某个集群上传的图标；没上传过时返回 gorm.ErrRecordNotFound。
func GetClusterBadgeIcon(clusterID uint) (*ClusterBadgeIcon, error) {
	if clusterID == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var icon ClusterBadgeIcon
	if err := DB.First(&icon, "cluster_id = ?", clusterID).Error; err != nil {
		return nil, err
	}
	return &icon, nil
}

// clusterBadgeIconContentHash 取字节的 SHA-256 前 16 个十六进制字符。
// 64 位足够避免集群图标之间的碰撞，URL 也不至于太长。
func clusterBadgeIconContentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:16]
}

// SaveClusterBadgeIcon 写入（或替换）图标字节并返回其内容哈希。
func SaveClusterBadgeIcon(clusterID uint, contentType string, data []byte) (string, error) {
	if clusterID == 0 {
		return "", errors.New("cluster id is required")
	}

	icon := ClusterBadgeIcon{
		ClusterID:   clusterID,
		ContentType: contentType,
		Data:        data,
		Size:        int64(len(data)),
		ContentHash: clusterBadgeIconContentHash(data),
	}
	// 主键是 cluster_id：一条 upsert 同时覆盖「第一次上传」与「替换」两种情况。
	err := DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "cluster_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"content_type", "data", "size", "content_hash", "updated_at"}),
	}).Create(&icon).Error
	if err != nil {
		return "", err
	}
	return icon.ContentHash, nil
}

// DeleteClusterBadgeIcon 删除图标字节行。没有该行时是无操作，不算错误——
// 调用方通常并不知道这个集群有没有上传过图标。
func DeleteClusterBadgeIcon(clusterID uint) error {
	if clusterID == 0 {
		return nil
	}
	return DB.Where("cluster_id = ?", clusterID).Delete(&ClusterBadgeIcon{}).Error
}
