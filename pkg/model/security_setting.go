package model

import (
	"errors"
	"strings"

	"gorm.io/gorm"
)

const (
	MFAPolicyDisabled = "disabled"
	MFAPolicyAll      = "all"
	MFAPolicyAdmin    = "admin"
)

// SecuritySettingData is the admin-configurable security policy. It is stored as
// a single JSON blob so adding a policy option does not require a migration per
// field.
type SecuritySettingData struct {
	// Authentication
	LoginCaptchaEnabled      bool   `json:"loginCaptchaEnabled"`
	InactiveUserDisableDays  int    `json:"inactiveUserDisableDays"`
	RemoteLoginNoticeEnabled bool   `json:"remoteLoginNoticeEnabled"`
	MFAPolicy                string `json:"mfaPolicy"`
	MFAThirdPartyEnabled     bool   `json:"mfaThirdPartyEnabled"`
	// MFAStepUpEnabled gates the re-verification required for sensitive
	// operations (deletes, interactive shells) from MFA-enrolled users.
	MFAStepUpEnabled    bool   `json:"mfaStepUpEnabled"`
	MFAVerifyTTLSeconds int    `json:"mfaVerifyTtlSeconds"`
	OTPIssuerName       string `json:"otpIssuerName"`
	OTPVerifyWindow     int    `json:"otpVerifyWindow"`

	// New user defaults（新建用户的默认状态）
	DefaultUserEnabled    bool `json:"defaultUserEnabled"`
	DefaultUserExpireDays int  `json:"defaultUserExpireDays"`

	// Login limits
	UserLoginFailLimit    int      `json:"userLoginFailLimit"`
	UserLoginBlockMinutes int      `json:"userLoginBlockMinutes"`
	IPLoginFailLimit      int      `json:"ipLoginFailLimit"`
	IPLoginBlockMinutes   int      `json:"ipLoginBlockMinutes"`
	IPWhitelist           []string `json:"ipWhitelist"`
	IPBlacklist           []string `json:"ipBlacklist"`
	SingleDeviceLogin     bool     `json:"singleDeviceLogin"`
	ExistingUserOnly      bool     `json:"existingUserOnly"`
	LoginSourceRestricted bool     `json:"loginSourceRestricted"`

	// Password policy
	PasswordExpireDays       int  `json:"passwordExpireDays"`
	PasswordHistoryCount     int  `json:"passwordHistoryCount"`
	PasswordMinLength        int  `json:"passwordMinLength"`
	AdminPasswordMinLength   int  `json:"adminPasswordMinLength"`
	PasswordRequireUppercase bool `json:"passwordRequireUppercase"`
	PasswordRequireLowercase bool `json:"passwordRequireLowercase"`
	PasswordRequireDigit     bool `json:"passwordRequireDigit"`
	PasswordRequireSpecial   bool `json:"passwordRequireSpecial"`

	// Sessions
	SessionExpireOnBrowserClose bool `json:"sessionExpireOnBrowserClose"`
	SessionMaxIdleMinutes       int  `json:"sessionMaxIdleMinutes"`
	SessionMaxHours             int  `json:"sessionMaxHours"`
}

type SecuritySetting struct {
	Model
	Data JSONField `json:"-" gorm:"column:data;type:text"`
}

func DefaultSecuritySettingData() SecuritySettingData {
	return SecuritySettingData{
		// Off by default: turning it on requires every client to solve a captcha,
		// which would break API/automation sign-in until they are updated.
		LoginCaptchaEnabled:      false,
		InactiveUserDisableDays:  999,
		RemoteLoginNoticeEnabled: true,
		MFAPolicy:                MFAPolicyDisabled,
		MFAThirdPartyEnabled:     true,
		MFAStepUpEnabled:         true,
		MFAVerifyTTLSeconds:      60,
		OTPIssuerName:            "Kite",
		// 新建用户默认「激活」，默认不过期。
		DefaultUserEnabled:    true,
		DefaultUserExpireDays: 0,
		OTPVerifyWindow:       2,

		UserLoginFailLimit:    7,
		UserLoginBlockMinutes: 30,
		IPLoginFailLimit:      5,
		IPLoginBlockMinutes:   30,
		IPWhitelist:           []string{},
		IPBlacklist:           []string{},
		SingleDeviceLogin:     false,
		ExistingUserOnly:      true,
		LoginSourceRestricted: true,

		PasswordExpireDays:       900,
		PasswordHistoryCount:     5,
		PasswordMinLength:        8,
		AdminPasswordMinLength:   12,
		PasswordRequireUppercase: true,
		PasswordRequireLowercase: true,
		PasswordRequireDigit:     true,
		PasswordRequireSpecial:   true,

		SessionExpireOnBrowserClose: true,
		SessionMaxIdleMinutes:       600,
		SessionMaxHours:             24,
	}
}

func NormalizeMFAPolicy(policy string) string {
	switch strings.ToLower(strings.TrimSpace(policy)) {
	case MFAPolicyAll:
		return MFAPolicyAll
	case MFAPolicyAdmin:
		return MFAPolicyAdmin
	default:
		return MFAPolicyDisabled
	}
}

// MFARequiredFor reports whether the policy forces this user to enroll in MFA.
// Users that already enabled MFA are challenged at login independently of it.
func (d *SecuritySettingData) MFARequiredFor(user *User) bool {
	if d == nil || user == nil {
		return false
	}
	// 创建用户时显式选择「MFA 级别：禁用」的账号不受策略强制。
	if user.MFADisabled {
		return false
	}
	switch d.MFAPolicy {
	case MFAPolicyAll:
		return true
	case MFAPolicyAdmin:
		for _, role := range user.Roles {
			if role.Name == DefaultAdminRole.Name {
				return true
			}
		}
	}
	return false
}

// Normalize keeps stored values inside the range the UI and login flow expect.
func (d *SecuritySettingData) Normalize() {
	clampInt(&d.InactiveUserDisableDays, 0, 3650)
	clampInt(&d.MFAVerifyTTLSeconds, 60, 86400)
	clampInt(&d.OTPVerifyWindow, 0, 10)
	clampInt(&d.UserLoginFailLimit, 0, 100)
	clampInt(&d.UserLoginBlockMinutes, 0, 1440)
	clampInt(&d.IPLoginFailLimit, 0, 100)
	clampInt(&d.IPLoginBlockMinutes, 0, 1440)
	clampInt(&d.PasswordExpireDays, 0, 3650)
	clampInt(&d.PasswordHistoryCount, 0, 100)
	clampInt(&d.DefaultUserExpireDays, 0, 3650)
	clampInt(&d.PasswordMinLength, 1, 64)
	clampInt(&d.AdminPasswordMinLength, 1, 64)
	clampInt(&d.SessionMaxIdleMinutes, 1, 43200)
	clampInt(&d.SessionMaxHours, 1, 8760)

	d.MFAPolicy = NormalizeMFAPolicy(d.MFAPolicy)
	d.OTPIssuerName = strings.TrimSpace(d.OTPIssuerName)
	d.IPWhitelist = normalizeIPEntries(d.IPWhitelist)
	d.IPBlacklist = normalizeIPEntries(d.IPBlacklist)
}

func clampInt(value *int, min int, max int) {
	if *value < min {
		*value = min
	}
	if *value > max {
		*value = max
	}
}

func normalizeIPEntries(entries []string) []string {
	if entries == nil {
		return []string{}
	}
	seen := make(map[string]struct{}, len(entries))
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func GetSecuritySetting() (*SecuritySettingData, error) {
	var setting SecuritySetting
	err := DB.First(&setting, 1).Error
	if err == nil {
		data := DefaultSecuritySettingData()
		if len(setting.Data) > 0 {
			if err := setting.Data.Unmarshal(&data); err != nil {
				return nil, err
			}
		}
		data.Normalize()
		return &data, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	data := DefaultSecuritySettingData()
	setting = SecuritySetting{Model: Model{ID: 1}}
	if err := setting.Data.Marshal(data); err != nil {
		return nil, err
	}
	if err := DB.Create(&setting).Error; err != nil {
		return nil, err
	}
	return &data, nil
}

func UpdateSecuritySetting(data SecuritySettingData) (*SecuritySettingData, error) {
	data.Normalize()

	setting := SecuritySetting{Model: Model{ID: 1}}
	if err := setting.Data.Marshal(data); err != nil {
		return nil, err
	}
	if err := DB.Save(&setting).Error; err != nil {
		return nil, err
	}
	return &data, nil
}
