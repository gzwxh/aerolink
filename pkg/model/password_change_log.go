package model

import (
	"time"

	"k8s.io/klog/v2"
)

// Password change sources recorded in PasswordChangeLog.
const (
	PasswordChangeSourceSelf  = "self"
	PasswordChangeSourceAdmin = "admin"
)

// PasswordChangeLog is the audit trail of password changes. Unlike
// PasswordHistory (which is trimmed to enforce the password reuse policy) these
// rows are kept so administrators can review who changed a password and when.
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

// RecordPasswordChange stores one audit entry. operatorID/operatorName identify
// who made the change; source is PasswordChangeSourceSelf or
// PasswordChangeSourceAdmin.
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
	if err := DB.Create(&entry).Error; err != nil {
		klog.Errorf("failed to record password change of user %d: %v", userID, err)
	}
}
