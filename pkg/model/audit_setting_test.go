package model

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// setupAuditSettingTestDB 给需要读写 audit_settings 的用例准备一个内存库。
func setupAuditSettingTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	originalDB := DB
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&AuditSetting{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })
	return db
}

func TestDefaultAuditSettingArchiveDefaults(t *testing.T) {
	// 取**未经 Normalize** 的默认值：Normalize 会按 sink 落定通道开关（见 ApplySinkExclusivity），
	// 这里要看的是配置文件/界面播种时用的那份原始默认。
	archive := DefaultArchiveSetting()

	if archive.Enabled {
		t.Error("归档默认应为关闭，避免存量部署默认写盘")
	}
	if !archive.S3.PathStyle {
		t.Error("S3 默认应使用 pathStyle")
	}
	if archive.S3.DeleteLocalAfterUpload {
		t.Error("S3 默认应为「本地留几天 + 全量同步 S3」（deleteLocalAfterUpload=false）")
	}
	if archive.AccessLog.RetentionDays != DefaultAccessLogRetentionDays {
		t.Errorf("访问日志默认保留 = %d, want %d", archive.AccessLog.RetentionDays, DefaultAccessLogRetentionDays)
	}
	if archive.Elasticsearch.IndexPrefix != DefaultESIndexPrefix {
		t.Errorf("ES 默认 indexPrefix = %q, want %q", archive.Elasticsearch.IndexPrefix, DefaultESIndexPrefix)
	}
}

// 五条通道互斥：通道开关由 sink 推导，而不是由管理员/配置文件随便开关。
func TestApplySinkExclusivity(t *testing.T) {
	originalSink := AuditSink
	t.Cleanup(func() { AuditSink = originalSink })

	// 故意把所有通道都打开，看 Normalize 是不是按 sink 收单。
	openAll := func() AuditSettingData {
		data := DefaultAuditSettingData()
		data.Archive.Enabled = true
		data.Archive.S3.Enabled = true
		data.Archive.S3.Endpoint = "http://minio:9000"
		data.Archive.S3.Bucket = "aerolink-audit"
		data.Archive.Elasticsearch.Enabled = true
		data.Archive.Elasticsearch.URLs = []string{"http://es:9200"}
		data.Archive.VictoriaLogs.Enabled = true
		data.Archive.VictoriaLogs.URLs = []string{"http://victorialogs:9428"}
		data.Archive.OpenObserve.Enabled = true
		data.Archive.OpenObserve.URLs = []string{"http://openobserve:5080"}
		return data
	}

	// 除了 sink 对应的那一条，其余通道（含 S3）都必须被关掉。
	assertOnlyChannel := func(t *testing.T, data AuditSettingData, want string) {
		t.Helper()
		channels := map[string]bool{
			"parquet":       data.Archive.Enabled,
			"elasticsearch": data.Archive.Elasticsearch.Enabled,
			"victorialogs":  data.Archive.VictoriaLogs.Enabled,
			"openobserve":   data.Archive.OpenObserve.Enabled,
		}
		for name, enabled := range channels {
			if name == want && !enabled {
				t.Errorf("sink=%s 时 %s 通道必须生效", AuditSink, name)
			}
			if name != want && enabled {
				t.Errorf("sink=%s 时 %s 通道必须关掉", AuditSink, name)
			}
		}
		if want != "parquet" && data.Archive.S3.Enabled {
			t.Errorf("sink=%s 时 S3 必须关掉（它只是 parquet 的远端副本）", AuditSink)
		}
	}

	t.Run("database 只落库", func(t *testing.T) {
		AuditSink = AuditSinkDatabase
		data := openAll()
		if err := data.Normalize(); err != nil {
			t.Fatalf("Normalize() error = %v", err)
		}
		assertOnlyChannel(t, data, "")
	})

	t.Run("parquet 只开本地与 S3", func(t *testing.T) {
		AuditSink = AuditSinkParquet
		data := openAll()
		if err := data.Normalize(); err != nil {
			t.Fatalf("Normalize() error = %v", err)
		}
		assertOnlyChannel(t, data, "parquet")
		if !data.Archive.S3.Enabled {
			t.Error("S3 是 parquet 的远端副本，应保留开启")
		}
	})

	t.Run("elasticsearch 只开 ES", func(t *testing.T) {
		AuditSink = AuditSinkElasticsearch
		data := openAll()
		if err := data.Normalize(); err != nil {
			t.Fatalf("Normalize() error = %v", err)
		}
		assertOnlyChannel(t, data, "elasticsearch")
	})

	t.Run("victorialogs 只开 VictoriaLogs", func(t *testing.T) {
		AuditSink = AuditSinkVictoriaLogs
		data := openAll()
		if err := data.Normalize(); err != nil {
			t.Fatalf("Normalize() error = %v", err)
		}
		assertOnlyChannel(t, data, "victorialogs")
	})

	t.Run("openobserve 只开 OpenObserve", func(t *testing.T) {
		AuditSink = AuditSinkOpenObserve
		data := openAll()
		if err := data.Normalize(); err != nil {
			t.Fatalf("Normalize() error = %v", err)
		}
		assertOnlyChannel(t, data, "openobserve")
	})

	t.Run("sink=elasticsearch 缺地址时拒绝保存", func(t *testing.T) {
		AuditSink = AuditSinkElasticsearch
		data := openAll()
		data.Archive.Elasticsearch.URLs = nil
		if err := data.Normalize(); err == nil {
			t.Error("ES 通道生效却没有节点地址，保存必须被拒绝")
		}
	})

	t.Run("sink=victorialogs 缺地址时拒绝保存", func(t *testing.T) {
		AuditSink = AuditSinkVictoriaLogs
		data := openAll()
		data.Archive.VictoriaLogs.URLs = nil
		if err := data.Normalize(); err == nil {
			t.Error("VictoriaLogs 通道生效却没有节点地址，保存必须被拒绝")
		}
	})

	t.Run("sink=openobserve 缺地址时拒绝保存", func(t *testing.T) {
		AuditSink = AuditSinkOpenObserve
		data := openAll()
		data.Archive.OpenObserve.URLs = nil
		if err := data.Normalize(); err == nil {
			t.Error("OpenObserve 通道生效却没有节点地址，保存必须被拒绝")
		}
	})
}

func TestNormalizeRejectsInvalidArchive(t *testing.T) {
	// 通道开关由 sink 推导（见 ApplySinkExclusivity）：S3 只在 sink=parquet 下生效，ES 只在
	// sink=elasticsearch 下生效，所以这两类「必填项校验」必须先切到对应的 sink 才会触发。
	cases := []struct {
		name   string
		sink   string
		mutate func(*AuditSettingData)
		want   string
	}{
		{
			name:   "negative archive retention",
			sink:   AuditSinkDatabase,
			mutate: func(d *AuditSettingData) { d.Archive.RetentionDays = -1 },
			want:   "retentionDays",
		},
		{
			name:   "negative access log max bytes",
			sink:   AuditSinkDatabase,
			mutate: func(d *AuditSettingData) { d.Archive.AccessLog.MaxBytes = -1 },
			want:   "access log archive",
		},
		{
			name:   "s3 enabled without endpoint",
			sink:   AuditSinkParquet,
			mutate: func(d *AuditSettingData) { d.Archive.S3 = S3Archive{Enabled: true, Bucket: "aerolink-audit"} },
			want:   "endpoint",
		},
		{
			name:   "s3 enabled without bucket",
			sink:   AuditSinkParquet,
			mutate: func(d *AuditSettingData) { d.Archive.S3 = S3Archive{Enabled: true, Endpoint: "http://minio:9000"} },
			want:   "bucket",
		},
		{
			name:   "es enabled without urls",
			sink:   AuditSinkElasticsearch,
			mutate: func(d *AuditSettingData) { d.Archive.Elasticsearch = ESArchive{Enabled: true} },
			want:   "urls",
		},
		{
			name:   "victorialogs enabled without urls",
			sink:   AuditSinkVictoriaLogs,
			mutate: func(d *AuditSettingData) { d.Archive.VictoriaLogs = VictoriaLogsArchive{Enabled: true} },
			want:   "urls",
		},
		{
			name:   "openobserve enabled without urls",
			sink:   AuditSinkOpenObserve,
			mutate: func(d *AuditSettingData) { d.Archive.OpenObserve = OpenObserveArchive{Enabled: true} },
			want:   "urls",
		},
	}

	originalSink := AuditSink
	t.Cleanup(func() { AuditSink = originalSink })

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			AuditSink = tc.sink
			data := DefaultAuditSettingData()
			tc.mutate(&data)
			err := data.Normalize()
			if err == nil {
				t.Fatal("Normalize() returned nil, want error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Normalize() error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestNormalizeArchiveTrimsS3AndES(t *testing.T) {
	data := DefaultAuditSettingData()
	data.Archive.S3.Enabled = true
	data.Archive.S3.Endpoint = "  http://minio:9000  "
	data.Archive.S3.Bucket = "  aerolink-audit "
	data.Archive.S3.Prefix = " /aerolink/audit/ "
	data.Archive.Elasticsearch.Enabled = true
	data.Archive.Elasticsearch.URLs = []string{" http://es:9200 ", "", "   "}

	if err := data.Normalize(); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if data.Archive.S3.Endpoint != "http://minio:9000" || data.Archive.S3.Bucket != "aerolink-audit" {
		t.Errorf("S3 endpoint/bucket not trimmed: %+v", data.Archive.S3)
	}
	if data.Archive.S3.Prefix != "aerolink/audit" {
		t.Errorf("S3 prefix = %q, want aerolink/audit", data.Archive.S3.Prefix)
	}
	if len(data.Archive.Elasticsearch.URLs) != 1 || data.Archive.Elasticsearch.URLs[0] != "http://es:9200" {
		t.Errorf("ES urls not cleaned: %v", data.Archive.Elasticsearch.URLs)
	}
}

func TestNormalizeLogFormat(t *testing.T) {
	// 前后带空白的取值也要能识别；写成变量是避免 linter 把 " json " 当成可疑的 map key。
	paddedJSON := " " + LogFormatJSON + " "
	cases := map[string]string{
		"":         LogFormatText,
		"text":     LogFormatText,
		"TEXT":     LogFormatText,
		paddedJSON: LogFormatJSON,
		"JSON":     LogFormatJSON,
		"yaml":     LogFormatText,
	}
	for input, want := range cases {
		if got := NormalizeLogFormat(input); got != want {
			t.Errorf("NormalizeLogFormat(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizeKeepsLogFormats(t *testing.T) {
	data := DefaultAuditSettingData()
	data.Forward.Format = "json"
	data.Archive.AccessLog.Format = "json"
	if err := data.Normalize(); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if data.Forward.Format != LogFormatJSON || data.Archive.AccessLog.Format != LogFormatJSON {
		t.Errorf("json formats not preserved: syslog=%q access=%q", data.Forward.Format, data.Archive.AccessLog.Format)
	}

	bad := DefaultAuditSettingData()
	bad.Forward.Format = "xml"
	bad.Archive.AccessLog.Format = ""
	if err := bad.Normalize(); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if bad.Forward.Format != LogFormatText || bad.Archive.AccessLog.Format != LogFormatText {
		t.Errorf("unknown formats should fall back to text: syslog=%q access=%q", bad.Forward.Format, bad.Archive.AccessLog.Format)
	}
}

// 外发方式是**二选一**：只有当前生效的那一种方式的必填项会被校验。
func TestNormalizeLogForwardValidatesOnlyActiveMode(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*AuditSettingData)
		wantErr string
	}{
		{
			name:    "未知外发方式被拒绝而不是静默回落",
			mutate:  func(d *AuditSettingData) { d.Forward.Mode = "vector" },
			wantErr: "unsupported log forward mode",
		},
		{
			name: "syslog 启用但没填地址",
			mutate: func(d *AuditSettingData) {
				d.Forward.Mode = LogForwardModeSyslog
				d.Forward.Enabled = true
			},
			wantErr: "syslog address is required",
		},
		{
			name: "kafka 启用但没填 brokers",
			mutate: func(d *AuditSettingData) {
				d.Forward.Mode = LogForwardModeKafka
				d.Forward.Enabled = true
				d.Forward.Kafka.Topic = "aerolink-audit"
			},
			wantErr: "kafka brokers are required",
		},
		{
			name: "kafka 启用但没填 topic",
			mutate: func(d *AuditSettingData) {
				d.Forward.Mode = LogForwardModeKafka
				d.Forward.Enabled = true
				d.Forward.Kafka.Brokers = []string{"kafka:9092"}
			},
			wantErr: "kafka topic is required",
		},
		{
			name: "kafka 开了 SASL 却没填用户名",
			mutate: func(d *AuditSettingData) {
				d.Forward.Mode = LogForwardModeKafka
				d.Forward.Enabled = true
				d.Forward.Kafka.Brokers = []string{"kafka:9092"}
				d.Forward.Kafka.Topic = "aerolink-audit"
				d.Forward.Kafka.SASLMechanism = KafkaSASLScramSHA512
			},
			wantErr: "kafka username is required",
		},
		{
			name: "kafka 的 SASL 机制非法",
			mutate: func(d *AuditSettingData) {
				d.Forward.Kafka.SASLMechanism = "oauthbearer"
			},
			wantErr: "unsupported kafka sasl mechanism",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := DefaultAuditSettingData()
			tc.mutate(&data)
			err := data.Normalize()
			if err == nil {
				t.Fatal("Normalize() returned nil, want error")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("Normalize() error = %q, want it to mention %q", err, tc.wantErr)
			}
		})
	}

	// 反向：切到 kafka 时，旧方式的地址是空的也不该拦住保存（只校验生效的那一种）。
	switched := DefaultAuditSettingData()
	switched.Forward.Mode = LogForwardModeKafka
	switched.Forward.Enabled = true
	switched.Forward.Address = ""
	switched.Forward.Kafka.Brokers = []string{" kafka-1:9092 ", "", "kafka-2:9092"}
	switched.Forward.Kafka.Topic = " aerolink-audit "
	if err := switched.Normalize(); err != nil {
		t.Fatalf("切到 kafka 后不该被 syslog 的必填项拦住: %v", err)
	}
	if switched.Forward.Mode != LogForwardModeKafka {
		t.Errorf("mode = %q, want %q", switched.Forward.Mode, LogForwardModeKafka)
	}
	if len(switched.Forward.Kafka.Brokers) != 2 || switched.Forward.Kafka.Brokers[1] != "kafka-2:9092" {
		t.Errorf("brokers 未被清洗: %v", switched.Forward.Kafka.Brokers)
	}
	if switched.Forward.Kafka.Topic != "aerolink-audit" {
		t.Errorf("topic 未去空白: %q", switched.Forward.Kafka.Topic)
	}
}

// 空的 mode / SASL 机制要落到显式取值：下游不再需要把空串当默认值解释（少一处遗漏就少一处静默失效）。
func TestNormalizeLogForwardDefaults(t *testing.T) {
	data := DefaultAuditSettingData()
	data.Forward.Mode = "  "
	data.Forward.Kafka.SASLMechanism = "  "
	if err := data.Normalize(); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if data.Forward.Mode != LogForwardModeSyslog {
		t.Errorf("空 mode = %q, want %q", data.Forward.Mode, LogForwardModeSyslog)
	}
	if data.Forward.Kafka.SASLMechanism != KafkaSASLNone {
		t.Errorf("空 SASL 机制 = %q, want %q", data.Forward.Kafka.SASLMechanism, KafkaSASLNone)
	}
}

// 升级前的行里外发配置存在历史的 `syslog` 键、没有 `mode` 也没有 `kafka` 子块：
// 读取时必须落到位（不能因为键名/新字段就静默回默认值——那等于惄惄关掉外发）。
func TestGetAuditSettingReadsLegacySyslogRow(t *testing.T) {
	db := setupAuditSettingTestDB(t)

	legacy := `{"retentionDays":90,"syslog":{"enabled":true,"network":"tcp",` +
		`"address":"log.example.com:514","tag":"aerolink","facility":13,` +
		`"format":"json","insecureSkipVerify":false},"stdout":{"enabled":false,"format":"text"}}`
	if err := db.Create(&AuditSetting{Model: Model{ID: 1}, Data: JSONField(legacy)}).Error; err != nil {
		t.Fatalf("seeding legacy row: %v", err)
	}

	setting, err := GetAuditSetting()
	if err != nil {
		t.Fatalf("GetAuditSetting() error = %v", err)
	}

	if !setting.Forward.Enabled || setting.Forward.Address != "log.example.com:514" {
		t.Errorf("旧行的 syslog 配置没有落到 Forward: %+v", setting.Forward)
	}
	if setting.Forward.Network != SyslogNetworkTCP || setting.Forward.Format != LogFormatJSON {
		t.Errorf("旧行的网络/格式没有保留: %+v", setting.Forward)
	}
	// 旧行没有 mode：要由默认值顶上来（而不是空串），否则界面选择器与下游分派都要额外猜一次。
	if setting.Forward.Mode != LogForwardModeSyslog {
		t.Errorf("mode = %q, want %q", setting.Forward.Mode, LogForwardModeSyslog)
	}
	if setting.Forward.Kafka.UseTLS != true || setting.Forward.Kafka.SASLMechanism != KafkaSASLNone {
		t.Errorf("旧行缺失的 kafka 子块没有落成默认值: %+v", setting.Forward.Kafka)
	}
	if setting.RetentionDays != 90 {
		t.Errorf("retentionDays = %d, want 90", setting.RetentionDays)
	}
	// 旧行里的 stdout 已关闭，不能被默认值（开启）覆盖。
	if setting.Stdout.Enabled {
		t.Error("旧行里的 stdout.enabled=false 被默认值覆盖了")
	}
}

// 设置指纹只看内容：多副本收敛靠它判断「变了没有」。
func TestAuditSettingRevisionFollowsContent(t *testing.T) {
	setupAuditSettingTestDB(t)

	if _, err := AuditSettingRevision(); err == nil {
		t.Error("还没有设置行时应当报错（调用方据此走「安全地重载一次」的分支）")
	}

	if _, err := GetAuditSetting(); err != nil {
		t.Fatalf("seeding the default setting: %v", err)
	}
	first, err := AuditSettingRevision()
	if err != nil {
		t.Fatalf("AuditSettingRevision() error = %v", err)
	}
	if first == "" {
		t.Fatal("fingerprint is empty")
	}

	same, err := AuditSettingRevision()
	if err != nil {
		t.Fatalf("AuditSettingRevision() error = %v", err)
	}
	if same != first {
		t.Errorf("未修改时指纹应当稳定: %q != %q", same, first)
	}

	setting, err := GetAuditSetting()
	if err != nil {
		t.Fatalf("GetAuditSetting() error = %v", err)
	}
	setting.Forward.Enabled = true
	setting.Forward.Address = "log.example.com:514"
	if _, err := UpdateAuditSetting(*setting); err != nil {
		t.Fatalf("UpdateAuditSetting() error = %v", err)
	}

	changed, err := AuditSettingRevision()
	if err != nil {
		t.Fatalf("AuditSettingRevision() error = %v", err)
	}
	if changed == first {
		t.Error("内容改了，指纹必须变（否则多副本不会收敛）")
	}
}

// 界面把 urls / brokers 当数组用（filter / join）：nil 会被序列化成 null，
// 让整个审计设置页抛 "Cannot read properties of null (reading 'join')"。
func TestGetAuditSettingNeverReturnsNilSlices(t *testing.T) {
	db := setupAuditSettingTestDB(t)

	assertRenderable := func(t *testing.T, setting *AuditSettingData) {
		t.Helper()
		if setting.Forward.Kafka.Brokers == nil {
			t.Error("Forward.Kafka.Brokers 为 nil：界面 join / filter 会抛异常")
		}
		if setting.Archive.Elasticsearch.URLs == nil {
			t.Error("Archive.Elasticsearch.URLs 为 nil：界面 join / filter 会抛异常")
		}
		if setting.Archive.VictoriaLogs.URLs == nil {
			t.Error("Archive.VictoriaLogs.URLs 为 nil：界面 join / filter 会抛异常")
		}
		if setting.Archive.OpenObserve.URLs == nil {
			t.Error("Archive.OpenObserve.URLs 为 nil：界面 join / filter 会抛异常")
		}
		encoded, err := json.Marshal(setting)
		if err != nil {
			t.Fatalf("marshaling the setting: %v", err)
		}
		if bytes.Contains(encoded, []byte("null")) {
			t.Errorf("响应里不应出现 null（会被序列化成 null 的字段）：%s", encoded)
		}
	}

	t.Run("新库由默认值播种", func(t *testing.T) {
		setting, err := GetAuditSetting()
		if err != nil {
			t.Fatalf("GetAuditSetting() error = %v", err)
		}
		assertRenderable(t, setting)
	})

	t.Run("旧行里显式存了 null", func(t *testing.T) {
		legacy := `{"retentionDays":0,"syslog":{"enabled":false,"mode":"syslog",` +
			`"kafka":{"brokers":null}},` +
			`"archive":{"localDir":"","elasticsearch":{"urls":null},` +
			`"victorialogs":{"urls":null},"openobserve":{"urls":null}}}`
		if err := db.Model(&AuditSetting{Model: Model{ID: 1}}).
			Update("data", JSONField(legacy)).Error; err != nil {
			t.Fatalf("seeding a legacy row: %v", err)
		}

		setting, err := GetAuditSetting()
		if err != nil {
			t.Fatalf("GetAuditSetting() error = %v", err)
		}
		assertRenderable(t, setting)
	})
}
