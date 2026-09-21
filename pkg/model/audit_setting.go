package model

import (
	"crypto/sha256"
	"encoding/hex"
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

// 日志外发方式：**二选一**（同一时刻只有一条链路生效）。
//
// 为什么是二选一而不是各自一个开关：同一批审计记录被两条链路各发一份时，运维只看其中一条
// 就会以为日志齐全了——与 sink 必须互斥同一个道理。
const (
	// LogForwardModeSyslog 走 RFC5424 syslog（默认，行为与历史一致）。
	LogForwardModeSyslog = "syslog"
	// LogForwardModeKafka 把记录作为 JSON 消息投到 Kafka。
	LogForwardModeKafka = "kafka"
)

// Kafka 的 SASL 认证机制；none 表示不做认证。
const (
	KafkaSASLNone        = "none"
	KafkaSASLPlain       = "plain"
	KafkaSASLScramSHA256 = "scram-sha-256"
	KafkaSASLScramSHA512 = "scram-sha-512"
)

// KafkaSetting 是 Kafka 外发的连接参数。
type KafkaSetting struct {
	// Brokers 是 `host:port` 列表。
	Brokers []string `json:"brokers"`
	Topic   string   `json:"topic"`
	// SASLMechanism 取值见 KafkaSASL* 常量。
	SASLMechanism string `json:"saslMechanism"`
	Username      string `json:"username"`
	// Password 只写不回显（SecretString）：读取时给掩码，写入收到掩码则沿用库中原值。
	Password SecretString `json:"password"`
	// UseTLS 默认**开**：审计记录里有操作者、资源名与来源 IP，明文发到 broker 不是一个
	// 可接受的默认值。内网的明文集群需要显式关掉（关掉是一次看得见的动作）。
	UseTLS bool `json:"useTLS"`
	// InsecureSkipVerify 仅 useTLS 时生效：跳过服务端证书校验（自签证书场景）。
	InsecureSkipVerify bool `json:"tlsInsecureSkipVerify"`
}

// LogForwardSetting 是「日志外发」整块的设置：一个开关 + 一种方式（syslog 或 kafka）。
//
// 历史原因：这一块原先只有 syslog，所以它在 `audit_settings.data` 里的 JSON 键仍是 `syslog`
// （见 AuditSettingData），现在同时承载 Kafka 的参数、由 `mode` 决定用哪一组。
// **键名保持不变**：改键名会让升级后旧行里的外发配置静默回到默认值（等于悄悄关掉外发）。
type LogForwardSetting struct {
	Enabled bool `json:"enabled"`
	// Mode 是外发方式：LogForwardModeSyslog（默认）或 LogForwardModeKafka。
	Mode string `json:"mode"`

	// —— 以下为 syslog 参数（mode=syslog 时生效）——
	Network  string `json:"network"` // udp | tcp | tls
	Address  string `json:"address"` // host:port
	Tag      string `json:"tag"`     // APP-NAME 字段
	Facility int    `json:"facility"`
	// Format 是外发消息正文的格式：text（RFC5424 + key=value，默认）或 json。
	Format string `json:"format"`
	// InsecureSkipVerify 仅对 tls 生效：跳过服务端证书校验（自签证书场景）。
	InsecureSkipVerify bool `json:"insecureSkipVerify"`

	// —— 以下为 Kafka 参数（mode=kafka 时生效）——
	Kafka KafkaSetting `json:"kafka"`
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
	RetentionDays int `json:"retentionDays"`
	// Forward 是日志外发（syslog / kafka 二选一）。
	//
	// JSON 键沿用历史的 `syslog`（当时只有 syslog）：改键名会让升级后旧行里的外发配置静默
	// 回到默认值，等于悄然关掉外发。见 LogForwardSetting 的注释。
	Forward LogForwardSetting `json:"syslog"`
	Stdout  StdoutSetting     `json:"stdout"`
	Archive ArchiveSetting    `json:"archive"`
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
//
// 列表字段给**非 nil 空切片**（而不是 nil）：nil 会被序列化成 `null`，而界面把它们当数组用
// （`urls.join(',')` / `filter`），遇到 null 会直接抛 "Cannot read properties of null"，
// 整个设置页打不开。
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
			URLs:        []string{},
			IndexPrefix: DefaultESIndexPrefix,
		},
		VictoriaLogs: VictoriaLogsArchive{
			Enabled: false,
			URLs:    []string{},
			Stream:  DefaultLogStream,
		},
		OpenObserve: OpenObserveArchive{
			Enabled: false,
			URLs:    []string{},
			Org:     DefaultOpenObserveOrg,
			Stream:  DefaultLogStream,
		},
	}
}

// DefaultAuditSettingData 默认永久保留、不外发、不归档：不配置就不会删掉任何审计记录。
func DefaultAuditSettingData() AuditSettingData {
	return AuditSettingData{
		RetentionDays: AuditRetentionKeepForever,
		Forward: LogForwardSetting{
			Enabled:  false,
			Mode:     LogForwardModeSyslog,
			Network:  SyslogNetworkUDP,
			Tag:      DefaultSyslogTag,
			Facility: DefaultSyslogFacility,
			Format:   LogFormatText,
			Kafka: KafkaSetting{
				Brokers:       []string{},
				SASLMechanism: KafkaSASLNone,
				// 默认走 TLS（见 KafkaSetting.UseTLS 的注释）。
				UseTLS: true,
			},
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

	d.Forward.Mode = strings.ToLower(strings.TrimSpace(d.Forward.Mode))
	switch d.Forward.Mode {
	case "", LogForwardModeSyslog:
		d.Forward.Mode = LogForwardModeSyslog
	case LogForwardModeKafka:
	default:
		// 不静默回落：写错了（比如 vector）必须让管理员当场看到，而不是悄悄按 syslog 发出去。
		return fmt.Errorf("unsupported log forward mode %q", d.Forward.Mode)
	}

	d.Forward.Network = strings.ToLower(strings.TrimSpace(d.Forward.Network))
	switch d.Forward.Network {
	case "", SyslogNetworkUDP:
		d.Forward.Network = SyslogNetworkUDP
	case SyslogNetworkTCP, SyslogNetworkTLS:
	default:
		return fmt.Errorf("unsupported syslog network %q", d.Forward.Network)
	}

	d.Forward.Address = strings.TrimSpace(d.Forward.Address)
	d.Forward.Tag = strings.TrimSpace(d.Forward.Tag)
	if d.Forward.Tag == "" {
		d.Forward.Tag = DefaultSyslogTag
	}
	if d.Forward.Facility < 0 || d.Forward.Facility > 23 {
		d.Forward.Facility = DefaultSyslogFacility
	}
	d.Forward.Format = NormalizeLogFormat(d.Forward.Format)

	if err := d.Forward.Kafka.normalize(); err != nil {
		return err
	}

	// 只校验**当前生效**的那一种方式：另一种的参数缺了不影响运行，也就不该拦住保存
	// （否则从 syslog 切到 kafka 时会被要求先把 syslog 地址填回去）。
	if d.Forward.Enabled {
		switch d.Forward.Mode {
		case LogForwardModeKafka:
			if len(d.Forward.Kafka.Brokers) == 0 {
				return errors.New("kafka brokers are required when kafka forwarding is enabled")
			}
			if d.Forward.Kafka.Topic == "" {
				return errors.New("kafka topic is required when kafka forwarding is enabled")
			}
			if d.Forward.Kafka.SASLMechanism != KafkaSASLNone && d.Forward.Kafka.Username == "" {
				return errors.New("kafka username is required when kafka SASL is enabled")
			}
		default:
			if d.Forward.Address == "" {
				return errors.New("syslog address is required when syslog forwarding is enabled")
			}
		}
	}
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
	e.URLs = normalizeStringList(e.URLs)
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
	v.URLs = normalizeStringList(v.URLs)
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
	o.URLs = normalizeStringList(o.URLs)
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

// normalize 校正 Kafka 配置：清洗 brokers 列表与取值，SASL 机制非法时报错（不静默回落）。
func (k *KafkaSetting) normalize() error {
	k.Brokers = normalizeStringList(k.Brokers)
	k.Topic = strings.TrimSpace(k.Topic)
	k.Username = strings.TrimSpace(k.Username)
	k.SASLMechanism = strings.ToLower(strings.TrimSpace(k.SASLMechanism))
	switch k.SASLMechanism {
	case "", KafkaSASLNone:
		k.SASLMechanism = KafkaSASLNone
	case KafkaSASLPlain, KafkaSASLScramSHA256, KafkaSASLScramSHA512:
	default:
		return fmt.Errorf("unsupported kafka sasl mechanism %q", k.SASLMechanism)
	}
	return nil
}

// normalizeStringList 去掉空白项与首尾空格；空列表保持为空（由调用方按「是否启用」判定必填）。
func normalizeStringList(values []string) []string {
	cleaned := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	return cleaned
}

// applyReadDefaults 补齐读出来的配置里那几处「缺了就会让消费方直接报错」的形状。
//
// 只修形状，不做取值校验（校验在 Normalize 里、只发生在写入路径）：调用方拿到的一定是一份
// 能直接渲染的配置。两件事：
//   - 列表字段（ES / VictoriaLogs / OpenObserve 的 urls、Kafka 的 brokers）一律给非 nil 切片：
//     nil 会序列化成 `null`，而界面当数组用（join / filter）会抛
//     "Cannot read properties of null"，整个设置页打不开；
//   - mode 给显式取值：升级前的行没有这个字段（当时只有 syslog），
//     「空串 = syslog」这条约定散在各处迟早会漏一处。
func (d *AuditSettingData) applyReadDefaults() {
	if d.Forward.Mode == "" {
		d.Forward.Mode = LogForwardModeSyslog
	}
	d.Forward.Kafka.Brokers = nonNilStringList(d.Forward.Kafka.Brokers)
	d.Archive.Elasticsearch.URLs = nonNilStringList(d.Archive.Elasticsearch.URLs)
	d.Archive.VictoriaLogs.URLs = nonNilStringList(d.Archive.VictoriaLogs.URLs)
	d.Archive.OpenObserve.URLs = nonNilStringList(d.Archive.OpenObserve.URLs)
}

// nonNilStringList 把 nil 换成空切片，其余原样返回（不做清洗：读路径不改值）。
func nonNilStringList(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
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
		// 行里可能存着 null（升级前播种的行就是这样）：在返回前补齐形状。
		data.applyReadDefaults()
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
	data.applyReadDefaults()
	return &data, nil
}

// AuditSettingRevision 返回当前审计设置**内容**的指纹（SHA-256 十六进制）。
//
// 用途：多副本部署下每个副本据此判断「库里的设置变了吗」（见 pkg/audit/setting_watcher.go）。
// 比较内容而不是 UpdatedAt：各数据库对时间精度的截断行为不同（MySQL 默认秒级、SQLite 存字符串），
// 用时间戳判断会漏掉同一秒内的第二次修改。
func AuditSettingRevision() (string, error) {
	var row AuditSetting
	if err := DB.Select("data").First(&row, 1).Error; err != nil {
		return "", err
	}
	sum := sha256.Sum256(row.Data)
	return hex.EncodeToString(sum[:]), nil
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
