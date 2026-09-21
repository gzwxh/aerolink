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

// 日志输出格式（见方案 §10.3 步骤 11）：text 保持现状，json 输出结构化字段。
const (
	LogFormatText = "text"
	LogFormatJSON = "json"
)

// NormalizeLogFormat 把取值收敛到 text|json。未知值回落 text：保持现状是最安全的默认。
func NormalizeLogFormat(value string) string {
	return NormalizeLogFormatWithDefault(value, LogFormatText)
}

// NormalizeLogFormatWithDefault 与 NormalizeLogFormat 相同，但未知取值使用调用方给定的默认值。
//
// 用于「默认就应该是 json」的场景：标准输出上的审计事件是给采集工具解析的，回落 text 会让
// 结构化解析失败，因此那里用 json 兜底。
func NormalizeLogFormatWithDefault(value, fallback string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case LogFormatText:
		return LogFormatText
	case LogFormatJSON:
		return LogFormatJSON
	default:
		return fallback
	}
}

// SyslogSetting 把审计记录同时外发到外部 syslog 服务器（P2-4）。
//
// 外发是「尽力而为」：失败只记日志，绝不影响审计记录的本地落库。
type SyslogSetting struct {
	Enabled  bool   `json:"enabled"`
	Network  string `json:"network"` // udp | tcp | tls
	Address  string `json:"address"` // host:port
	Tag      string `json:"tag"`     // APP-NAME 字段
	Facility int    `json:"facility"`
	// Format 是外发消息正文的格式：text（RFC5424 + key=value，默认）或 json。
	Format string `json:"format"`
	// InsecureSkipVerify 仅对 tls 生效：跳过服务端证书校验（自签证书场景）。
	InsecureSkipVerify bool `json:"insecureSkipVerify"`
}

// StdoutSetting 把审计事件输出到**标准输出**，交由外部日志采集工具（Filebeat / Fluent Bit /
// 容器日志驱动）收集。
//
// 与 syslog 的区别：syslog 是应用主动外发到远端日志服务器；stdout 是本地输出、被动采集，
// 适用于「日志统一由采集工具收走」的部署。默认开启且用 json——审计事件量很小（相对访问日志
// 不到 1%），而「日志平台里查得到谁在什么时间从哪个 IP 做了什么」是运维刚需
// （见 docs/dev/plans/2026-09-20-log-closed-loop-design.md）。
//
// 只输出操作 / 登录 / 改密三类：访问日志已由 gin 访问日志中间件输出，再投一份就是重复。
type StdoutSetting struct {
	Enabled bool `json:"enabled" yaml:"enabled"`
	// Format 是输出格式：json（默认，结构化单行）或 text（key=value，与 syslog 正文同构）。
	Format string `json:"format" yaml:"format"`
}

// DefaultSyslogTag 是外发消息里默认的 APP-NAME。
const DefaultSyslogTag = "kite"

// DefaultSyslogFacility 默认使用 log audit（13）设施。
const DefaultSyslogFacility = 13

// FlushSetting 是 parquet writer 的攒批触发条件：时间 / 条数 / 字节满足其一即 flush。
type FlushSetting struct {
	IntervalSeconds int   `json:"intervalSeconds" yaml:"intervalSeconds"`
	MaxBatchRows    int   `json:"maxBatchRows" yaml:"maxBatchRows"`
	MaxBatchBytes   int64 `json:"maxBatchBytes" yaml:"maxBatchBytes"`
}

// AccessLogArchive 是访问日志的归档与本地滚留设置。它与审计日志**分开配置**：
// 访问日志量级大得多，默认保留期更短（见 DefaultAccessLogRetentionDays）。
type AccessLogArchive struct {
	Enabled       bool         `json:"enabled" yaml:"enabled"`
	RetentionDays int          `json:"retentionDays" yaml:"retentionDays"`
	MaxBytes      int64        `json:"maxBytes" yaml:"maxBytes"`
	Flush         FlushSetting `json:"flush" yaml:"flush"`
	// Format 是访问日志写到标准输出的格式：text（现状，默认）或 json。
	Format string `json:"format" yaml:"format"`
}

// S3Archive 是 S3 兼容对象存储的归档设置：MinIO / RustFS / Ceph RGW / 腾讯 COS /
// 华为 OBS / 阿里 OSS / JuiceFS / SeaweedFS 等统一走 minio-go，不写厂商专属 driver。
// endpoint / pathStyle / region 是各家唯一的差异点。
type S3Archive struct {
	Enabled   bool         `json:"enabled" yaml:"enabled"`
	Endpoint  string       `json:"endpoint" yaml:"endpoint"`
	Region    string       `json:"region" yaml:"region"`
	Bucket    string       `json:"bucket" yaml:"bucket"`
	AccessKey string       `json:"accessKey" yaml:"accessKey"`
	SecretKey SecretString `json:"secretKey" yaml:"secretKey"`
	PathStyle bool         `json:"pathStyle" yaml:"pathStyle"`
	UseTLS    bool         `json:"useTLS" yaml:"useTLS"`
	Prefix    string       `json:"prefix" yaml:"prefix"`
	// DeleteLocalAfterUpload 为真时上传成功即删本地文件（本地只作中转）；默认 false：
	// 本地按 RetentionDays 留几天、S3 作为长期归档，两边都能查（本地优先、缺失回落 S3）。
	DeleteLocalAfterUpload bool `json:"deleteLocalAfterUpload" yaml:"deleteLocalAfterUpload"`
}

// ESArchive 是 Elasticsearch 检索面的设置（按天索引 `<indexPrefix>-YYYY.MM.DD`）。
// ES 只做检索，不替代 S3 归档与本地 MySQL。
type ESArchive struct {
	Enabled               bool         `json:"enabled" yaml:"enabled"`
	URLs                  []string     `json:"urls" yaml:"urls"`
	Username              string       `json:"username" yaml:"username"`
	Password              SecretString `json:"password" yaml:"password"`
	IndexPrefix           string       `json:"indexPrefix" yaml:"indexPrefix"`
	TLSInsecureSkipVerify bool         `json:"tlsInsecureSkipVerify" yaml:"tlsInsecureSkipVerify"`
}

// VictoriaLogsArchive 是 VictoriaLogs 的设置。
//
// 注意：**不是** VictoriaMetrics。VictoriaMetrics 是时序库（metric + labels + 采样值），
// 存不下审计记录的字段明细（资源名 / 操作者 / 错误信息…），审计落地必须用 VictoriaLogs
// （同一套部署习惯的日志组件，默认 9428）。详见
// docs/dev/plans/2026-09-21-additional-audit-log-sinks.md §2。
//
// 写入走 ES bulk 兼容接口 `/insert/elasticsearch/_bulk`，检索走 LogsQL；
// 过期数据由服务端 `-retentionPeriod` 负责，客户端不做删除。
type VictoriaLogsArchive struct {
	Enabled bool     `json:"enabled" yaml:"enabled"`
	URLs    []string `json:"urls" yaml:"urls"`
	// Stream 是日志流名（VictoriaLogs 按它区分 stream 字段）。
	Stream string `json:"stream" yaml:"stream"`
	// AccountID / ProjectID 是多租户标识（`AccountID` / `ProjectID` 请求头），单租户留空。
	AccountID             string `json:"accountId" yaml:"accountId"`
	ProjectID             string `json:"projectId" yaml:"projectId"`
	TLSInsecureSkipVerify bool   `json:"tlsInsecureSkipVerify" yaml:"tlsInsecureSkipVerify"`
}

// OpenObserveArchive 是 OpenObserve 的设置。
//
// 写入走它的 HTTP 接口 `/api/{org}/{stream}/_json`（JSON 数组 + Basic 认证），检索走它自己的
// 搜索接口（**不**假定与 ES 的 DSL 等价，见 plans/2026-09-21-additional-audit-log-sinks.md §3.3）；
// 过期数据由服务端按 stream 的 `data_retention` 负责，客户端不做删除。
type OpenObserveArchive struct {
	Enabled bool     `json:"enabled" yaml:"enabled"`
	URLs    []string `json:"urls" yaml:"urls"`
	// Org 是组织名（默认 default），Stream 是日志流名（默认 kite-audit）。
	Org      string `json:"org" yaml:"org"`
	Stream   string `json:"stream" yaml:"stream"`
	Username string `json:"username" yaml:"username"`
	// Password 是登录密码（OpenObserve 的 Basic 认证用户名通常是登录邮箱）。
	Password              SecretString `json:"password" yaml:"password"`
	TLSInsecureSkipVerify bool         `json:"tlsInsecureSkipVerify" yaml:"tlsInsecureSkipVerify"`
}

// ArchiveSetting 是审计/访问日志的归档设置：本地 parquet + S3 + ES。
//
// 本地落库（MySQL）保持不变，归档是尽力而为的异介质副本，失败绝不影响落库。
type ArchiveSetting struct {
	Enabled       bool                `json:"enabled" yaml:"enabled"`
	LocalDir      string              `json:"localDir" yaml:"localDir"`
	RetentionDays int                 `json:"retentionDays" yaml:"retentionDays"`
	MaxBytes      int64               `json:"maxBytes" yaml:"maxBytes"`
	Flush         FlushSetting        `json:"flush" yaml:"flush"`
	AccessLog     AccessLogArchive    `json:"accessLog" yaml:"accessLog"`
	S3            S3Archive           `json:"s3" yaml:"s3"`
	Elasticsearch ESArchive           `json:"elasticsearch" yaml:"elasticsearch"`
	VictoriaLogs  VictoriaLogsArchive `json:"victorialogs" yaml:"victorialogs"`
	OpenObserve   OpenObserveArchive  `json:"openobserve" yaml:"openobserve"`
	// IncludeResourceYAML 决定操作日志归档里是否带上变更前后的资源清单。
	// 默认关：YAML 可能很大，会把归档文件撑大；需要溯源时再开。
	IncludeResourceYAML bool `json:"includeResourceYAML" yaml:"includeResourceYAML"`
}

// AuditSettingData 是审计章节的配置：保留策略 + syslog 外发 + 归档。
// 与安全设置一样存成单个 JSON blob，新增选项不需要逐字段迁移。
type AuditSettingData struct {
	// RetentionDays 为保留天数：0 = 永久保留；非 0 时不得小于 MinAuditRetentionDays。
	RetentionDays int            `json:"retentionDays"`
	Syslog        SyslogSetting  `json:"syslog"`
	Stdout        StdoutSetting  `json:"stdout"`
	Archive       ArchiveSetting `json:"archive"`
}

type AuditSetting struct {
	Model
	Data JSONField `json:"-" gorm:"column:data"`
}

func (AuditSetting) TableName() string {
	return "audit_settings"
}

// 归档默认值（见 docs/dev/plans/2026-09-20-audit-log-parquet-archive.md §7）。
// 审计日志与访问日志分开：访问日志量大，默认保留期更短、攒批更大。
const (
	DefaultArchiveRetentionDays   = 7
	DefaultAccessLogRetentionDays = 3
	DefaultArchiveMaxBytes        = int64(10) << 30 // 10 GiB
	DefaultAccessLogMaxBytes      = int64(5) << 30  // 5 GiB
	DefaultArchiveFlushInterval   = 120             // 秒
	DefaultAuditArchiveFlushRows  = 100000
	DefaultAccessLogFlushRows     = 200000
	DefaultESIndexPrefix          = "kite-audit"
	// DefaultLogStream 是 VictoriaLogs / OpenObserve 的默认流名（这两家由服务端按时间分区，
	// 不再自己拼日期，见 plans/2026-09-21-additional-audit-log-sinks.md §3.2）。
	DefaultLogStream = "kite-audit"
	// DefaultOpenObserveOrg 是 OpenObserve 的默认组织名。
	DefaultOpenObserveOrg = "default"
)

// DefaultArchiveSetting 返回归档的默认配置：归档总开关关闭（存量部署不会默认写盘），
// 但本地滚留与访问日志的子项给出生产可用的默认值，由 config.yaml 播种后启用。
//
// 注意 Enabled / Elasticsearch.Enabled 两个开关由 sink 推导（见 ApplySinkExclusivity）：
// 这里的默认值只在 sink=parquet / sink=elasticsearch 时才可能为真。
func DefaultArchiveSetting() ArchiveSetting {
	return ArchiveSetting{
		Enabled:       false,
		RetentionDays: DefaultArchiveRetentionDays,
		MaxBytes:      DefaultArchiveMaxBytes,
		Flush: FlushSetting{
			IntervalSeconds: DefaultArchiveFlushInterval,
			MaxBatchRows:    DefaultAuditArchiveFlushRows,
		},
		AccessLog: AccessLogArchive{
			Enabled:       true,
			RetentionDays: DefaultAccessLogRetentionDays,
			MaxBytes:      DefaultAccessLogMaxBytes,
			Flush: FlushSetting{
				IntervalSeconds: DefaultArchiveFlushInterval,
				MaxBatchRows:    DefaultAccessLogFlushRows,
			},
			Format: LogFormatText,
		},
		S3: S3Archive{
			Enabled:   false,
			PathStyle: true,
			// 默认「本地留几天 + 全量同步 S3」：本地保留由 RetentionDays 负责，S3 是长期归档；
			// upload-即-delete 会让本地只剩中转作用，查询虽然能回落 S3，但磁盘故障时会一起丢。
			DeleteLocalAfterUpload: false,
		},
		Elasticsearch: ESArchive{
			Enabled:     false,
			IndexPrefix: DefaultESIndexPrefix,
		},
		VictoriaLogs: VictoriaLogsArchive{
			Enabled: false,
			Stream:  DefaultLogStream,
		},
		OpenObserve: OpenObserveArchive{
			Enabled: false,
			Org:     DefaultOpenObserveOrg,
			Stream:  DefaultLogStream,
		},
	}
}

// DefaultAuditSettingData 默认永久保留、不外发、不归档：不配置就不会删掉任何审计记录。
func DefaultAuditSettingData() AuditSettingData {
	return AuditSettingData{
		RetentionDays: AuditRetentionKeepForever,
		Syslog: SyslogSetting{
			Enabled:  false,
			Network:  SyslogNetworkUDP,
			Tag:      DefaultSyslogTag,
			Facility: DefaultSyslogFacility,
			Format:   LogFormatText,
		},
		// 标准输出默认开启：日志平台只收 stdout 时也应能查到审计事件。
		Stdout: StdoutSetting{
			Enabled: true,
			Format:  LogFormatJSON,
		},
		Archive: DefaultArchiveSetting(),
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
	d.Syslog.Format = NormalizeLogFormat(d.Syslog.Format)
	// 标准输出以 json 为默认：结构化才有采集价值，未知取值不应回落成 text。
	d.Stdout.Format = NormalizeLogFormatWithDefault(d.Stdout.Format, LogFormatJSON)

	if err := d.normalizeArchive(); err != nil {
		return err
	}
	return nil
}

// ApplySinkExclusivity 按当前 sink 落定各通道开关（**五者互斥**）。
//
// 为什么由 sink 说了算：sink 是启动期由配置文件指定、界面只读的唯一权威，而各通道开关是
// 「要不要再写一份到别处」的意向。允许共存就会出现「库里有、parquet 有、ES 也有一份」——
// 三处都不全，而哪一份是权威取决于看的人，审计场景里这正是要避免的。
//
// 调用点：Normalize（保存时落定，库里存的就是生效值）与 GET 响应（展示真实生效值）。
func (d *AuditSettingData) ApplySinkExclusivity() {
	d.Archive.Enabled = AuditSinkUsesParquet()
	d.Archive.Elasticsearch.Enabled = AuditSinkUsesElasticsearch()
	d.Archive.VictoriaLogs.Enabled = AuditSinkUsesVictoriaLogs()
	d.Archive.OpenObserve.Enabled = AuditSinkUsesOpenObserve()
	if !d.Archive.Enabled {
		// S3 是 parquet 的远端副本：没有 parquet 通道就没有可同步的文件。
		d.Archive.S3.Enabled = false
	}
}

// normalizeArchive 校正归档配置并校验必填项。校验失败返回错误、由调用方拒绝写入
// （不做静默夹取，否则管理员以为配了却没生效）。
func (d *AuditSettingData) normalizeArchive() error {
	d.ApplySinkExclusivity()

	archive := &d.Archive
	archive.LocalDir = strings.TrimSpace(archive.LocalDir)
	archive.AccessLog.Format = NormalizeLogFormat(archive.AccessLog.Format)
	if archive.RetentionDays < 0 || archive.MaxBytes < 0 {
		return errors.New("archive retentionDays and maxBytes must not be negative")
	}
	if archive.AccessLog.RetentionDays < 0 || archive.AccessLog.MaxBytes < 0 {
		return errors.New("access log archive retentionDays and maxBytes must not be negative")
	}
	if archive.Flush.IntervalSeconds < 0 || archive.AccessLog.Flush.IntervalSeconds < 0 {
		return errors.New("archive flush intervalSeconds must not be negative")
	}
	// parquet 作为**唯一**存储时，攒批间隔就是「刚发生的操作查不到」的窗口——检索只能看到
	// 已经落盘的数据。上限 5 分钟是产品约束，超了直接拒绝（不做静默夹取，否则管理员以为
	// 配了个大间隔，实际被偷偷改小）。0 表示用默认值，不受此限。
	if AuditSink == AuditSinkParquet && archive.Flush.IntervalSeconds > MaxParquetQueryDelaySeconds {
		return fmt.Errorf(
			"archive flush intervalSeconds must not exceed %d while the audit sink is %q: "+
				"parquet is then the only place audit records are stored, so this interval is exactly "+
				"how long a just-performed action stays invisible to the audit UI (got %d)",
			MaxParquetQueryDelaySeconds, AuditSinkParquet, archive.Flush.IntervalSeconds)
	}

	if err := archive.S3.normalize(); err != nil {
		return err
	}
	if err := archive.Elasticsearch.normalize(); err != nil {
		return err
	}
	if err := archive.VictoriaLogs.normalize(); err != nil {
		return err
	}
	return archive.OpenObserve.normalize()
}

// normalize 校正 S3 配置：启用时 endpoint 与 bucket 必填，prefix 去掉首尾斜杠。
func (s *S3Archive) normalize() error {
	s.Endpoint = strings.TrimSpace(s.Endpoint)
	s.Region = strings.TrimSpace(s.Region)
	s.Bucket = strings.TrimSpace(s.Bucket)
	s.AccessKey = strings.TrimSpace(s.AccessKey)
	s.Prefix = strings.Trim(strings.TrimSpace(s.Prefix), "/")
	if s.Enabled {
		if s.Endpoint == "" {
			return errors.New("s3 endpoint is required when s3 archiving is enabled")
		}
		if s.Bucket == "" {
			return errors.New("s3 bucket is required when s3 archiving is enabled")
		}
	}
	return nil
}

// normalize 校正 ES 配置：清洗 URL 列表，启用时至少一个 URL，indexPrefix 为空回落默认值。
func (e *ESArchive) normalize() error {
	e.URLs = normalizeURLList(e.URLs)
	e.Username = strings.TrimSpace(e.Username)
	e.IndexPrefix = strings.TrimSpace(e.IndexPrefix)
	if e.IndexPrefix == "" {
		e.IndexPrefix = DefaultESIndexPrefix
	}
	if e.Enabled && len(e.URLs) == 0 {
		return errors.New("elasticsearch urls are required when elasticsearch archiving is enabled")
	}
	return nil
}

// normalize 校正 VictoriaLogs 配置：清洗 URL 列表、stream 回落默认值，启用时至少一个 URL。
func (v *VictoriaLogsArchive) normalize() error {
	v.URLs = normalizeURLList(v.URLs)
	v.Stream = strings.TrimSpace(v.Stream)
	if v.Stream == "" {
		v.Stream = DefaultLogStream
	}
	v.AccountID = strings.TrimSpace(v.AccountID)
	v.ProjectID = strings.TrimSpace(v.ProjectID)
	if v.Enabled && len(v.URLs) == 0 {
		return errors.New("victorialogs urls are required when victorialogs archiving is enabled")
	}
	return nil
}

// normalize 校正 OpenObserve 配置：清洗 URL 列表、org/stream 回落默认值，启用时至少一个 URL。
func (o *OpenObserveArchive) normalize() error {
	o.URLs = normalizeURLList(o.URLs)
	o.Org = strings.TrimSpace(o.Org)
	if o.Org == "" {
		o.Org = DefaultOpenObserveOrg
	}
	o.Stream = strings.TrimSpace(o.Stream)
	if o.Stream == "" {
		o.Stream = DefaultLogStream
	}
	o.Username = strings.TrimSpace(o.Username)
	if o.Enabled && len(o.URLs) == 0 {
		return errors.New("openobserve urls are required when openobserve archiving is enabled")
	}
	return nil
}

// normalizeURLList 去掉空白项与首尾空格；空列表保持为空（由调用方按「是否启用」判定必填）。
func normalizeURLList(urls []string) []string {
	cleaned := make([]string, 0, len(urls))
	for _, url := range urls {
		if trimmed := strings.TrimSpace(url); trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	return cleaned
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
