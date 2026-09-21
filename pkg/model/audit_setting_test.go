package model

import (
	"strings"
	"testing"
)

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
		data.Archive.S3.Bucket = "kite-audit"
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
			mutate: func(d *AuditSettingData) { d.Archive.S3 = S3Archive{Enabled: true, Bucket: "kite-audit"} },
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
	data.Archive.S3.Bucket = "  kite-audit "
	data.Archive.S3.Prefix = " /kite/audit/ "
	data.Archive.Elasticsearch.Enabled = true
	data.Archive.Elasticsearch.URLs = []string{" http://es:9200 ", "", "   "}

	if err := data.Normalize(); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if data.Archive.S3.Endpoint != "http://minio:9000" || data.Archive.S3.Bucket != "kite-audit" {
		t.Errorf("S3 endpoint/bucket not trimmed: %+v", data.Archive.S3)
	}
	if data.Archive.S3.Prefix != "kite/audit" {
		t.Errorf("S3 prefix = %q, want kite/audit", data.Archive.S3.Prefix)
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
	data.Syslog.Format = "json"
	data.Archive.AccessLog.Format = "json"
	if err := data.Normalize(); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if data.Syslog.Format != LogFormatJSON || data.Archive.AccessLog.Format != LogFormatJSON {
		t.Errorf("json formats not preserved: syslog=%q access=%q", data.Syslog.Format, data.Archive.AccessLog.Format)
	}

	bad := DefaultAuditSettingData()
	bad.Syslog.Format = "xml"
	bad.Archive.AccessLog.Format = ""
	if err := bad.Normalize(); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if bad.Syslog.Format != LogFormatText || bad.Archive.AccessLog.Format != LogFormatText {
		t.Errorf("unknown formats should fall back to text: syslog=%q access=%q", bad.Syslog.Format, bad.Archive.AccessLog.Format)
	}
}
