package model

import (
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/zxh326/kite/pkg/utils"
)

// Password policy error codes. Messages stay in English, consistent with the
// rest of the API, and the code lets callers map them to localized text.
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

// passwordClassCount returns how many of the four character classes
// (lowercase / uppercase / digit / special) the password contains.
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

// PasswordPolicyError is returned when a password violates the security policy.
// Code and Params let clients render a localized message instead of the English
// fallback kept in Message.
type PasswordPolicyError struct {
	Code    string
	Message string
	Params  map[string]any
}

func (e *PasswordPolicyError) Error() string { return e.Message }

// PasswordReuseError reports that the password was used recently.
func PasswordReuseError(limit int) *PasswordPolicyError {
	return &PasswordPolicyError{
		Code:    passwordErrReused,
		Message: fmt.Sprintf("password cannot repeat any of the last %d passwords", limit),
		Params:  map[string]any{"count": limit},
	}
}

// PasswordErrorPayload builds the JSON body of a password policy failure: the
// English message for reference plus the machine readable code and parameters
// used by the UI for localization.
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

// PasswordHistory keeps the hashes of recently used passwords so they cannot be
// reused ("不能重复前几次密码").
type PasswordHistory struct {
	Model
	UserID   uint   `json:"userId" gorm:"index;not null"`
	Password string `json:"-" gorm:"column:password;type:text;not null"`
}

// ValidatePassword checks a plain password against the security policy. Admins
// additionally honour the admin specific minimum length.
func ValidatePassword(plainPassword string, isAdmin bool) error {
	setting, err := GetSecuritySetting()
	if err != nil || setting == nil {
		// Never block password changes when the policy cannot be loaded.
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

// PasswordHistoryLimit is how many previous passwords cannot be reused.
func PasswordHistoryLimit() int {
	setting, err := GetSecuritySetting()
	if err != nil || setting == nil {
		return 0
	}
	return setting.PasswordHistoryCount
}

// RecordPasswordHistory stores a freshly set password hash and trims the history
// to the configured size.
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

// PasswordReused reports whether the plain password matches one of the user's
// most recent passwords.
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
