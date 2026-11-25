package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
)

// archiveQueryTimeout 是单次归档检索的超时。ES 不可达时不能让请求一直挂着。
const archiveQueryTimeout = 15 * time.Second

// archiveQuery 描述一次归档检索：文档分类、时间字段与额外的过滤条件。
//
// 归档查询走 ES（检索面），本地/S3 的 parquet 只作下载导出（见方案 §10.4 决策点 4）。
type archiveQuery struct {
	kind      string
	timeField string
	filters   []archiveCondition
}

// QueryAuditHistoryArchive 检索归档的操作日志。
//
// 路由：GET /api/v1/admin/audit-history-archive（需 settings.audit 的读权限）
func QueryAuditHistoryArchive(c *gin.Context) {
	filters, ok := auditHistoryArchiveFilters(c)
	if !ok {
		return
	}
	respondArchiveQuery(c, archiveQuery{
		kind:      ESKindAuditHistory,
		timeField: esFieldCreatedAt,
		filters:   filters,
	})
}

// QueryLoginRecordArchive 检索归档的登录日志（含失败尝试）。
//
// 路由：GET /api/v1/admin/login-record-archive
func QueryLoginRecordArchive(c *gin.Context) {
	filters, ok := loginRecordArchiveFilters(c)
	if !ok {
		return
	}
	respondArchiveQuery(c, archiveQuery{
		kind:      ESKindLoginRecord,
		timeField: esFieldCreatedAt,
		filters:   filters,
	})
}

// QueryAccessLogArchive 检索归档的访问日志。
//
// 路由：GET /api/v1/admin/access-log-archive
func QueryAccessLogArchive(c *gin.Context) {
	filters, ok := accessLogArchiveFilters(c)
	if !ok {
		return
	}
	respondArchiveQuery(c, archiveQuery{
		kind:      ESKindAccessLog,
		timeField: esFieldTimestamp,
		filters:   filters,
	})
}

// auditHistoryArchiveFilters 解析操作日志的过滤条件（与本地列表接口同名的参数）。
//
// 返回的是与后端无关的中立条件：同一份条件既能渲染成 ES DSL，也能渲染成 DuckDB 的 SQL。
//
// **必须与本地列表接口的参数一一对应**：少一个就意味着「筛了没反应」——那种静默失效比
// 报错更难发现（用户以为筛出来了，实际是全量）。
func auditHistoryArchiveFilters(c *gin.Context) ([]archiveCondition, bool) {
	conditions := make([]archiveCondition, 0, 8)
	// 归档里同样存在修复前写入的编码集群名（见 clusterNameVariants），两种写法都匹配。
	if cluster := strings.TrimSpace(c.Query("cluster")); cluster != "" {
		values := make([]any, 0, 2)
		for _, name := range clusterNameVariants(cluster) {
			values = append(values, name)
		}
		conditions = append(conditions, archiveCondition{field: esFieldClusterName, op: opIn, value: values})
	}
	addEqCondition(&conditions, esFieldOperationType, c.Query("operation"))
	addEqCondition(&conditions, esFieldResourceType, c.Query("resourceType"))
	addEqCondition(&conditions, esFieldResourceName, c.Query("resourceName"))
	addEqCondition(&conditions, esFieldNamespace, c.Query("namespace"))
	if condition, ok := containsCondition(c.Query("search"), esFieldResourceName, esFieldOperatorName); ok {
		conditions = append(conditions, condition)
	}
	var ok bool
	if conditions, ok = appendNumericEq(conditions, c, "operatorId", "operator_id"); !ok {
		return nil, false
	}
	// 多值过滤（operations）：无值即「不限制」，不需要返回值判断合法性。
	conditions = appendInCondition(conditions, c, esFieldOperationType, "operations")
	return conditions, true
}

// loginRecordArchiveFilters 解析登录日志的过滤条件。
func loginRecordArchiveFilters(c *gin.Context) ([]archiveCondition, bool) {
	conditions := make([]archiveCondition, 0, 4)
	addEqCondition(&conditions, esFieldUsername, c.Query("username"))
	addEqCondition(&conditions, esFieldProvider, c.Query("provider"))
	switch strings.TrimSpace(c.Query("outcome")) {
	case "success":
		// 归档里成功的登录统一写成 "success"（见 model.AuditResultSuccess），
		// 而不是本地库里的空串。
		addEqCondition(&conditions, esFieldResult, model.AuditResultSuccess)
	case "failure":
		conditions = append(conditions, notEqCondition(esFieldResult, model.AuditResultSuccess))
	}
	if conditions, ok := appendNumericEq(conditions, c, "userId", "user_id"); ok {
		if search := strings.TrimSpace(c.Query("search")); search != "" {
			if condition, ok := containsCondition(search, esFieldUsername, "ip"); ok {
				conditions = append(conditions, condition)
			}
		}
		return conditions, true
	}
	return nil, false
}

// passwordChangeArchiveFilters 解析改密日志的过滤条件。
//
// 改密日志没有单独的归档检索接口（它只有列表接口），但检索后端本身支持这类 kind，
// 所以切 sink 后列表直接复用同一套条件即可，不必为此新增路由。
func passwordChangeArchiveFilters(c *gin.Context) ([]archiveCondition, bool) {
	conditions := make([]archiveCondition, 0, 2)
	conditions, ok := appendNumericEq(conditions, c, "userId", "user_id")
	if !ok {
		return nil, false
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		if condition, ok := containsCondition(search, esFieldUsername, "operator"); ok {
			conditions = append(conditions, condition)
		}
	}
	return conditions, true
}

// appendNumericEq 把形如 operatorId / userId 的数字筛选项追加成等值条件。
//
// 数字必须按类型渲染（不能当字符串拼），否则 SQL 侧会变成 `operator_id = '3'` 这类隐式转换，
// 在部分引擎上无法走索引。参数非法时返回 ok=false，由调用方写出 400。
func appendNumericEq(conditions []archiveCondition, c *gin.Context, param, field string) ([]archiveCondition, bool) {
	value, ok := parseUintQuery(c, param)
	if !ok {
		return nil, false
	}
	if value == 0 {
		return conditions, true
	}
	return append(conditions, archiveCondition{field: field, op: opEq, value: int(value)}), true
}

// appendInCondition 把逗号分隔的多值参数追加成 IN 条件（空值表示"不限制"）。
func appendInCondition(conditions []archiveCondition, c *gin.Context, field, param string) []archiveCondition {
	raw := parseOperationList(c.Query(param))
	if len(raw) == 0 {
		return conditions
	}
	values := make([]any, 0, len(raw))
	for _, value := range raw {
		values = append(values, value)
	}
	return append(conditions, archiveCondition{field: field, op: opIn, value: values})
}

// accessLogArchiveFilters 解析访问日志的过滤条件。
func accessLogArchiveFilters(c *gin.Context) ([]archiveCondition, bool) {
	conditions := make([]archiveCondition, 0, 5)
	// 访问日志的集群名取自 ClusterMiddleware 注入的上下文值（已解码），不存在历史编码串问题。
	addEqCondition(&conditions, esFieldClusterName, c.Query("cluster"))
	addEqCondition(&conditions, esFieldMethod, c.Query("method"))
	addEqCondition(&conditions, esFieldClientIP, c.Query("clientIp"))
	addEqCondition(&conditions, esFieldPath, c.Query("path"))

	condition, err := statusCodeCondition(c.Query("statusCode"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid statusCode parameter"})
		return nil, false
	}
	if condition.field != "" {
		conditions = append(conditions, condition)
	}
	return conditions, true
}

// keywordField 返回字符串字段的 keyword 子字段名。
//
// 索引 mapping 由 ES 动态生成：字符串会映射成 text（并自动带 .keyword 子字段）。
// 对 text 字段做 term 查询会先分词再匹配，`PUT` 这种大写值匹配不上（分析器把索引与
// 查询都小写化，而 term 查询本身不做分析）。精确匹配必须落到 .keyword。
func keywordField(field string) string {
	return field + ".keyword"
}

// respondArchiveQuery 是所有归档检索接口共用的收尾：解析分页与时间范围 → 检索 → 返回
// {data,total,page,size}（与本地列表接口同构，前端可复用同一套分页组件）。
func respondArchiveQuery(c *gin.Context, query archiveQuery) {
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}
	from, to, ok := parseTimeRange(c)
	if !ok {
		return
	}
	from, to = effectiveTimeRange(from, to, toIsDateOnly(c))

	searcher, backend, err := currentArchiveSearcher(parseArchiveBackend(c))
	if err != nil {
		// 两个后端都不可用是配置问题而非故障：明确告知，而不是返回空列表让管理员以为没有数据。
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), archiveQueryTimeout)
	defer cancel()

	result, err := searcher.Search(ctx, query, from, to, page, size)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	// 响应里的 data 必须是数组：nil 会被序列化成 `null`，而界面把它当数组用
	// （`data.length`），null 会让整个归档页崩掉。检索后端各自都应给非 nil 切片，
	// 这里再兜一道——OpenObserve 这类外部后端的响应里 hits 缺失时就是 nil。
	hits := result.Hits
	if hits == nil {
		hits = []json.RawMessage{}
	}
	c.JSON(http.StatusOK, gin.H{
		"data":    hits,
		"total":   result.Total,
		"page":    page,
		"size":    size,
		"backend": string(backend),
	})
}

// archiveSearchResult 是一次检索的归一化结果：Total 与命中文档的 _source。
type archiveSearchResult struct {
	Total int64
	Hits  []json.RawMessage
}

// Search 在归档索引上执行一次检索。索引尚未建立时返回空结果而不是错误
// （打开开关但还没到第一个 flush 边界是正常状态）。
// 索引通配（`<前缀>-*`）由 es_sink.go 的 indexPattern 提供，与按天索引的创建/删除同一份口径。
func (s *ESSink) Search(ctx context.Context, query archiveQuery, from, to time.Time, page, size int) (*archiveSearchResult, error) {
	payload, err := json.Marshal(buildESSearchBody(query, from, to, page, size))
	if err != nil {
		return nil, fmt.Errorf("failed to encode search request: %w", err)
	}

	res, err := s.client.Search(
		s.client.Search.WithContext(ctx),
		s.client.Search.WithIndex(s.indexPattern()),
		s.client.Search.WithBody(bytes.NewReader(payload)),
		s.client.Search.WithTrackTotalHits(true),
		// 索引还不存在时返回空结果，而不是 404。
		s.client.Search.WithIgnoreUnavailable(true),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to search archive index: %w", err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.IsError() {
		return nil, fmt.Errorf("elasticsearch search failed: %s", res.String())
	}

	var parsed struct {
		Hits struct {
			Total struct {
				Value int64 `json:"value"`
			} `json:"total"`
			Hits []struct {
				Source json.RawMessage `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("failed to decode search response: %w", err)
	}

	hits := make([]json.RawMessage, 0, len(parsed.Hits.Hits))
	for _, hit := range parsed.Hits.Hits {
		hits = append(hits, hit.Source)
	}
	return &archiveSearchResult{Total: parsed.Hits.Total.Value, Hits: hits}, nil
}

// buildESSearchBody 组装检索 DSL：按分类 + 时间窗口 + 额外条件过滤，按时间倒序分页。
func buildESSearchBody(query archiveQuery, from, to time.Time, page, size int) map[string]any {
	filters := make([]map[string]any, 0, len(query.filters)+2)
	filters = append(filters, map[string]any{"term": map[string]any{esFieldKind: query.kind}})

	if !from.IsZero() || !to.IsZero() {
		bounds := map[string]any{}
		if !from.IsZero() {
			bounds["gte"] = from.Format(time.RFC3339)
		}
		if !to.IsZero() {
			bounds["lt"] = to.Format(time.RFC3339)
		}
		filters = append(filters, map[string]any{"range": map[string]any{query.timeField: bounds}})
	}
	filters = append(filters, toESFilters(query.filters)...)

	return map[string]any{
		"query": map[string]any{"bool": map[string]any{"filter": filters}},
		"sort":  []map[string]any{{query.timeField: map[string]any{"order": "desc"}}},
		"from":  (page - 1) * size,
		"size":  size,
	}
}
