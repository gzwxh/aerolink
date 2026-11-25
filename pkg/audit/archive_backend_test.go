package audit

import (
	"strings"
	"testing"

	"aerolink/pkg/model"
)

// 归档检索的后端**跟随 sink**（五者互斥）：写在哪就从哪查。
//
// 这一层出错的代价是「界面显示一张空表」——查不到数据但一切看起来正常，比报错更难发现，
// 所以每个 sink 的默认后端与显式指定的拒绝都要逐一钉住。
func TestArchiveBackendFollowsSink(t *testing.T) {
	setupRetentionTestDB(t)

	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })

	cases := []struct {
		sink        string
		wantDefault archiveBackendName
		// wantAvailable 是该 sink 下唯一可用的后端。
		wantAvailable archiveBackendName
	}{
		{model.AuditSinkParquet, backendDuckDB, backendDuckDB},
		{model.AuditSinkElasticsearch, backendElasticsearch, backendElasticsearch},
		{model.AuditSinkVictoriaLogs, backendVictoriaLogs, backendVictoriaLogs},
		{model.AuditSinkOpenObserve, backendOpenObserve, backendOpenObserve},
	}

	for _, tc := range cases {
		t.Run(tc.sink, func(t *testing.T) {
			if tc.wantDefault == backendDuckDB && !DuckDBAvailable() {
				t.Skip("duckdb CLI 未安装，跳过 parquet 后端断言")
			}
			model.AuditSink = tc.sink
			// 四个通道的地址都配好：可用性必须仍然只由 sink 决定（互斥），而不是「配了就可用」。
			setting := model.DefaultAuditSettingData()
			setting.Archive.LocalDir = t.TempDir()
			setting.Archive.S3.Enabled = true
			setting.Archive.S3.Endpoint = "http://minio:9000"
			setting.Archive.S3.Bucket = "aerolink-audit"
			setting.Archive.Elasticsearch.URLs = []string{"http://es:9200"}
			setting.Archive.VictoriaLogs.URLs = []string{"http://victorialogs:9428"}
			setting.Archive.OpenObserve.URLs = []string{"http://openobserve:5080"}
			if _, err := model.UpdateAuditSetting(setting); err != nil {
				t.Fatalf("saving audit setting: %v", err)
			}

			statuses, defaultBackend, err := describeArchiveBackends()
			if err != nil {
				t.Fatalf("describeArchiveBackends() error = %v", err)
			}

			available := make([]archiveBackendName, 0, len(statuses))
			for _, status := range statuses {
				if status.Available {
					available = append(available, status.Name)
				}
			}
			// duckdb 还要求服务端装了 duckdb CLI（上面的 skip 已保证），这里只断言「没有漏掉 sink 自己的后端」。
			if !containsBackend(available, tc.wantAvailable) {
				t.Errorf("sink=%s 时 %s 应可用, got %v", tc.sink, tc.wantAvailable, available)
			}
			if defaultBackend != tc.wantDefault {
				t.Errorf("sink=%s 时默认后端 = %q, want %q", tc.sink, defaultBackend, tc.wantDefault)
			}

			searcher, backend, err := currentArchiveSearcher(backendAuto)
			if err != nil {
				t.Fatalf("currentArchiveSearcher(auto) error = %v", err)
			}
			if backend != tc.wantDefault {
				t.Errorf("sink=%s 时 auto 应选 %q, got %q", tc.sink, tc.wantDefault, backend)
			}
			if searcher == nil {
				t.Error("选中的后端不该为 nil")
			}
		})
	}
}

// 显式指定一个**不是**当前 sink 的后端时必须带着原因拒绝，而不是悄悄换一个后端让结果对不上。
func TestCurrentArchiveSearcherRejectsForeignBackend(t *testing.T) {
	setupRetentionTestDB(t)

	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })

	setting := model.DefaultAuditSettingData()
	setting.Archive.VictoriaLogs.URLs = []string{"http://victorialogs:9428"}
	if _, err := model.UpdateAuditSetting(setting); err != nil {
		t.Fatalf("saving audit setting: %v", err)
	}

	model.AuditSink = model.AuditSinkVictoriaLogs
	if _, _, err := currentArchiveSearcher(backendDuckDB); err == nil {
		t.Error("sink=victorialogs 时指定 duckdb 必须被拒绝")
	} else if !strings.Contains(err.Error(), "not written to parquet") {
		t.Errorf("拒绝原因应说明记录不在 parquet 里, got %v", err)
	}

	model.AuditSink = model.AuditSinkParquet
	if _, _, err := currentArchiveSearcher(backendVictoriaLogs); err == nil {
		t.Error("sink=parquet 时指定 victorialogs 必须被拒绝")
	} else if !strings.Contains(err.Error(), "not written to victorialogs") {
		t.Errorf("拒绝原因应说明记录不在 VictoriaLogs 里, got %v", err)
	}

	// 库里没有归档可言时（sink=database），任何后端都不该被放行。
	model.AuditSink = model.AuditSinkDatabase
	if _, _, err := currentArchiveSearcher(backendOpenObserve); err == nil {
		t.Error("sink=database 时指定任何归档后端都必须被拒绝")
	}
}

// database 开启冷归档后，审计记录额外落 parquet（+ 可选 S3），归档检索应放行 DuckDB 后端；
// 未开启冷归档时仍无归档可查、任何后端都拒绝。
func TestArchiveBackendDatabaseColdArchive(t *testing.T) {
	setupRetentionTestDB(t)

	originalSink := model.AuditSink
	t.Cleanup(func() { model.AuditSink = originalSink })
	model.AuditSink = model.AuditSinkDatabase

	setting := model.DefaultAuditSettingData()
	setting.Archive.Enabled = true
	setting.Archive.LocalDir = t.TempDir()
	setting.Archive.S3.Enabled = true
	setting.Archive.S3.Endpoint = "http://minio:9000"
	setting.Archive.S3.Bucket = "aerolink-audit"
	if _, err := model.UpdateAuditSetting(setting); err != nil {
		t.Fatalf("saving audit setting: %v", err)
	}

	if !DuckDBAvailable() {
		t.Skip("duckdb CLI 未安装，跳过")
	}

	statuses, defaultBackend, err := describeArchiveBackends()
	if err != nil {
		t.Fatalf("describeArchiveBackends() error = %v", err)
	}
	if defaultBackend != backendDuckDB {
		t.Errorf("database 冷归档时默认后端应 = duckdb, got %q", defaultBackend)
	}
	available := make([]archiveBackendName, 0, len(statuses))
	for _, status := range statuses {
		if status.Available {
			available = append(available, status.Name)
		}
	}
	if !containsBackend(available, backendDuckDB) {
		t.Errorf("database 冷归档时 duckdb 应可用, got %v", available)
	}

	searcher, backend, err := currentArchiveSearcher(backendAuto)
	if err != nil {
		t.Fatalf("currentArchiveSearcher(auto) error = %v", err)
	}
	if backend != backendDuckDB || searcher == nil {
		t.Errorf("database 冷归档时 auto 应选 duckdb, got %q / %v", backend, searcher)
	}
}

// `?backend=` 只认已知取值，未知/缺省一律按 auto（不报错刷接口，交给 auto 去挑）。
func TestParseArchiveBackend(t *testing.T) {
	cases := map[string]archiveBackendName{
		"":              backendAuto,
		"?":             backendAuto,
		"elasticsearch": backendElasticsearch,
		"duckdb":        backendDuckDB,
		"victorialogs":  backendVictoriaLogs,
		"openobserve":   backendOpenObserve,
		"VICTORIALOGS":  backendVictoriaLogs,
		"opensearch":    backendAuto,
		// 前后空白要能容忍（运维手改地址时很常见）；%20 是 URL 编码后的空格。
		"%20duckdb%20":  backendDuckDB,
		"%20opensearch": backendAuto,
	}
	for raw, want := range cases {
		if got := parseArchiveBackend(archiveTestContext(t, "backend="+raw)); got != want {
			t.Errorf("parseArchiveBackend(%q) = %q, want %q", raw, got, want)
		}
	}
}

func containsBackend(names []archiveBackendName, want archiveBackendName) bool {
	for _, name := range names {
		if name == want {
			return true
		}
	}
	return false
}
