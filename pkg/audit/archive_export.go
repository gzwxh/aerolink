package audit

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
)

// archiveExportTimeout 是一次归档导出的总超时。导出要翻页拉取，比单页检索慢，
// 但同样不能让请求无限挂住。
const archiveExportTimeout = 60 * time.Second

// archiveExportPageSize 是导出时每页拉取的文档数。逐页拉取而不是一次全取，
// 避免单个响应体过大。
const archiveExportPageSize = 1000

// archiveExportWindowLimit 是 ES `from + size` 翻页的上限（`index.max_result_window`
// 默认为 10000）。超过这个量级的导出应先缩小时间范围：这里明确截断，并通过响应头
// `X-Audit-Truncated` 告知，而不是把 ES 的报错原样抛给用户。
const archiveExportWindowLimit = 10000

// archiveExportColumn 描述 CSV 的一列：表头 + 从 `_source` 取值的字段名。
// render 非空时以它为准（用于「一个字段拆两列」这类派生列，例如登录的 success/reason）。
type archiveExportColumn struct {
	header string
	field  string
	render func(source map[string]any) string
}

// 归档导出的列定义：表头与顺序刻意与本地导出（pkg/audit/export.go）对齐，
// 这样「本地还在库里的」和「已归档的」导出来是同一套表头，可直接合并分析。
var (
	auditHistoryArchiveColumns = []archiveExportColumn{
		{header: "time", field: esFieldCreatedAt},
		{header: "operator", field: esFieldOperatorName},
		{header: "operation", field: esFieldOperationType},
		{header: "source", field: "operation_source"},
		{header: "cluster", field: esFieldClusterName},
		{header: "namespace", field: esFieldNamespace},
		{header: "resourceType", field: esFieldResourceType},
		{header: "resourceName", field: esFieldResourceName},
		{header: "success", field: "success"},
		{header: "errorMessage", field: "error_message"},
		{header: "clientIp", field: esFieldClientIP},
		{header: "userAgent", field: "user_agent"},
	}
	loginRecordArchiveColumns = []archiveExportColumn{
		{header: "time", field: esFieldCreatedAt},
		{header: "username", field: esFieldUsername},
		{header: "provider", field: esFieldProvider},
		// 归档里只有一个 result 字段（成功为 "success"，失败为原因），本地导出是
		// success + reason 两列，这里派生对齐，保证两边表头一致。
		{header: "success", render: func(source map[string]any) string {
			return strconv.FormatBool(archiveFieldString(source[esFieldResult]) == model.AuditResultSuccess)
		}},
		{header: "reason", render: func(source map[string]any) string {
			result := archiveFieldString(source[esFieldResult])
			if result == model.AuditResultSuccess {
				return ""
			}
			return result
		}},
		{header: "ip", field: "ip"},
		{header: "userAgent", field: "user_agent"},
	}
	passwordChangeArchiveColumns = []archiveExportColumn{
		{header: "time", field: esFieldCreatedAt},
		{header: "username", field: esFieldUsername},
		{header: "operator", field: "operator"},
		{header: "source", field: "source"},
	}
	accessLogArchiveColumns = []archiveExportColumn{
		{header: "time", field: esFieldTimestamp},
		{header: "clientIp", field: esFieldClientIP},
		{header: "method", field: esFieldMethod},
		{header: "path", field: esFieldPath},
		{header: "statusCode", field: esFieldStatusCode},
		{header: "latencyMs", field: "latency_ms"},
		{header: "cluster", field: "cluster"},
		{header: "user", field: "user"},
	}
)

// archiveExportRequest 汇总一次导出需要的全部信息：分类、过滤条件、输出列。
type archiveExportRequest struct {
	kind      string
	name      string
	timeField string
	columns   []archiveExportColumn
	filters   []archiveCondition
}

// ExportAuditHistoryArchive 把归档的操作日志导出为 CSV。
//
// 路由：GET /api/v1/admin/audit-history-archive/export（需 settings.audit 的读权限）
//
// 过滤条件与检索接口完全一致，所以「页面上筛出来的」和「导出的」永远对得上。
func ExportAuditHistoryArchive(c *gin.Context) {
	filters, ok := auditHistoryArchiveFilters(c)
	if !ok {
		return
	}
	respondArchiveExport(c, archiveExportRequest{
		kind:      ESKindAuditHistory,
		name:      "aerolink-audit-logs-archive",
		timeField: esFieldCreatedAt,
		columns:   auditHistoryArchiveColumns,
		filters:   filters,
	})
}

// ExportLoginRecordArchive 把归档的登录日志导出为 CSV。
func ExportLoginRecordArchive(c *gin.Context) {
	filters, ok := loginRecordArchiveFilters(c)
	if !ok {
		return
	}
	respondArchiveExport(c, archiveExportRequest{
		kind:      ESKindLoginRecord,
		name:      "aerolink-login-logs-archive",
		timeField: esFieldCreatedAt,
		columns:   loginRecordArchiveColumns,
		filters:   filters,
	})
}

// ExportPasswordChangeRecordArchive 把归档的改密日志导出为 CSV。
//
// 它没有独立路由：改密日志只有列表接口（不像操作/登录日志本来就带归档导出接口），切 sink 后
// 由 ExportPasswordChangeLogs 转调到这里。
func ExportPasswordChangeRecordArchive(c *gin.Context) {
	filters, ok := passwordChangeArchiveFilters(c)
	if !ok {
		return
	}
	respondArchiveExport(c, archiveExportRequest{
		kind:      ESKindPasswordChangeLog,
		name:      "aerolink-password-change-logs-archive",
		timeField: esFieldCreatedAt,
		columns:   passwordChangeArchiveColumns,
		filters:   filters,
	})
}

// ExportAccessLogArchive 把归档的访问日志导出为 CSV。
func ExportAccessLogArchive(c *gin.Context) {
	filters, ok := accessLogArchiveFilters(c)
	if !ok {
		return
	}
	respondArchiveExport(c, archiveExportRequest{
		kind:      ESKindAccessLog,
		name:      "aerolink-access-logs-archive",
		timeField: esFieldTimestamp,
		columns:   accessLogArchiveColumns,
		filters:   filters,
	})
}

// respondArchiveExport 是所有归档导出接口共用的收尾：解析时间范围 → 翻页拉取 →
// 输出 CSV（复用本地导出的写法，指纹与响应头一并带上）。
func respondArchiveExport(c *gin.Context, request archiveExportRequest) {
	from, to, ok := parseTimeRange(c)
	if !ok {
		return
	}
	from, to = effectiveTimeRange(from, to, toIsDateOnly(c))

	searcher, _, err := currentArchiveSearcher(parseArchiveBackend(c))
	if err != nil {
		// 与检索接口一致：后端不可用是配置问题而非故障，明确告知。
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), archiveExportTimeout)
	defer cancel()

	records, total, truncated, err := collectArchiveRecords(ctx, searcher, request, from, to)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if truncated {
		// 被截断时额外给出命中总数，界面据此提示管理员缩小时间范围。
		c.Header("X-Audit-Truncated", "true")
		c.Header("X-Audit-Total-Hits", strconv.FormatInt(total, 10))
	}
	writeCSV(c, request.name, archiveHeaders(request.columns), records, from, to)
}

// collectArchiveRecords 按页拉取归档记录并渲染成 CSV 行。
// 返回值里的 truncated 表示「命中数超过可翻页上限，本次只导出了前 N 条」。
func collectArchiveRecords(
	ctx context.Context,
	searcher archiveSearcher,
	request archiveExportRequest,
	from, to time.Time,
) ([][]string, int64, bool, error) {
	query := archiveQuery{
		kind:      request.kind,
		timeField: request.timeField,
		filters:   request.filters,
	}

	records := make([][]string, 0, archiveExportPageSize)
	var total int64

	for page := 1; len(records) < archiveExportWindowLimit; page++ {
		result, err := searcher.Search(ctx, query, from, to, page, archiveExportPageSize)
		if err != nil {
			return nil, 0, false, err
		}
		total = result.Total
		if len(result.Hits) == 0 {
			break
		}

		for _, hit := range result.Hits {
			source := map[string]any{}
			if err := json.Unmarshal(hit, &source); err != nil {
				// 单条文档解析失败不该让整份导出失败：跳过它，其余照常导出。
				continue
			}
			records = append(records, renderArchiveRecord(request.columns, source))
		}

		if len(result.Hits) < archiveExportPageSize || int64(page*archiveExportPageSize) >= total {
			break
		}
	}

	// 最后一页可能越过上限，按上限截断。
	if len(records) > archiveExportWindowLimit {
		records = records[:archiveExportWindowLimit]
	}
	return records, total, total > int64(len(records)), nil
}

// renderArchiveRecord 按列定义从 `_source` 渲染一行。
func renderArchiveRecord(columns []archiveExportColumn, source map[string]any) []string {
	record := make([]string, 0, len(columns))
	for _, column := range columns {
		if column.render != nil {
			record = append(record, column.render(source))
			continue
		}
		record = append(record, archiveFieldString(source[column.field]))
	}
	return record
}

// archiveFieldString 把 ES 返回的任意 JSON 值渲染成 CSV 单元格文本。
func archiveFieldString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		// JSON 数字统一解码成 float64：整数不要显示成 1e+06 这种科学计数法。
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case []any:
		// 多值字段（如数组）用 JSON 原样呈现，避免信息丢失。
		data, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(data)
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(data)
	}
}

// archiveHeaders 取出列定义里的表头。
func archiveHeaders(columns []archiveExportColumn) []string {
	headers := make([]string, 0, len(columns))
	for _, column := range columns {
		headers = append(headers, column.header)
	}
	return headers
}
