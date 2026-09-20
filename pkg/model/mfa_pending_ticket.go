package model

import (
	"time"

	"k8s.io/klog/v2"
)

// MFAPendingTicket 是第三方登录「待验证」票据的登记行。
//
// 它只记一个随机 nonce 与过期时间，不存任何凭据：票据本身靠 HMAC 保证不可伪造，
// 这张表只负责「一次性」——兑换时按 nonce 原子删除一行，所以即使控制台跑了多个副本、
// 请求被负载均衡随机分发，同一张票据也只有一次能兑换成功。
type MFAPendingTicket struct {
	Model
	Nonce     string    `json:"nonce" gorm:"type:varchar(64);uniqueIndex;not null"`
	UserID    uint      `json:"user_id" gorm:"index;not null"`
	ExpiresAt time.Time `json:"expires_at" gorm:"index;not null"`
}

// SaveMFAPendingTicket 登记一张票据，并顺手清掉过期的行。
//
// 签发只发生在「已绑定动态码的账号走第三方登录」时，频率很低，不值得为这张表再起一个
// 后台清理任务；清理失败也不影响本次签发。
func SaveMFAPendingTicket(nonce string, userID uint, expiresAt time.Time) error {
	if err := CleanupExpiredMFAPendingTickets(time.Now()); err != nil {
		klog.V(4).Infof("failed to clean up expired MFA pending tickets: %v", err)
	}
	return DB.Create(&MFAPendingTicket{Nonce: nonce, UserID: userID, ExpiresAt: expiresAt}).Error
}

// ConsumeMFAPendingTicket 原子地消费一张票据：删掉这一行才算兑换成功。
// 返回 false 表示票据不存在、已过期，或已经被用掉了。
func ConsumeMFAPendingTicket(nonce string, now time.Time) (bool, error) {
	result := DB.Where("nonce = ? AND expires_at > ?", nonce, now).Delete(&MFAPendingTicket{})
	return result.RowsAffected == 1, result.Error
}

// CleanupExpiredMFAPendingTickets 删除已经过期的登记行。
func CleanupExpiredMFAPendingTickets(now time.Time) error {
	return DB.Where("expires_at <= ?", now).Delete(&MFAPendingTicket{}).Error
}
