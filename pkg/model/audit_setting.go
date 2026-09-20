package model

import (
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"
)

// 审计记录保留策略（等保三级「安全审计」：审计记录的存储与管理）。
const (
	// MinAuditRetentionDays 是保留天数的下限。产品侧强制 30 天；等保与《网络安全法》
	// 通常按不少于 6 个月（180 天）核查，界面会对低于 180 天的取值给出提示。
	MinAuditRetentionDays = 30
	// AuditRetentionKeepForever 表示永久保留（默认值：不配置就不删任何审计记录）。
	AuditRetentionKeepForever = 0
)

// Syslog 外发的网络类型。
const (
	SyslogNetworkUDP = "udp"
	SyslogNetworkTCP = "tcp"
	SyslogNetworkTLS = "tls"
)

// SyslogSetting 把审计记录同时外发到外部 syslog 服务器（P2-4）。
//
// 外发是「尽力而为」：失败只记日志，绝不影响审计记录的本地落库。
type SyslogSetting struct {
	Enabled  bool   `json:"enabled"`
	Network  string `json:"network"` // udp | tcp | tls
	Address  string `json:"address"` // host:port
	Tag      string `json:"tag"`     // APP-NAME 字段
	Facility int    `json:"facility"`
	// InsecureSkipVerify 仅对 tls 生效：跳过服务端证书校验（自签证书场景）。
	InsecureSkipVerify bool `json:"insecureSkipVerify"`
}

// DefaultSyslogTag 是外发消息里默认的 APP-NAME。
const DefaultSyslogTag = "kite"

// DefaultSyslogFacility 默认使用 log audit（13）设施。
const DefaultSyslogFacility = 13

// AuditSettingData 是审计章节的配置：保留策略 + syslog 外发。
// 与安全设置一样存成单个 JSON blob，新增选项不需要逐字段迁移。
type AuditSettingData struct {
	// RetentionDays 为保留天数：0 = 永久保留；非 0 时不得小于 MinAuditRetentionDays。
	RetentionDays int           `json:"retentionDays"`
	Syslog        SyslogSetting `json:"syslog"`
}

type AuditSetting struct {
	Model
	Data JSONField `json:"-" gorm:"column:data"`
}

func (AuditSetting) TableName() string {
	return "audit_settings"
}

// DefaultAuditSettingData 默认永久保留、不外发：不配置就不会删掉任何审计记录。
func DefaultAuditSettingData() AuditSettingData {
	return AuditSettingData{
		RetentionDays: AuditRetentionKeepForever,
		Syslog: SyslogSetting{
			Enabled:  false,
			Network:  SyslogNetworkUDP,
			Tag:      DefaultSyslogTag,
			Facility: DefaultSyslogFacility,
		},
	}
}

// ErrAuditRetentionTooShort 是保留天数低于下限时的拒绝原因。
var ErrAuditRetentionTooShort = fmt.Errorf("audit retention must be either 0 (keep forever) or at least %d days", MinAuditRetentionDays)

// Normalize 校正取值并校验下限。返回错误时调用方应拒绝写入（不做静默夹取，
// 否则管理员以为自己设了 7 天却发现没生效）。
func (d *AuditSettingData) Normalize() error {
	if d.RetentionDays < 0 {
		return ErrAuditRetentionTooShort
	}
	if d.RetentionDays > 0 && d.RetentionDays < MinAuditRetentionDays {
		return ErrAuditRetentionTooShort
	}

	d.Syslog.Network = strings.ToLower(strings.TrimSpace(d.Syslog.Network))
	switch d.Syslog.Network {
	case "", SyslogNetworkUDP:
		d.Syslog.Network = SyslogNetworkUDP
	case SyslogNetworkTCP, SyslogNetworkTLS:
	default:
		return fmt.Errorf("unsupported syslog network %q", d.Syslog.Network)
	}

	d.Syslog.Address = strings.TrimSpace(d.Syslog.Address)
	if d.Syslog.Enabled && d.Syslog.Address == "" {
		return errors.New("syslog address is required when syslog forwarding is enabled")
	}
	d.Syslog.Tag = strings.TrimSpace(d.Syslog.Tag)
	if d.Syslog.Tag == "" {
		d.Syslog.Tag = DefaultSyslogTag
	}
	if d.Syslog.Facility < 0 || d.Syslog.Facility > 23 {
		d.Syslog.Facility = DefaultSyslogFacility
	}
	return nil
}

// GetAuditSetting 读取审计配置，不存在时写入并返回默认值。
func GetAuditSetting() (*AuditSettingData, error) {
	var setting AuditSetting
	err := DB.First(&setting, 1).Error
	if err == nil {
		data := DefaultAuditSettingData()
		if len(setting.Data) > 0 {
			if err := setting.Data.Unmarshal(&data); err != nil {
				return nil, err
			}
		}
		return &data, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	data := DefaultAuditSettingData()
	row := AuditSetting{Model: Model{ID: 1}}
	if err := row.Data.Marshal(data); err != nil {
		return nil, err
	}
	if err := DB.Create(&row).Error; err != nil {
		return nil, err
	}
	return &data, nil
}

// UpdateAuditSetting 写入审计配置（已 Normalize 校验，取值非法时拒绝写入）。
func UpdateAuditSetting(data AuditSettingData) (*AuditSettingData, error) {
	if err := data.Normalize(); err != nil {
		return nil, err
	}

	setting := AuditSetting{Model: Model{ID: 1}}
	if err := setting.Data.Marshal(data); err != nil {
		return nil, err
	}
	if err := DB.Save(&setting).Error; err != nil {
		return nil, err
	}
	return &data, nil
}
