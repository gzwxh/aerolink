package audit

import (
	"errors"
	"fmt"
	"strings"

	"github.com/zxh326/kite/pkg/model"
)

// ValidateSinkTarget 校验「当前 sink 的落地目标」是否可用。
//
// sink 决定审计记录的唯一落点（五者互斥，见 docs/dev/plans/2026-09-20-audit-log-parquet-archive.md
// §12.13），所以目标不可用就等于**所有**审计记录无处可去。这种情况必须在启动时直接失败，而不是
// 起一个每写一条丢一条的实例：归档链路上的错误只打日志、不回压请求，静默丢记录正是最坏的结果
// （等真需要查日志时才发现缺了一段）。
//
// defaultArchiveDir 是配置未指定归档目录时的兜底（来自 AEROLINK_AUDIT_ARCHIVE_DIR）。
func ValidateSinkTarget(defaultArchiveDir string) error {
	setting, err := model.GetAuditSetting()
	if err != nil {
		return fmt.Errorf("failed to load audit setting: %w", err)
	}

	switch model.AuditSink {
	case model.AuditSinkParquet:
		if strings.TrimSpace(setting.Archive.LocalDir) == "" && strings.TrimSpace(defaultArchiveDir) == "" {
			return errors.New(`audit sink is "parquet" but no archive directory is configured: ` +
				`set auditArchive.localDir (config file or audit settings page) or AEROLINK_AUDIT_ARCHIVE_DIR`)
		}
		return nil
	case model.AuditSinkElasticsearch:
		if len(setting.Archive.Elasticsearch.URLs) == 0 {
			return errors.New(`audit sink is "elasticsearch" but no node address is configured: ` +
				`set auditArchive.elasticsearch.urls (config file or audit settings page)`)
		}
		return nil
	case model.AuditSinkVictoriaLogs:
		if len(setting.Archive.VictoriaLogs.URLs) == 0 {
			return errors.New(`audit sink is "victorialogs" but no node address is configured: ` +
				`set auditArchive.victorialogs.urls (config file or audit settings page)`)
		}
		return nil
	case model.AuditSinkOpenObserve:
		if len(setting.Archive.OpenObserve.URLs) == 0 {
			return errors.New(`audit sink is "openobserve" but no node address is configured: ` +
				`set auditArchive.openobserve.urls (config file or audit settings page)`)
		}
		return nil
	default:
		// database 自己就是落点：库连不上会在启动早期报错，不在这里重复判断。
		return nil
	}
}
