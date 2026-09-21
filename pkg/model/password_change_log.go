package model

import (
	"context"
	"time"

	"k8s.io/klog/v2"
)

// PasswordChangeLog 中记录的密码变更来源。
const (
	PasswordChangeSourceSelf  = "self"
	PasswordChangeSourceAdmin = "admin"
)

// PasswordChangeLog 是密码变更的审计记录。与
// PasswordHistory（会按密码复用策略裁剪）不同，这里的行会一直保留，
// 便于管理员审计谁在什么时候改过密码。
type PasswordChangeLog struct {
	ID         uint      `json:"id" gorm:"primarykey"`
	CreatedAt  time.Time `json:"createdAt" gorm:"index:idx_password_change_logs_time,sort:desc"`
	UserID     uint      `json:"userId" gorm:"not null;index"`
	Username   string    `json:"username" gorm:"type:varchar(50);index"`
	OperatorID uint      `json:"operatorId" gorm:"index"`
	Operator   string    `json:"operator" gorm:"type:varchar(50)"`
	Source     string    `json:"source" gorm:"type:varchar(20);not null;default:'self'"`
}

func (PasswordChangeLog) TableName() string {
	return "password_change_logs"
}

// RecordPasswordChange 写入一条审计记录。operatorID/operatorName 标识
// 是谁做的变更；source 取 PasswordChangeSourceSelf 或
// PasswordChangeSourceAdmin。
func RecordPasswordChange(userID uint, username string, operatorID uint, operatorName, source string) {
	if userID == 0 {
		return
	}
	entry := PasswordChangeLog{
		UserID:     userID,
		Username:   username,
		OperatorID: operatorID,
		Operator:   operatorName,
		Source:     source,
	}
	// 本函数没有接收 context（调用方是改密流程），故传 context.TODO()：语义与 nil 相同，
	// 但 staticcheck 的 SA1012 会拦下 nil。
	if err := savePasswordChangeRecord(context.TODO(), &entry); err != nil {
		klog.Errorf("failed to record password change of user %d: %v", userID, err)
		return
	}
	// PasswordChangeLog 没有 AfterCreate hook（改造前改密记录完全不外发），sink=database 时
	// 这里显式补一次外发，使它与操作/登录日志一致；sink≠database 时 savePasswordChangeRecord
	// 已经转发过，不能重复。
	if AuditSinkUsesDatabase() {
		forwardAuditMessage(passwordChangeAuditMessage(&entry))
	}
}
