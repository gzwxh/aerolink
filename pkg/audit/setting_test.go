package audit

import (
	"strings"
	"testing"

	"github.com/gzwxh/aerolink/pkg/model"
)

// testArchiveSetting 造一份「地址 + 密钥都填好」的归档配置，作为各用例的基线。
func testArchiveSetting() model.AuditSettingData {
	return model.AuditSettingData{
		Archive: model.ArchiveSetting{
			Enabled:  true,
			LocalDir: "/var/log/aerolink/archive",
			S3: model.S3Archive{
				Enabled:   true,
				Endpoint:  "https://cos.ap-guangzhou.myqcloud.com",
				Region:    "ap-guangzhou",
				Bucket:    "devops-1253764832",
				AccessKey: "AKIDEXAMPLE",
				SecretKey: model.SecretString("real-secret"),
				PathStyle: false,
				UseTLS:    true,
				Prefix:    "wxh-test/aerolink-audit-test",
			},
			Elasticsearch: model.ESArchive{
				Enabled:     true,
				URLs:        []string{"http://es:9200"},
				Username:    "elastic",
				Password:    model.SecretString("es-secret"),
				IndexPrefix: "aerolink-audit",
			},
			VictoriaLogs: model.VictoriaLogsArchive{
				Enabled: true,
				URLs:    []string{"http://victorialogs:9428"},
				Stream:  "aerolink-audit",
			},
			OpenObserve: model.OpenObserveArchive{
				Enabled:  true,
				URLs:     []string{"http://openobserve:5080"},
				Org:      "default",
				Stream:   "aerolink-audit",
				Username: "aerolink@example.com",
				Password: model.SecretString("oo-secret"),
			},
		},
	}
}

// 第一道闸：换了存储地址却沿用回显的掩码密钥，必须被拒绝。
//
// 这是把「静默沿用旧密钥」这类事故挡在保存环节——它的代价极高（要等归档真的跑起来才在日志里
// 报签名失败，界面上完全看不出来），而代价最低的拦截点就是这里。
func TestRejectStaleSecretAfterMove(t *testing.T) {
	current := testArchiveSetting()

	moved := testArchiveSetting()
	moved.Archive.S3.SecretKey = secretMask
	moved.Archive.S3.Bucket = "another-bucket"
	if err := rejectStaleSecretAfterMove(&moved, &current); err == nil {
		t.Error("换了 bucket 却沿用掩码密钥，必须被拒绝")
	}

	movedEndpoint := testArchiveSetting()
	movedEndpoint.Archive.S3.SecretKey = secretMask
	movedEndpoint.Archive.S3.Endpoint = "http://127.0.0.1:9000"
	if err := rejectStaleSecretAfterMove(&movedEndpoint, &current); err == nil {
		t.Error("换了 endpoint 却沿用掩码密钥，必须被拒绝")
	}

	// 只动归档策略（保留、上传后删本地）：掩码必须放行，否则管理员改个保留天数还要重填密钥。
	tweaked := testArchiveSetting()
	tweaked.Archive.S3.SecretKey = secretMask
	tweaked.Archive.S3.DeleteLocalAfterUpload = true
	tweaked.Archive.S3.Prefix = "wxh-test/aerolink-audit-test"
	if err := rejectStaleSecretAfterMove(&tweaked, &current); err != nil {
		t.Errorf("只改归档策略时不该要求重填密钥: %v", err)
	}

	// 开关 S3 不算「换存储」。
	toggled := testArchiveSetting()
	toggled.Archive.S3.SecretKey = secretMask
	toggled.Archive.S3.Enabled = false
	if err := rejectStaleSecretAfterMove(&toggled, &current); err != nil {
		t.Errorf("开关 S3 不该要求重填密钥: %v", err)
	}

	// 管理员重填了密钥：放行。
	renewed := testArchiveSetting()
	renewed.Archive.S3.Bucket = "another-bucket"
	renewed.Archive.S3.SecretKey = model.SecretString("another-secret")
	if err := rejectStaleSecretAfterMove(&renewed, &current); err != nil {
		t.Errorf("重填密钥后应放行: %v", err)
	}

	// ES 同理。
	esMoved := testArchiveSetting()
	esMoved.Archive.Elasticsearch.Password = secretMask
	esMoved.Archive.Elasticsearch.URLs = []string{"http://another-es:9200"}
	if err := rejectStaleSecretAfterMove(&esMoved, &current); err == nil {
		t.Error("换了 ES 地址却沿用掩码密码，必须被拒绝")
	}

	// OpenObserve 同理（换了组织 / 地址 / 用户名 都属于「换了一个部署」）。
	ooMoved := testArchiveSetting()
	ooMoved.Archive.OpenObserve.Password = secretMask
	ooMoved.Archive.OpenObserve.Org = "another-org"
	if err := rejectStaleSecretAfterMove(&ooMoved, &current); err == nil {
		t.Error("换了 OpenObserve 组织却沿用掩码密码，必须被拒绝")
	}

	ooMovedUser := testArchiveSetting()
	ooMovedUser.Archive.OpenObserve.Password = secretMask
	ooMovedUser.Archive.OpenObserve.Username = "someone-else@example.com"
	if err := rejectStaleSecretAfterMove(&ooMovedUser, &current); err == nil {
		t.Error("换了 OpenObserve 用户名却沿用掩码密码，必须被拒绝")
	}

	// 只换流名只是换个采集目标，凭据仍然可用，不该要求重填。
	ooStream := testArchiveSetting()
	ooStream.Archive.OpenObserve.Password = secretMask
	ooStream.Archive.OpenObserve.Stream = "aerolink-audit-2"
	if err := rejectStaleSecretAfterMove(&ooStream, &current); err != nil {
		t.Errorf("只换 stream 时不该要求重填密码: %v", err)
	}
}

// Kafka 密码同理：换了 broker / 主题 / 用户名却沿用掩码，必须要求重填。
func TestRejectStaleKafkaPasswordAfterMove(t *testing.T) {
	withKafka := func() model.AuditSettingData {
		setting := testArchiveSetting()
		setting.Forward = model.LogForwardSetting{
			Enabled: true,
			Mode:    model.LogForwardModeKafka,
			Kafka: model.KafkaSetting{
				Brokers:       []string{"kafka-1:9092"},
				Topic:         "aerolink-audit",
				SASLMechanism: model.KafkaSASLPlain,
				Username:      "aerolink",
				Password:      model.SecretString("kafka-secret"),
				UseTLS:        true,
			},
		}
		return setting
	}
	current := withKafka()

	cases := map[string]func(*model.AuditSettingData){
		"换 broker 地址": func(s *model.AuditSettingData) { s.Forward.Kafka.Brokers = []string{"kafka-2:9092"} },
		"换主题":         func(s *model.AuditSettingData) { s.Forward.Kafka.Topic = "another-topic" },
		"换用户名":        func(s *model.AuditSettingData) { s.Forward.Kafka.Username = "someone-else" },
		"关掉 TLS":      func(s *model.AuditSettingData) { s.Forward.Kafka.UseTLS = false },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			moved := withKafka()
			moved.Forward.Kafka.Password = secretMask
			mutate(&moved)
			if err := rejectStaleSecretAfterMove(&moved, &current); err == nil {
				t.Error("换了 Kafka 目标却沿用掩码密码，必须被拒绝")
			}
		})
	}

	// 只切方式（syslog / kafka）不算换目标：两种方式的参数各自独立，凭据仍然可用。
	toggled := withKafka()
	toggled.Forward.Kafka.Password = secretMask
	toggled.Forward.Enabled = false
	toggled.Forward.Mode = model.LogForwardModeSyslog
	if err := rejectStaleSecretAfterMove(&toggled, &current); err != nil {
		t.Errorf("只切外发方式时不该要求重填密码: %v", err)
	}

	// 重填了密码：放行。
	renewed := withKafka()
	renewed.Forward.Kafka.Brokers = []string{"kafka-2:9092"}
	renewed.Forward.Kafka.Password = model.SecretString("another-secret")
	if err := rejectStaleSecretAfterMove(&renewed, &current); err != nil {
		t.Errorf("重填密码后应放行: %v", err)
	}
}

// 掩码还原：没动密钥时沿用库中原值，动了就用新值。
func TestRestoreMaskedSecrets(t *testing.T) {
	current := testArchiveSetting()

	untouched := testArchiveSetting()
	untouched.Archive.S3.SecretKey = secretMask
	restoreMaskedSecrets(&untouched, &current)
	if untouched.Archive.S3.SecretKey != current.Archive.S3.SecretKey {
		t.Errorf("掩码应还原为库中原值, got %q", untouched.Archive.S3.SecretKey)
	}

	renewed := testArchiveSetting()
	renewed.Archive.S3.SecretKey = model.SecretString("brand-new")
	restoreMaskedSecrets(&renewed, &current)
	if renewed.Archive.S3.SecretKey != model.SecretString("brand-new") {
		t.Error("管理员新填的密钥不该被还原覆盖")
	}

	// OpenObserve 密码同样处理。
	ooUntouched := testArchiveSetting()
	ooUntouched.Archive.OpenObserve.Password = secretMask
	restoreMaskedSecrets(&ooUntouched, &current)
	if ooUntouched.Archive.OpenObserve.Password != current.Archive.OpenObserve.Password {
		t.Errorf("OpenObserve 密码掩码应还原为库中原值, got %q", ooUntouched.Archive.OpenObserve.Password)
	}

	// Kafka 密码：没动就沿用库中原值，新填的不被覆盖。
	kafkaUntouched := testArchiveSetting()
	kafkaUntouched.Forward.Kafka.Password = secretMask
	restoreMaskedSecrets(&kafkaUntouched, &current)
	if kafkaUntouched.Forward.Kafka.Password != current.Forward.Kafka.Password {
		t.Errorf("Kafka 密码掩码应还原为库中原值, got %q", kafkaUntouched.Forward.Kafka.Password)
	}
	kafkaRenewed := testArchiveSetting()
	kafkaRenewed.Forward.Kafka.Password = model.SecretString("brand-new-kafka")
	restoreMaskedSecrets(&kafkaRenewed, &current)
	if kafkaRenewed.Forward.Kafka.Password != model.SecretString("brand-new-kafka") {
		t.Error("管理员新填的 Kafka 密码不该被还原覆盖")
	}
}

// 接口出给浏览器的密钥一律是掩码（含 Kafka 密码）。
func TestMaskAuditSecretsMasksKafkaPassword(t *testing.T) {
	setting := testArchiveSetting()
	setting.Archive.S3.SecretKey = model.SecretString("s3-secret")
	setting.Forward.Kafka.Password = model.SecretString("kafka-secret")

	maskAuditSecrets(&setting)

	if setting.Forward.Kafka.Password != secretMask {
		t.Errorf("Kafka 密码应以掩码下发, got %q", setting.Forward.Kafka.Password)
	}
	if setting.Archive.S3.SecretKey != secretMask {
		t.Errorf("S3 密钥应以掩码下发, got %q", setting.Archive.S3.SecretKey)
	}
}

// 变更摘要：地址类字段记前后值，密钥只记「changed」，**任何情况下都不得出现明文**。
func TestAuditSettingDiff(t *testing.T) {
	before := testArchiveSetting()
	after := testArchiveSetting()
	after.Archive.S3.SecretKey = model.SecretString("rotated-secret")
	after.Archive.S3.Bucket = "new-bucket"
	after.Archive.Elasticsearch.Password = model.SecretString("rotated-es-secret")
	after.Archive.OpenObserve.Password = model.SecretString("rotated-oo-secret")
	after.Archive.VictoriaLogs.URLs = []string{"http://victorialogs-2:9428"}

	summary := auditSettingDiff(before, after)
	if !strings.Contains(summary, "s3.secretKey: changed") {
		t.Errorf("S3 密钥变更应留痕: %s", summary)
	}
	if !strings.Contains(summary, "es.password: changed") {
		t.Errorf("ES 密码变更应留痕: %s", summary)
	}
	if !strings.Contains(summary, "openobserve.password: changed") {
		t.Errorf("OpenObserve 密码变更应留痕: %s", summary)
	}
	if !strings.Contains(summary, "victorialogs.urls: http://victorialogs:9428 -> http://victorialogs-2:9428") {
		t.Errorf("VictoriaLogs 地址变更应记下前后值: %s", summary)
	}
	if !strings.Contains(summary, "s3.bucket: devops-1253764832 -> new-bucket") {
		t.Errorf("地址变更应记下前后值: %s", summary)
	}
	for _, secret := range []string{"rotated-secret", "rotated-es-secret", "rotated-oo-secret", "real-secret", "es-secret", "oo-secret"} {
		if strings.Contains(summary, secret) {
			t.Errorf("摘要绝不能包含密钥明文 %q:\n%s", secret, summary)
		}
	}

	if diff := auditSettingDiff(before, before); diff != "" {
		t.Errorf("没有变化时不该产生摘要, got %q", diff)
	}
}

// 日志外发的变更同样要留痕：换了外发方式（比如从 syslog 换成 kafka）是最该被追溯的改动之一，
// 而密码仍然只能记「changed」。
func TestAuditSettingDiffCoversLogForward(t *testing.T) {
	before := testArchiveSetting()
	before.Forward = model.LogForwardSetting{
		Enabled: true,
		Mode:    model.LogForwardModeSyslog,
		Network: model.SyslogNetworkTCP,
		Address: "log.example.com:514",
		Tag:     "aerolink",
		Format:  model.LogFormatText,
		Kafka: model.KafkaSetting{
			Brokers:       []string{"kafka-1:9092"},
			Topic:         "aerolink-audit",
			SASLMechanism: model.KafkaSASLPlain,
			Username:      "aerolink",
			Password:      model.SecretString("kafka-secret"),
			UseTLS:        true,
		},
	}

	after := before
	after.Forward.Mode = model.LogForwardModeKafka
	after.Forward.Kafka.Password = model.SecretString("rotated-kafka-secret")
	after.Forward.Kafka.Topic = "aerolink-audit-2"

	summary := auditSettingDiff(before, after)
	if !strings.Contains(summary, "forward.mode: syslog -> kafka") {
		t.Errorf("换外发方式应记下前后值: %s", summary)
	}
	if !strings.Contains(summary, "kafka.topic: aerolink-audit -> aerolink-audit-2") {
		t.Errorf("Kafka 主题变更应记下前后值: %s", summary)
	}
	if !strings.Contains(summary, "kafka.password: changed") {
		t.Errorf("Kafka 密码变更应留痕: %s", summary)
	}
	for _, secret := range []string{"kafka-secret", "rotated-kafka-secret"} {
		if strings.Contains(summary, secret) {
			t.Errorf("摘要绝不能包含密钥明文 %q:\n%s", secret, summary)
		}
	}

	if diff := auditSettingDiff(before, before); diff != "" {
		t.Errorf("没有变化时不该产生摘要, got %q", diff)
	}
}

// 第二道闸：目标存储不可达时要给出 warning（而不是让保存静默成功）。
//
// 注意要先把 sink 切到 parquet：通道互斥，S3 只有在 sink=parquet 时才参与探测（见方案 §12.13）。
func TestProbeArchiveTargetsReportsUnreachableBackend(t *testing.T) {
	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })
	model.AuditSink = model.AuditSinkParquet

	setting := testArchiveSetting()
	// 指向一个必然连不上的地址：连接会被立即拒绝，不必等超时。
	setting.Archive.S3.Endpoint = "http://127.0.0.1:1"
	setting.Archive.S3.UseTLS = false
	setting.Archive.Elasticsearch.Enabled = false

	warnings := probeArchiveTargets(&setting)
	if len(warnings) == 0 {
		t.Fatal("不可达的 S3 必须产生 warning")
	}
	if !strings.HasPrefix(warnings[0], "s3:") {
		t.Errorf("warning 应指明是哪个后端: %v", warnings)
	}
}

// 没有启用任何远端存储时不该去探测，也就没有 warning。
func TestProbeArchiveTargetsSkipsDisabledBackends(t *testing.T) {
	setting := testArchiveSetting()
	setting.Archive.S3.Enabled = false
	setting.Archive.Elasticsearch.Enabled = false
	setting.Archive.VictoriaLogs.Enabled = false
	setting.Archive.OpenObserve.Enabled = false

	if warnings := probeArchiveTargets(&setting); len(warnings) != 0 {
		t.Errorf("未启用的后端不该被探测: %v", warnings)
	}
}

// 只探测当前 sink 的那条通道：互斥下的其它通道即使配了地址也不该被探测（否则会给出误导性告警）。
func TestProbeArchiveTargetsFollowsSink(t *testing.T) {
	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })

	setting := testArchiveSetting()
	// 四条外部通道全部指向必然连不上的地址，看哪些真的被探测到了。
	setting.Archive.S3.Endpoint = "http://127.0.0.1:1"
	setting.Archive.S3.UseTLS = false
	setting.Archive.Elasticsearch.URLs = []string{"http://127.0.0.1:1"}
	setting.Archive.VictoriaLogs.URLs = []string{"http://127.0.0.1:1"}
	setting.Archive.OpenObserve.URLs = []string{"http://127.0.0.1:1"}

	cases := map[string]string{
		model.AuditSinkParquet:       "s3:",
		model.AuditSinkElasticsearch: "elasticsearch:",
		model.AuditSinkVictoriaLogs:  "victorialogs:",
		model.AuditSinkOpenObserve:   "openobserve:",
	}
	for sink, prefix := range cases {
		t.Run(sink, func(t *testing.T) {
			model.AuditSink = sink
			warnings := probeArchiveTargets(&setting)
			if len(warnings) == 0 {
				t.Fatalf("sink=%s 时不可达的%s应当被探测到", sink, prefix)
			}
			for _, warning := range warnings {
				if !strings.HasPrefix(warning, prefix) {
					t.Errorf("sink=%s 只应探测 %s，却探测到了 %q", sink, prefix, warning)
				}
			}
		})
	}
}
