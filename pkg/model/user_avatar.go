package model

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// UserAvatar 是用户上传的头像字节（一个用户最多一行）。
//
// 单独成表而不是把 data: URL 塞进 users.avatar_url：users 行会被每次认证、
// 会话心跳与用户列表整行读取，混进最大 1 MiB 的 blob 会拖慢这些高频路径。
// 字节只在 GET /api/users/:id/avatar 时按主键取一次，其余查询不受影响。
//
// 不变式：这一行存在的当前提是 users.avatar_url 正指向它
// （见 users.AvatarPath / pkg/users/avatar.go 的说明）。把 avatar_url 改成
// 别的值时必须调用 DeleteUserAvatar，否则会留下永远取不到的孤儿行。
type UserAvatar struct {
	// autoIncrement:false：主键是「用户 id」而不是自增列，
	// 否则 MySQL / PostgreSQL 会额外挂一个 AUTO_INCREMENT / 序列。
	UserID uint64 `gorm:"primaryKey;autoIncrement:false" json:"user_id"`
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
	// 用内容哈希而不是自增版本号：删除头像会删掉整行，自增号会从 1 重新开始，
	// 于是「删掉再传一张新的」会拿到与历史某次相同的 URL —— 而那是 1 年强缓存的
	// URL，浏览器会继续显示旧图。内容寻址没有这个问题：图片变了 URL 必变，
	// 图片没变则 URL 不变（缓存复用是正确行为）。
	ContentHash string    `gorm:"type:varchar(64);not null" json:"content_hash"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// GetUserAvatar 读取某个用户的头像；没有上传过头像时返回 gorm.ErrRecordNotFound。
func GetUserAvatar(userID uint64) (*UserAvatar, error) {
	if userID == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var avatar UserAvatar
	if err := DB.First(&avatar, "user_id = ?", userID).Error; err != nil {
		return nil, err
	}
	return &avatar, nil
}

// avatarContentHash 取字节的 SHA-256 前 16 个十六进制字符。
// 64 位足够避免头像之间的碰撞，URL 也不至于太长。
func avatarContentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:16]
}

// SaveUserAvatar 写入（或替换）头像字节并返回其内容哈希。
func SaveUserAvatar(userID uint64, contentType string, data []byte) (string, error) {
	if userID == 0 {
		return "", errors.New("user id is required")
	}

	avatar := UserAvatar{
		UserID:      userID,
		ContentType: contentType,
		Data:        data,
		Size:        int64(len(data)),
		ContentHash: avatarContentHash(data),
	}
	// 主键是 user_id：一条 upsert 同时覆盖「第一次上传」与「替换」两种情况。
	err := DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"content_type", "data", "size", "content_hash", "updated_at"}),
	}).Create(&avatar).Error
	if err != nil {
		return "", err
	}
	return avatar.ContentHash, nil
}

// DeleteUserAvatar 删除头像字节行。没有该行时是无操作，不算错误——
// 调用方通常并不知道用户是否上传过。
func DeleteUserAvatar(userID uint64) error {
	if userID == 0 {
		return nil
	}
	return DB.Where("user_id = ?", userID).Delete(&UserAvatar{}).Error
}
