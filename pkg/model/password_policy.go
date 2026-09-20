package model

import (
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/zxh326/kite/pkg/utils"
)

// 密码策略错误码。提示信息保持英文，与 API 的其它部分保持一致，
// 调用方可以依据错误码映射到本地化文案。
const (
	passwordErrTooShort      = "password_too_short"
	passwordErrTooLong       = "password_too_long"
	passwordErrNoUppercase   = "password_missing_uppercase"
	passwordErrNoLowercase   = "password_missing_lowercase"
	passwordErrNoDigit       = "password_missing_digit"
	passwordErrNoSpecial     = "password_missing_special"
	passwordErrReused        = "password_reused"
	passwordErrContainsSpace = "password_contains_space"
	passwordErrInvalidStart  = "password_invalid_start"
	passwordErrTooFewClasses = "password_too_few_classes"
)

// 密码长度上限与腾讯云 CVM 等主流平台的规则对齐（8~30 位）。
const maxPasswordLength = 30

// passwordClassCount 返回密码包含四类字符中的几类
// （小写 / 大写 / 数字 / 特殊字符）。
func passwordClassCount(plainPassword string) int {
	classes := 0
	if strings.ContainsFunc(plainPassword, unicode.IsLower) {
		classes++
	}
	if strings.ContainsFunc(plainPassword, unicode.IsUpper) {
		classes++
	}
	if strings.ContainsFunc(plainPassword, unicode.IsDigit) {
		classes++
	}
	if strings.ContainsFunc(plainPassword, isSpecialPasswordChar) {
		classes++
	}
	return classes
}

// PasswordPolicyError 在密码违反安全策略时返回。
// Code 与 Params 让客户端可以渲染本地化提示，而不必使用
// Message 中保留的英文兜底文案。
type PasswordPolicyError struct {
	Code    string
	Message string
	Params  map[string]any
}

func (e *PasswordPolicyError) Error() string { return e.Message }

// PasswordReuseError 表示该密码最近使用过。
func PasswordReuseError(limit int) *PasswordPolicyError {
	return &PasswordPolicyError{
		Code:    passwordErrReused,
		Message: fmt.Sprintf("password cannot repeat any of the last %d passwords", limit),
		Params:  map[string]any{"count": limit},
	}
}

// PasswordErrorPayload 构造密码策略校验失败时的 JSON 响应体：
// 供参考的英文提示，加上供界面本地化使用的机器可读错误码与参数。
func PasswordErrorPayload(err error) map[string]any {
	var policyErr *PasswordPolicyError
	if errors.As(err, &policyErr) {
		payload := map[string]any{"error": policyErr.Message, "code": policyErr.Code}
		if len(policyErr.Params) > 0 {
			payload["params"] = policyErr.Params
		}
		return payload
	}
	return map[string]any{"error": err.Error()}
}

// PasswordHistory 保存最近使用过的密码哈希，以免它们被重复使用。
// reused ("不能重复前几次密码").
type PasswordHistory struct {
	Model
	UserID   uint   `json:"userId" gorm:"index;not null"`
	Password string `json:"-" gorm:"column:password;type:text;not null"`
}

// ValidatePassword 按安全策略校验明文密码。管理员账号
// 还要额外满足管理员专属的最小长度。
func ValidatePassword(plainPassword string, isAdmin bool) error {
	setting, err := GetSecuritySetting()
	if err != nil || setting == nil {
		// 策略读不出来时不挡住改密：这是口令强度的辅助校验，不是准入控制。
		//nolint:nilerr // fail-open 是有意为之（见上）。
		return nil
	}

	minLength := setting.PasswordMinLength
	if isAdmin && setting.AdminPasswordMinLength > minLength {
		minLength = setting.AdminPasswordMinLength
	}

	length := len([]rune(plainPassword))
	if minLength > 0 && length < minLength {
		return &PasswordPolicyError{
			Code:    passwordErrTooShort,
			Message: fmt.Sprintf("password must be at least %d characters", minLength),
			Params:  map[string]any{"min": minLength},
		}
	}
	if length > maxPasswordLength {
		return &PasswordPolicyError{
			Code:    passwordErrTooLong,
			Message: fmt.Sprintf("password must be at most %d characters", maxPasswordLength),
			Params:  map[string]any{"max": maxPasswordLength},
		}
	}
	// 空格与以 "/" 开头会带来 shell / 路径转义问题，一律禁止。
	if strings.ContainsRune(plainPassword, ' ') {
		return &PasswordPolicyError{
			Code:    passwordErrContainsSpace,
			Message: "password must not contain spaces",
		}
	}
	if strings.HasPrefix(plainPassword, "/") {
		return &PasswordPolicyError{
			Code:    passwordErrInvalidStart,
			Message: `password must not start with "/"`,
		}
	}
	// PasswordMinClasses > 0 时按「四类字符至少包含 N 类」校验；
	// 为 0 时保持旧行为：按下方各字符类开关逐项全要求。
	if setting.PasswordMinClasses > 0 {
		if classes := passwordClassCount(plainPassword); classes < setting.PasswordMinClasses {
			return &PasswordPolicyError{
				Code:    passwordErrTooFewClasses,
				Message: fmt.Sprintf("password must contain at least %d character classes", setting.PasswordMinClasses),
				Params:  map[string]any{"count": setting.PasswordMinClasses},
			}
		}
		return nil
	}
	if setting.PasswordRequireUppercase && !strings.ContainsFunc(plainPassword, unicode.IsUpper) {
		return &PasswordPolicyError{
			Code:    passwordErrNoUppercase,
			Message: "password must contain an uppercase letter",
		}
	}
	if setting.PasswordRequireLowercase && !strings.ContainsFunc(plainPassword, unicode.IsLower) {
		return &PasswordPolicyError{
			Code:    passwordErrNoLowercase,
			Message: "password must contain a lowercase letter",
		}
	}
	if setting.PasswordRequireDigit && !strings.ContainsFunc(plainPassword, unicode.IsDigit) {
		return &PasswordPolicyError{
			Code:    passwordErrNoDigit,
			Message: "password must contain a digit",
		}
	}
	if setting.PasswordRequireSpecial && !strings.ContainsFunc(plainPassword, isSpecialPasswordChar) {
		return &PasswordPolicyError{
			Code:    passwordErrNoSpecial,
			Message: "password must contain a special character",
		}
	}
	return nil
}

func isSpecialPasswordChar(r rune) bool {
	return !unicode.IsLetter(r) && !unicode.IsDigit(r) && !unicode.IsSpace(r)
}

// PasswordHistoryLimit 表示最近多少个旧密码不允许复用。
func PasswordHistoryLimit() int {
	setting, err := GetSecuritySetting()
	if err != nil || setting == nil {
		return 0
	}
	return setting.PasswordHistoryCount
}

// RecordPasswordHistory 保存刚设置的密码哈希，
// 并把历史裁剪到配置的条数。
func RecordPasswordHistory(userID uint, hashedPassword string) error {
	if userID == 0 || hashedPassword == "" {
		return nil
	}
	entry := PasswordHistory{UserID: userID, Password: hashedPassword}
	if err := DB.Create(&entry).Error; err != nil {
		return err
	}

	setting, err := GetSecuritySetting()
	if err != nil || setting == nil {
		// 策略读不出来时不挡住改密：改了密码但清理不了历史，也不能反过来拒绝改密。
		//nolint:nilerr // fail-open 是有意为之（见上）。
		return nil
	}
	keep := setting.PasswordHistoryCount
	query := DB.Where("user_id = ?", userID)
	if keep > 0 {
		var ids []uint
		if err := DB.Model(&PasswordHistory{}).
			Where("user_id = ?", userID).
			Order("id desc").
			Limit(keep).
			Pluck("id", &ids).Error; err != nil {
			return err
		}
		if len(ids) > 0 {
			query = query.Where("id NOT IN ?", ids)
		}
	}
	return query.Delete(&PasswordHistory{}).Error
}

// PasswordReused 报告该明文密码是否命中用户
// 最近使用过的密码之一。
func PasswordReused(userID uint, plainPassword string, historyCount int) bool {
	if userID == 0 || plainPassword == "" || historyCount <= 0 {
		return false
	}
	var hashes []string
	if err := DB.Model(&PasswordHistory{}).
		Where("user_id = ?", userID).
		Order("id desc").
		Limit(historyCount).
		Pluck("password", &hashes).Error; err != nil {
		return false
	}
	for _, hash := range hashes {
		if utils.CheckPasswordHash(plainPassword, hash) {
			return true
		}
	}
	return false
}
