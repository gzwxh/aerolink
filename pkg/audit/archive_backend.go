package audit

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
)

// archiveSearcher 是归档检索后端的统一接口：Elasticsearch、DuckDB（本地/S3 parquet）与两个外部日志
// 存储（VictoriaLogs / OpenObserve）各一份实现。
//
// 抽出接口的原因是「生产环境不一定给 ES」：同一套查询条件要能在这些后端上跑出同样的结果。
type archiveSearcher interface {
	Search(ctx context.Context, query archiveQuery, from, to time.Time, page, size int) (*archiveSearchResult, error)
}

// archiveBackendName 是后端标识：随检索结果一起返回，界面据此提示数据来源。
type archiveBackendName string

const (
	// backendElasticsearch 走 ES 检索面（有倒排索引，能力最强）。
	backendElasticsearch archiveBackendName = "elasticsearch"
	// backendDuckDB 用 DuckDB 直接查 parquet（本地热层 + S3 冷层），不需要额外组件。
	backendDuckDB archiveBackendName = "duckdb"
	// backendVictoriaLogs 走 VictoriaLogs 自己的 LogsQL 检索面。
	backendVictoriaLogs archiveBackendName = "victorialogs"
	// backendOpenObserve 走 OpenObserve 自己的搜索接口（SQL 模式）。
	backendOpenObserve archiveBackendName = "openobserve"
	// backendAuto 表示由服务端按可用性挑选（跟随 sink）。
	backendAuto archiveBackendName = ""
)

// archiveBackendStatus 描述一个后端当前是否可用，供界面渲染选择器。
type archiveBackendStatus struct {
	Name      archiveBackendName `json:"name"`
	Available bool               `json:"available"`
	// Reason 说明不可用的原因，让管理员知道「为什么这个选项不能选」，而不是选项凭空消失。
	Reason string `json:"reason,omitempty"`
	// Default 表示这是当前配置下的默认后端。
	Default bool `json:"default"`
}

// parseArchiveBackend 解析请求里的 backend 参数（缺省/未知 → auto）。
//
// 只有 sink 选中的那个后端才有意义（五者互斥）：显式传别的后端会被 currentArchiveSearcher
// 带着明确原因拒绝，而不是悄悄换成可用后端让结果对不上。
func parseArchiveBackend(c interface{ Query(string) string }) archiveBackendName {
	value := strings.ToLower(strings.TrimSpace(c.Query("backend")))
	switch archiveBackendName(value) {
	case backendElasticsearch, backendDuckDB, backendVictoriaLogs, backendOpenObserve:
		return archiveBackendName(value)
	default:
		return backendAuto
	}
}

// localArchiveDir 返回本地归档目录（配置为空时回落到环境变量给出的默认值）。
func localArchiveDir(setting *model.AuditSettingData) string {
	if dir := strings.TrimSpace(setting.Archive.LocalDir); dir != "" {
		return dir
	}
	return archiveDefaultDir
}

// usesParquetArchive 报告「当前是否会写 parquet 归档文件」：sink=parquet（主存储），或
// sink=database 且管理员显式开启冷归档（异介质副本）。DuckDB 检索后端据此判断有没有文件可查。
func usesParquetArchive(setting *model.AuditSettingData) bool {
	if model.AuditSinkUsesParquet() {
		return true
	}
	return model.AuditSinkUsesDatabase() && setting.Archive.Enabled
}

// describeArchiveBackends 汇总各后端的可用性并给出默认选择。
//
// 每个后端都**只在自己那条通道被选中时**可用：非 database 的四种 sink 互斥（见方案 §12.13）；
// database 只有在开启冷归档（Archive.Enabled）时才写 parquet 文件、DuckDB 才可查。让一个
// 根本没写数据的后端出现在界面上只会误导。
func describeArchiveBackends() ([]archiveBackendStatus, archiveBackendName, error) {
	setting, err := model.GetAuditSetting()
	if err != nil {
		return nil, backendAuto, fmt.Errorf("failed to load audit setting: %w", err)
	}

	elasticsearch := archiveBackendStatus{Name: backendElasticsearch}
	switch {
	case !model.AuditSinkUsesElasticsearch():
		elasticsearch.Reason = fmt.Sprintf("audit sink is %q: records are not written to elasticsearch", model.AuditSink)
	case len(setting.Archive.Elasticsearch.URLs) == 0:
		elasticsearch.Reason = "elasticsearch urls are not configured"
	default:
		elasticsearch.Available = true
	}

	duckdb := archiveBackendStatus{Name: backendDuckDB}
	switch {
	case !usesParquetArchive(setting):
		duckdb.Reason = fmt.Sprintf("audit sink is %q and no parquet archive is configured: records are not written to parquet files", model.AuditSink)
	case !DuckDBAvailable():
		duckdb.Reason = "duckdb CLI is not installed on the server"
	case localArchiveDir(setting) == "" && !setting.Archive.S3.Enabled:
		duckdb.Reason = "no parquet archive source is configured (local directory or s3)"
	default:
		duckdb.Available = true
	}

	victoriaLogs := archiveBackendStatus{Name: backendVictoriaLogs}
	switch {
	case !model.AuditSinkUsesVictoriaLogs():
		victoriaLogs.Reason = fmt.Sprintf("audit sink is %q: records are not written to victorialogs", model.AuditSink)
	case len(setting.Archive.VictoriaLogs.URLs) == 0:
		victoriaLogs.Reason = "victorialogs urls are not configured"
	default:
		victoriaLogs.Available = true
	}

	openObserve := archiveBackendStatus{Name: backendOpenObserve}
	switch {
	case !model.AuditSinkUsesOpenObserve():
		openObserve.Reason = fmt.Sprintf("audit sink is %q: records are not written to openobserve", model.AuditSink)
	case len(setting.Archive.OpenObserve.URLs) == 0:
		openObserve.Reason = "openobserve urls are not configured"
	default:
		openObserve.Available = true
	}

	// 默认后端**优先跟随 sink**：审计记录写在哪就从哪查（写 ES 却默认查 parquet 会必然查空）。
	// 这两个外部日志存储没有其它兼容后端，只能查自己。
	defaultBackend := backendAuto
	switch model.AuditSink {
	case model.AuditSinkElasticsearch:
		if elasticsearch.Available {
			defaultBackend = backendElasticsearch
		}
	case model.AuditSinkParquet:
		if duckdb.Available {
			defaultBackend = backendDuckDB
		}
	case model.AuditSinkVictoriaLogs:
		if victoriaLogs.Available {
			defaultBackend = backendVictoriaLogs
		}
	case model.AuditSinkOpenObserve:
		if openObserve.Available {
			defaultBackend = backendOpenObserve
		}
	}
	if defaultBackend == backendAuto {
		switch {
		case duckdb.Available:
			defaultBackend = backendDuckDB
		case elasticsearch.Available:
			defaultBackend = backendElasticsearch
		case victoriaLogs.Available:
			defaultBackend = backendVictoriaLogs
		case openObserve.Available:
			defaultBackend = backendOpenObserve
		}
	}

	statuses := []archiveBackendStatus{elasticsearch, duckdb, victoriaLogs, openObserve}
	for i := range statuses {
		statuses[i].Default = statuses[i].Name == defaultBackend
	}
	return statuses, defaultBackend, nil
}

// currentArchiveSearcher 按请求选择检索后端。
//
// preferred 为空（auto）时跟随 sink：审计记录写在哪就从哪查（写 ES 却默认查 parquet 会必然
// 查空）；显式指定后端时按指定来，不可用则返回明确原因——而不是悄悄换一个后端让结果对不上。
func currentArchiveSearcher(preferred archiveBackendName) (archiveSearcher, archiveBackendName, error) {
	setting, err := model.GetAuditSetting()
	if err != nil {
		return nil, backendAuto, fmt.Errorf("failed to load audit setting: %w", err)
	}

	// sink=database 且未开启冷归档：记录在库里、没有归档可查。明确告知不是「故障」而是
	// 「这个部署没开冷归档」——界面据「unavailable」给出配置引导而不是报错。
	if model.AuditSinkUsesDatabase() && !setting.Archive.Enabled {
		return nil, backendAuto, fmt.Errorf(
			"archive search is unavailable: audit sink is %q and cold archiving is not enabled",
			model.AuditSink)
	}

	// 显式指定的后端：必须正是 sink 选中的那一条通道，否则给出明确原因。
	if preferred != backendAuto {
		return explicitArchiveSearcher(preferred, setting)
	}

	// auto：**跟随 sink**。
	switch model.AuditSink {
	case model.AuditSinkElasticsearch:
		sink, err := NewESSink(setting.Archive.Elasticsearch)
		if err != nil {
			return nil, backendAuto, err
		}
		return sink, backendElasticsearch, nil
	case model.AuditSinkVictoriaLogs:
		return newVictoriaLogsSearcher(setting, backendVictoriaLogs)
	case model.AuditSinkOpenObserve:
		return newOpenObserveSearcher(setting, backendOpenObserve)
	}

	backend, err := NewDuckDBBackend(localArchiveDir(setting), setting.Archive.S3)
	if err != nil {
		return nil, backendAuto, err
	}
	return backend, backendDuckDB, nil
}

// explicitArchiveSearcher 处理 `?backend=` 显式指定的情况：选中的必须就是 sink 那条通道。
func explicitArchiveSearcher(preferred archiveBackendName, setting *model.AuditSettingData) (archiveSearcher, archiveBackendName, error) {
	switch preferred {
	case backendElasticsearch:
		if !model.AuditSinkUsesElasticsearch() {
			return nil, backendAuto, fmt.Errorf("archive search is unavailable: audit sink is %q, records are not written to elasticsearch", model.AuditSink)
		}
		sink, err := NewESSink(setting.Archive.Elasticsearch)
		if err != nil {
			return nil, backendAuto, err
		}
		return sink, backendElasticsearch, nil
	case backendDuckDB:
		if !usesParquetArchive(setting) {
			return nil, backendAuto, fmt.Errorf("archive search is unavailable: audit sink is %q, records are not written to parquet files", model.AuditSink)
		}
		backend, err := NewDuckDBBackend(localArchiveDir(setting), setting.Archive.S3)
		if err != nil {
			return nil, backendAuto, err
		}
		return backend, backendDuckDB, nil
	case backendVictoriaLogs:
		if !model.AuditSinkUsesVictoriaLogs() {
			return nil, backendAuto, fmt.Errorf("archive search is unavailable: audit sink is %q, records are not written to victorialogs", model.AuditSink)
		}
		return newVictoriaLogsSearcher(setting, backendVictoriaLogs)
	case backendOpenObserve:
		if !model.AuditSinkUsesOpenObserve() {
			return nil, backendAuto, fmt.Errorf("archive search is unavailable: audit sink is %q, records are not written to openobserve", model.AuditSink)
		}
		return newOpenObserveSearcher(setting, backendOpenObserve)
	default:
		return nil, backendAuto, fmt.Errorf("unknown archive backend %q", preferred)
	}
}

// newVictoriaLogsSearcher 构造 VictoriaLogs 检索后端。
//
// 强制 Enabled：这两个通道的开关由 sink 推导（见 ApplySinkExclusivity），库里可能残留升级前的
// enabled=false（与 ES 同一处理，见 pruneExpiredESIndices）。
func newVictoriaLogsSearcher(setting *model.AuditSettingData, name archiveBackendName) (archiveSearcher, archiveBackendName, error) {
	config := setting.Archive.VictoriaLogs
	config.Enabled = true
	sink, err := NewVictoriaLogsSink(config)
	if err != nil {
		return nil, backendAuto, err
	}
	return sink, name, nil
}

// newOpenObserveSearcher 构造 OpenObserve 检索后端（理由同上）。
func newOpenObserveSearcher(setting *model.AuditSettingData, name archiveBackendName) (archiveSearcher, archiveBackendName, error) {
	config := setting.Archive.OpenObserve
	config.Enabled = true
	sink, err := NewOpenObserveSink(config)
	if err != nil {
		return nil, backendAuto, err
	}
	return sink, name, nil
}
