package audit

import (
	"context"
	"testing"

	"github.com/zxh326/kite/pkg/model"
)

// archiveSettingOpenAll 返回一份「全部通道都开」的归档配置：用来验证 sink 能把它收敛成唯一通道。
func archiveSettingOpenAll() model.ArchiveSetting {
	archive := model.DefaultArchiveSetting()
	archive.Enabled = true
	archive.S3.Enabled = true
	archive.S3.Endpoint = "http://minio:9000"
	archive.S3.Bucket = "aerolink-audit"
	archive.Elasticsearch.Enabled = true
	archive.Elasticsearch.URLs = []string{"http://es:9200"}
	archive.VictoriaLogs.Enabled = true
	archive.VictoriaLogs.URLs = []string{"http://victorialogs:9428"}
	archive.OpenObserve.Enabled = true
	archive.OpenObserve.URLs = []string{"http://openobserve:5080"}
	return archive
}

// 通道由 sink **唯一**决定（五者互斥）：parquet 只建本地 writer（+ S3 远端副本），
// elasticsearch / victorialogs / openobserve 各只建自己的外部日志存储，database 连归档运行时都不建。
func TestNewArchiveRuntimeFollowsSink(t *testing.T) {
	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })

	dir := t.TempDir()
	archive := archiveSettingOpenAll()

	t.Run("database 不建任何归档通道", func(t *testing.T) {
		model.AuditSink = model.AuditSinkDatabase
		runtime, err := newArchiveRuntime(context.Background(), archive, dir)
		if err == nil {
			runtime.stop()
			t.Fatal("sink=database 时不该建出归档运行时（记录只在库里）")
		}
	})

	t.Run("parquet 不建外部日志存储，S3 作为远端副本", func(t *testing.T) {
		model.AuditSink = model.AuditSinkParquet
		runtime, err := newArchiveRuntime(context.Background(), archive, dir)
		if err != nil {
			t.Fatalf("newArchiveRuntime() error = %v", err)
		}
		t.Cleanup(runtime.stop)

		for name, writer := range map[string]any{
			"operation": runtime.operation, "login": runtime.login, "password": runtime.password,
		} {
			if writer == nil {
				t.Errorf("sink=parquet 时应建好 %s writer", name)
			}
		}
		if runtime.docSink != nil {
			t.Error("sink=parquet 时不该建外部日志存储（互斥：记录不会同时写两份）")
		}
		if runtime.s3 == nil {
			t.Error("S3 是 parquet 的远端副本，应建 S3 sink")
		}
	})

	t.Run("elasticsearch 只建 ES", func(t *testing.T) {
		model.AuditSink = model.AuditSinkElasticsearch
		runtime, err := newArchiveRuntime(context.Background(), archive, dir)
		if err != nil {
			t.Fatalf("newArchiveRuntime() error = %v", err)
		}
		t.Cleanup(runtime.stop)

		if _, ok := runtime.docSink.(*ESSink); !ok {
			t.Fatalf("sink=elasticsearch 时应建 ES sink, got %T", runtime.docSink)
		}
		if runtime.operation != nil || runtime.login != nil || runtime.password != nil {
			t.Error("sink=elasticsearch 时不该建 parquet writer")
		}
		// 配置里虽然开着 S3，但 S3 是 parquet 的远端副本：ES 通道下没有可同步的文件，不该建它。
		if runtime.s3 != nil {
			t.Error("sink=elasticsearch 时不该建 S3 sink")
		}
	})

	t.Run("victorialogs 只建 VictoriaLogs", func(t *testing.T) {
		model.AuditSink = model.AuditSinkVictoriaLogs
		runtime, err := newArchiveRuntime(context.Background(), archive, dir)
		if err != nil {
			t.Fatalf("newArchiveRuntime() error = %v", err)
		}
		t.Cleanup(runtime.stop)

		if _, ok := runtime.docSink.(*VictoriaLogsSink); !ok {
			t.Fatalf("sink=victorialogs 时应建 VictoriaLogs sink, got %T", runtime.docSink)
		}
		if runtime.operation != nil || runtime.s3 != nil {
			t.Error("sink=victorialogs 时不该建 parquet writer / S3")
		}
	})

	t.Run("openobserve 只建 OpenObserve", func(t *testing.T) {
		model.AuditSink = model.AuditSinkOpenObserve
		runtime, err := newArchiveRuntime(context.Background(), archive, dir)
		if err != nil {
			t.Fatalf("newArchiveRuntime() error = %v", err)
		}
		t.Cleanup(runtime.stop)

		if _, ok := runtime.docSink.(*OpenObserveSink); !ok {
			t.Fatalf("sink=openobserve 时应建 OpenObserve sink, got %T", runtime.docSink)
		}
		if runtime.operation != nil || runtime.s3 != nil {
			t.Error("sink=openobserve 时不该建 parquet writer / S3")
		}
	})
}

// sink 是审计记录的唯一落点：目标不可用必须在启动时直接失败，而不是起一个静默丢记录的实例。
func TestValidateSinkTarget(t *testing.T) {
	setupRetentionTestDB(t)

	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })

	t.Run("database 只需要库本身", func(t *testing.T) {
		model.AuditSink = model.AuditSinkDatabase
		if err := ValidateSinkTarget(""); err != nil {
			t.Errorf("sink=database 时不该报错: %v", err)
		}
	})

	t.Run("parquet 需要归档目录", func(t *testing.T) {
		model.AuditSink = model.AuditSinkParquet
		if err := ValidateSinkTarget(""); err == nil {
			t.Error("sink=parquet 且既没有 localDir 也没有 AEROLINK_AUDIT_ARCHIVE_DIR 时必须报错")
		}
		// 环境变量给的默认目录也算数。
		if err := ValidateSinkTarget(t.TempDir()); err != nil {
			t.Errorf("有默认归档目录时不该报错: %v", err)
		}
	})

	t.Run("elasticsearch 需要节点地址", func(t *testing.T) {
		model.AuditSink = model.AuditSinkElasticsearch
		if err := ValidateSinkTarget(""); err == nil {
			t.Error("sink=elasticsearch 且没有节点地址时必须报错")
		}

		setting := model.DefaultAuditSettingData()
		setting.Archive.Elasticsearch.URLs = []string{"http://es:9200"}
		if _, err := model.UpdateAuditSetting(setting); err != nil {
			t.Fatalf("saving audit setting: %v", err)
		}
		if err := ValidateSinkTarget(""); err != nil {
			t.Errorf("配好节点地址后不该报错: %v", err)
		}
	})

	t.Run("victorialogs 需要节点地址", func(t *testing.T) {
		model.AuditSink = model.AuditSinkVictoriaLogs
		if err := ValidateSinkTarget(""); err == nil {
			t.Error("sink=victorialogs 且没有节点地址时必须报错")
		}

		setting := model.DefaultAuditSettingData()
		setting.Archive.VictoriaLogs.URLs = []string{"http://victorialogs:9428"}
		if _, err := model.UpdateAuditSetting(setting); err != nil {
			t.Fatalf("saving audit setting: %v", err)
		}
		if err := ValidateSinkTarget(""); err != nil {
			t.Errorf("配好节点地址后不该报错: %v", err)
		}
	})

	t.Run("openobserve 需要节点地址", func(t *testing.T) {
		model.AuditSink = model.AuditSinkOpenObserve
		if err := ValidateSinkTarget(""); err == nil {
			t.Error("sink=openobserve 且没有节点地址时必须报错")
		}

		setting := model.DefaultAuditSettingData()
		setting.Archive.OpenObserve.URLs = []string{"http://openobserve:5080"}
		if _, err := model.UpdateAuditSetting(setting); err != nil {
			t.Fatalf("saving audit setting: %v", err)
		}
		if err := ValidateSinkTarget(""); err != nil {
			t.Errorf("配好节点地址后不该报错: %v", err)
		}
	})
}
