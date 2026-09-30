package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// ErrVictoriaLogsDisabled 表示 VictoriaLogs 通道未启用。调用方据此跳过，而不是当成故障。
var ErrVictoriaLogsDisabled = errors.New("victorialogs archiving is disabled")

// VictoriaLogsSink 把审计/访问日志写进 VictoriaLogs，并从它检索。
//
// 与 ES sink 的区别（见 docs/dev/plans/2026-09-21-新增审计落地方式.md）：
//   - 写入走 ES bulk 兼容接口 `/insert/elasticsearch/_bulk`（纯 HTTP，不引第三方客户端库）；
//   - 检索走 LogsQL（`/select/logsql/query`），而不是 ES 的查询 DSL；
//   - **单流**，不自己按天分区；过期数据由服务端 `-retentionPeriod` 负责（客户端不删）。
//
// 因此这里没有索引名/按天分组的逻辑，`_time` 由服务端按接收时间分区；时间窗改为在检索接口上
// 用 `start`/`end` 参数表达（见 Search）。
type VictoriaLogsSink struct {
	client    *http.Client
	endpoints *logSinkEndpoints
	config    model.VictoriaLogsArchive
}

// NewVictoriaLogsSink 按配置构造客户端。未启用时返回 ErrVictoriaLogsDisabled。
func NewVictoriaLogsSink(config model.VictoriaLogsArchive) (*VictoriaLogsSink, error) {
	if !config.Enabled {
		return nil, ErrVictoriaLogsDisabled
	}
	if len(config.URLs) == 0 {
		return nil, errors.New("victorialogs urls are required")
	}
	return &VictoriaLogsSink{
		client:    logSinkClient(config.TLSInsecureSkipVerify),
		endpoints: newLogSinkEndpoints(config.URLs),
		config:    config,
	}, nil
}

// VictoriaLogs 的接口路径。
const (
	// vlInsertPath 是 ES bulk 兼容的写入接口（NDJSON：动作行 + 文档行）。
	vlInsertPath = "/insert/elasticsearch/_bulk"
	// vlSelectPath 是 LogsQL 检索接口（响应同样是一行一个 JSON 的流）。
	vlSelectPath = "/select/logsql/query"
)

// VictoriaLogs 的内置字段名。
const (
	// vlFieldTime 是事件时间列（RFC3339），决定记录落到哪个按天分区。
	vlFieldTime = "_time"
	// vlFieldMessage 是日志正文列：不填在 VL 的 Web UI / Grafana 里只显示 `-`。
	vlFieldMessage = "_msg"
	// vlCountAlias 是总数统计的输出字段名（`| stats count() total`）。
	vlCountAlias = "total"
)

// Write 把一批文档写入 VictoriaLogs（一个 bulk 请求）。
//
// 请求体只编码一次：多个地址是「同一份数据换个入口」，重编码既浪费，也可能让各地址收到不同内容。
func (s *VictoriaLogsSink) Write(ctx context.Context, docs []ESDocument) error {
	if len(docs) == 0 {
		return nil
	}

	body, err := victoriaLogsBulkBody(docs)
	if err != nil {
		return err
	}

	urls, err := s.candidateURLs()
	if err != nil {
		return err
	}

	var lastErr error
	for _, base := range urls {
		// 重试只包住「对某一个地址的一次写入」：换地址属于故障切换，不该被重试放大成 N 倍请求量。
		// 4xx 在 writeLogSinkWithRetry 里已经短路（不重试），但仍换下一个地址试一次——多地址
		// 场景下各节点的租户/权限配置未必一致，而每个地址最多只发一次，代价可控。
		lastErr = writeLogSinkWithRetry(ctx, "victorialogs", func(ctx context.Context) error {
			return s.insert(ctx, base, body)
		})
		if lastErr == nil {
			return nil
		}
	}
	return lastErr
}

// victoriaLogsBulkBody 把中立文档编码成 ES bulk 兼容的 NDJSON（`{"create":{}}` + 文档）。
//
// 除调用方给的业务字段外，只补三个：
//   - `kind`：与 ES sink 同一约定。VL 侧没有按天索引，检索只能靠字段区分四类记录；
//   - `_time`：VL 的事件时间列。`At` 为零值时**不写**这个字段，让服务端用接收时间——RFC3339
//     表达不了「零值」，硬写一个 0001-01-01 会把记录扔到保留期之外；
//   - `_msg`：VL 的日志正文（见 documentSummary）。
//
// **绝不修改调用方传入的 doc.Fields**：同一批文档可能还要写别的 sink（ES），把辅助字段写回
// 调用方的 map 会污染那边的 schema。
func victoriaLogsBulkBody(docs []ESDocument) ([]byte, error) {
	var buffer bytes.Buffer
	for _, doc := range docs {
		if err := writeNDJSON(&buffer, map[string]any{"create": map[string]any{}}); err != nil {
			return nil, err
		}

		// 复制一份再补字段，避免写回调用方的 map（副作用）。
		body := make(map[string]any, len(doc.Fields)+3)
		for key, value := range doc.Fields {
			body[key] = value
		}
		body[esFieldKind] = doc.Kind
		if !doc.At.IsZero() {
			body[vlFieldTime] = doc.At.Format(time.RFC3339)
		}
		body[vlFieldMessage] = documentSummary(doc)

		if err := writeNDJSON(&buffer, body); err != nil {
			return nil, err
		}
	}
	return buffer.Bytes(), nil
}

// insert 把已编码好的 bulk 请求体发往某一个地址。
func (s *VictoriaLogsSink) insert(ctx context.Context, base string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+vlInsertPath, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to build the victorialogs insert request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	s.setTenantHeaders(req)

	res, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to write into victorialogs at %s: %w", base, err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}

	// 状态码 + 响应片段：对端 502 时返回的整页 HTML 不该灌进日志与接口错误里（只读一小段）。
	failure := fmt.Errorf("victorialogs insert at %s failed: HTTP %d: %s",
		base, res.StatusCode, readVictoriaLogsSnippet(res.Body))
	// 4xx 是请求或数据本身有问题，重试无意义（5xx 与连接抖动才值得重试）。
	// 两个错误都保留（多 %w）：调用方既要能 errors.Is 到「不可重试」，也要能读到状态码与响应片段。
	if res.StatusCode >= 400 && res.StatusCode < 500 {
		return fmt.Errorf("%w: %w", errLogSinkNotRetryable, failure)
	}
	return failure
}

// Search 用 LogsQL 检索归档记录。
func (s *VictoriaLogsSink) Search(ctx context.Context, query archiveQuery, from, to time.Time, page, size int) (*archiveSearchResult, error) {
	logsQL, err := toLogsQLQuery(query)
	if err != nil {
		return nil, err
	}

	columns := archiveColumnsFor(query.kind)
	if len(columns) == 0 {
		return nil, fmt.Errorf("no queryable columns for archive kind %q", query.kind)
	}

	// 只取检索页需要的列：VL 按列存盘，`| fields` 能省掉大字段（resource_yaml 之类）的读盘。
	// 分页交给 HTTP 参数：`limit=N` 返回 `_time` 最大的 N 条、`offset=M` 跳过前 M 条，正是列表页
	// 要的顺序；再叠一个 `sort` 管道只会让服务端多一次没有必要的排序。
	pageQuery := logsQL + " | fields " + strings.Join(columns, ", ")

	urls, err := s.candidateURLs()
	if err != nil {
		return nil, err
	}

	var lastErr error
	for _, base := range urls {
		hits, err := s.selectLogs(ctx, base, pageQuery, from, to, size, (page-1)*size)
		if err != nil {
			// 一个地址不可用就换下一个（与写入同一套轮询/故障切换语义）。
			lastErr = err
			continue
		}

		result := &archiveSearchResult{Hits: hits}
		total, err := s.selectTotal(ctx, base, logsQL, from, to)
		if err != nil {
			// 总数拿不到不该让整页检索失败：少一个「共 N 条」好过一条记录都看不到。
			klog.Warningf("victorialogs total at %s failed, falling back to 0: %v", base, err)
		} else {
			result.Total = total
		}
		return result, nil
	}
	return nil, lastErr
}

// Ping 探测 VictoriaLogs 是否可达（保存配置后的连通性自检）。
//
// 用最小查询（`*` + limit=1）而不是别的固定接口：它一并验证地址、租户头与证书链，且不要求
// 流已经存在——「这份配置到底能不能用」正是要回答的问题。
func (s *VictoriaLogsSink) Ping(ctx context.Context) error {
	urls, err := s.candidateURLs()
	if err != nil {
		return err
	}

	var lastErr error
	for _, base := range urls {
		params := url.Values{}
		params.Set("query", "*")
		params.Set("limit", "1")
		if _, err := s.query(ctx, base, params); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

// candidateURLs 返回本次要尝试的地址；没有可用地址时明确报错。
//
// 兜底而不是「静默什么都不写」：地址列表已由 NewVictoriaLogsSink 校验过，这里防的是绕过构造
// 函数（或配置归一化后只剩空串）造出的空列表把整批审计数据悄悄丢掉。
func (s *VictoriaLogsSink) candidateURLs() ([]string, error) {
	urls := s.endpoints.candidates()
	if len(urls) == 0 {
		return nil, errors.New("victorialogs urls are required")
	}
	return urls, nil
}

// setTenantHeaders 按配置带上多租户标识。
//
// 写入与检索都要带：VL 默认落在 (AccountID=0, ProjectID=0) 租户，写进 A 租户却从 0 租户查，
// 界面上就是「一条记录也没有」。
func (s *VictoriaLogsSink) setTenantHeaders(req *http.Request) {
	if account := strings.TrimSpace(s.config.AccountID); account != "" {
		req.Header.Set("AccountID", account)
	}
	if project := strings.TrimSpace(s.config.ProjectID); project != "" {
		req.Header.Set("ProjectID", project)
	}
}

// query 执行一次 LogsQL 查询并读回整个响应体。
//
// 响应是 NDJSON 流（VL 边查边发），这里先整体读回再解析：我们总是带 `limit`（一页十几到几百
// 行），内存可控；真正无界的是不带 limit 的 `*` 查询，那种请求本 sink 不会发。
func (s *VictoriaLogsSink) query(ctx context.Context, base string, params url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+vlSelectPath, strings.NewReader(params.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to build the victorialogs query request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	s.setTenantHeaders(req)

	res, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to query victorialogs at %s: %w", base, err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("victorialogs query at %s failed: HTTP %d: %s",
			base, res.StatusCode, readVictoriaLogsSnippet(res.Body))
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read the victorialogs response from %s: %w", base, err)
	}
	return body, nil
}

// selectLogs 拉取一页命中记录，每行**原样**作为 json.RawMessage 返回。
//
// 不在这里做字段适配：下游 adaptArchiveHits 统一按 §5 schema → 模型字段名转换，两种检索后端
// 共用同一张映射表，多一层转换只会多一处会漂移的地方。
func (s *VictoriaLogsSink) selectLogs(ctx context.Context, base, logsQL string, from, to time.Time, limit, offset int) ([]json.RawMessage, error) {
	params := url.Values{}
	params.Set("query", logsQL)
	params.Set("limit", strconv.Itoa(limit))
	if offset > 0 {
		// offset 只在与 limit 同时出现时有分页语义（官方文档：两者一起构成简单分页）。
		params.Set("offset", strconv.Itoa(offset))
	}
	setLogsQLTimeRange(params, from, to)

	body, err := s.query(ctx, base, params)
	if err != nil {
		return nil, err
	}

	hits := make([]json.RawMessage, 0, 16)
	decoder := json.NewDecoder(bytes.NewReader(body))
	for {
		var hit json.RawMessage
		if err := decoder.Decode(&hit); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			// 解析失败要明确报错：宁可让管理员看到「响应不是预期格式」，也不要返回半页数据
			// 让人以为归档里就只有这些记录。
			return nil, fmt.Errorf("failed to decode the victorialogs response from %s: %w", base, err)
		}
		hits = append(hits, hit)
	}
	return hits, nil
}

// selectTotal 用一次 `| stats count() total` 查询取命中总数。
//
// VL 的 /select/logsql/query 不返回总数（它按流式响应设计），只能另发一次聚合查询。时间窗必须
// 一起带上，否则总数会把窗口外的记录也算进来，与列表页对不上。
func (s *VictoriaLogsSink) selectTotal(ctx context.Context, base, logsQL string, from, to time.Time) (int64, error) {
	params := url.Values{}
	params.Set("query", logsQL+" | stats count() "+vlCountAlias)
	setLogsQLTimeRange(params, from, to)

	body, err := s.query(ctx, base, params)
	if err != nil {
		return 0, err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		// 一条都没命中时 VL 可能给空响应体：那本身就是「总数 0」，不是错误。
		return 0, nil
	}

	var row map[string]any
	if err := json.Unmarshal(body, &row); err != nil {
		return 0, fmt.Errorf("failed to decode the victorialogs count response from %s: %w", base, err)
	}

	// 响应形如 {"total":"123"}：VL 的 stats 输出把数字编码成**字符串**（避免精度丢失）。这里也
	// 接受 JSON 数字，免得版本差异直接让总数悄悄退回 0。
	switch value := row[vlCountAlias].(type) {
	case string:
		total, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("unexpected victorialogs count %q from %s: %w", value, base, err)
		}
		return total, nil
	case float64:
		return int64(value), nil
	default:
		return 0, fmt.Errorf("victorialogs count response from %s has no %q field", base, vlCountAlias)
	}
}

// setLogsQLTimeRange 把时间窗作为 HTTP 参数传给 VL，而不是写进 LogsQL。
//
// 为什么不用 `_time:` 过滤器：`start`/`end` 是查询接口的一等参数，服务端据此直接跳过覆盖不到的
// 时间分区；另外 `end` 是**开区间**，与归档查询的半开区间 [from, to) 语义正好一致（ES sink 用的
// 也是 `lt`）。零值表示该侧不限制。
func setLogsQLTimeRange(params url.Values, from, to time.Time) {
	if !from.IsZero() {
		params.Set("start", from.Format(time.RFC3339))
	}
	if !to.IsZero() {
		params.Set("end", to.Format(time.RFC3339))
	}
}

// victoriaLogsSnippetBytes 是错误信息里响应片段的最大读取量。
const victoriaLogsSnippetBytes = 512

// readVictoriaLogsSnippet 读取响应体的一小段用于报错。
//
// 用 LimitReader 而不是「读全再截断」：对端返回 502 的整页 HTML 时，不该为了报错把整页读进内存。
func readVictoriaLogsSnippet(body io.Reader) string {
	raw, err := io.ReadAll(io.LimitReader(body, victoriaLogsSnippetBytes))
	if err != nil {
		return ""
	}
	return truncateForError(string(raw))
}

// toLogsQLQuery 把中立条件渲染成 LogsQL 的过滤片段（**不含**时间窗与分页）。
//
// 时间窗与分页刻意不在这里：前者走检索接口的 start/end 参数（让服务端跳过整天分区），后者走
// limit/offset 参数。
//
// 语法来源（2026-09-21 核对官方文档 https://docs.victoriametrics.com/victorialogs/logsql/）：
//   - 精确匹配 `field:="value"`（exact filter，值可加引号）；
//   - 取反 `NOT field:="value"`（logical filter；`NOT` 优先级最高，也可写 `field:!=value`）；
//   - 子串匹配 `field:*"substring"*`（substring filter，子串可加引号）；
//   - 多值 `field:in("v1", "v2")`（multi-exact filter）。
func toLogsQLQuery(query archiveQuery) (string, error) {
	// 条件之间显式写 AND：省略 AND 是合法简写，但拼错时更难看出来，而少一个条件就是「筛了没反应」。
	tokens := make([]string, 0, len(query.filters)+1)
	tokens = append(tokens, esFieldKind+":="+logsQLString(query.kind))

	for _, condition := range query.filters {
		rendered, err := toLogsQLCondition(condition)
		if err != nil {
			return "", err
		}
		if rendered == "" {
			continue
		}
		tokens = append(tokens, rendered)
	}
	return strings.Join(tokens, " AND "), nil
}

// toLogsQLCondition 渲染单个条件；返回空串表示「该条件不限制任何东西」（如空的 in 列表）。
func toLogsQLCondition(condition archiveCondition) (string, error) {
	switch condition.op {
	case opEq, opNotEq:
		field, err := logsQLIdentifier(condition.field)
		if err != nil {
			return "", err
		}
		value, err := logsQLValue(condition.value)
		if err != nil {
			return "", err
		}
		if condition.op == opNotEq {
			return "NOT " + field + ":=" + value, nil
		}
		return field + ":=" + value, nil

	case opContains:
		value, err := logsQLValue(condition.value)
		if err != nil {
			return "", err
		}
		matches := make([]string, 0, len(condition.searchFields))
		for _, field := range condition.searchFields {
			column, err := logsQLIdentifier(field)
			if err != nil {
				return "", err
			}
			// 两侧都要 `*`：只有一侧是「前缀/后缀」匹配，`api` 就匹配不到 `aerolink-api-server`。
			matches = append(matches, column+":*"+value+"*")
		}
		if len(matches) == 0 {
			return "", nil
		}
		// 多列之间是 OR，括号不能省：外层用 AND 连接，`a OR b AND c` 会被解析成 `a OR (b AND c)`。
		return "(" + strings.Join(matches, " OR ") + ")", nil

	case opIn:
		field, err := logsQLIdentifier(condition.field)
		if err != nil {
			return "", err
		}
		values, ok := condition.value.([]any)
		if !ok || len(values) == 0 {
			return "", nil
		}
		literals := make([]string, 0, len(values))
		for _, value := range values {
			literal, err := logsQLValue(value)
			if err != nil {
				return "", err
			}
			literals = append(literals, literal)
		}
		return field + ":in(" + strings.Join(literals, ", ") + ")", nil
	}

	// 未知 op 明确报错：静默跳过等于把过滤条件吃掉，返回的是「看起来像筛选结果」的全量数据。
	return "", fmt.Errorf("unsupported archive condition op %q", condition.op)
}

// logsQLIdentifier 校验字段名并返回可拼进 LogsQL 的列名。
//
// 复用 SQL 侧的白名单（archive_condition.go 的 allowedSQLColumns，与 §5 schema 一一对应）：
// 字段名目前一律来自包内常量，这里做纵深防御——即便将来有人把外部输入接到 field 上，也只会被
// 拒绝，而不是被拼进查询语句里。
func logsQLIdentifier(field string) (string, error) {
	if !allowedSQLColumns[field] {
		return "", fmt.Errorf("field %q is not allowed in archive queries", field)
	}
	return field, nil
}

// logsQLValue 按 Go 类型渲染 LogsQL 字面量。
//
// 数字/布尔**不加引号**：字段在 VL 里按值本身的类型存储，`status_code:="200"` 是拿字符串去比
// 数字列；这也与 SQL 侧「数字按数字渲染」的口径一致。字符串一律加引号（见 logsQLString）。
func logsQLValue(value any) (string, error) {
	switch typed := value.(type) {
	case string:
		return logsQLString(typed), nil
	case int:
		return strconv.Itoa(typed), nil
	case int64:
		return strconv.FormatInt(typed, 10), nil
	case bool:
		return strconv.FormatBool(typed), nil
	default:
		return "", fmt.Errorf("unsupported condition value type %T", value)
	}
}

// logsQLString 把字符串渲染成 LogsQL 的双引号字面量。
//
// 反斜杠与双引号按文档（字符串字面量一节）转义：关键字是用户输入，未转义的引号会把查询拼断，
// 甚至把后面的内容变成另一条过滤条件。逐字节复制不影响多字节字符。
func logsQLString(value string) string {
	var builder strings.Builder
	builder.Grow(len(value) + 2)
	builder.WriteByte('"')
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' || value[i] == '"' {
			builder.WriteByte('\\')
		}
		builder.WriteByte(value[i])
	}
	builder.WriteString("\"")
	return builder.String()
}
