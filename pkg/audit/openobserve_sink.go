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

// ErrOpenObserveDisabled 表示 OpenObserve 通道未启用。调用方据此跳过，而不是当成故障。
var ErrOpenObserveDisabled = errors.New("openobserve archiving is disabled")

// OpenObserveSink 把审计/访问日志写进 OpenObserve，并从它检索。
//
// 与 ES sink 的区别（见 docs/dev/plans/2026-09-21-新增审计落地方式.md）：
//   - 写入走 `/api/{org}/{stream}/_json`（JSON 数组 + Basic 认证），不是 ES 的 bulk NDJSON；
//   - 检索走 OpenObserve **自己的**搜索接口（SQL 模式），不假定与 ES 的查询 DSL 等价；
//   - **单流**，不自己按天分区；过期数据由服务端按 stream 的 `data_retention` 负责（客户端不删）。
//
// # OpenObserve 版本升级的隔离点
//
// 它的 HTTP 接口在不同版本间有过调整，所以这套「请求体 + 响应体 + 路径」只出现在下面这几个
// 类型与函数里：`openObserveIngestPath` / `openObserveSearchPath` / `openObserveSearchRequest` /
// `openObserveSearchQuery` / `openObserveSearchResponse` / `parseOpenObserveTotal` / `insert` /
// `search`。升级导致接口变化时，改动应当只落在这一处；单测用固定的请求/响应样本钉住形状，
// 接口一变测试就失败，而不是静默查到错数据（见 openobserve_sink_test.go）。
type OpenObserveSink struct {
	client    *http.Client
	endpoints *logSinkEndpoints
	config    model.OpenObserveArchive
}

// NewOpenObserveSink 按配置构造客户端。未启用时返回 ErrOpenObserveDisabled。
func NewOpenObserveSink(config model.OpenObserveArchive) (*OpenObserveSink, error) {
	if !config.Enabled {
		return nil, ErrOpenObserveDisabled
	}
	if len(config.URLs) == 0 {
		return nil, errors.New("openobserve urls are required")
	}
	return &OpenObserveSink{
		client:    logSinkClient(config.TLSInsecureSkipVerify),
		endpoints: newLogSinkEndpoints(config.URLs),
		config:    config,
	}, nil
}

// OpenObserve 的接口路径与内置字段。
const (
	// ooIngestPathSuffix 是 JSON 摄取接口：body 是记录数组（官方文档的 curl 示例即此接口）。
	ooIngestPathSuffix = "/_json"
	// ooSearchPathSuffix 是检索接口（SQL 模式）。
	ooSearchPathSuffix = "/_search"
	// ooHealthPath 是健康检查接口（不需要认证，用于保存配置后的连通性自检）。
	ooHealthPath = "/healthz"
	// ooTimestampField 是 OpenObserve 的默认时间戳列，单位**微秒**。
	//
	// 我们写入时显式带上它，避免 OpenObserve 用「摄取时间」代替事件时间（补传/重试时两者能差很远）。
	// 若某个部署的 stream 配了别的时间戳列，OO 侧要用流设置 / 摄取管道对齐；我们的业务时间字段
	// `created_at` / `ts` 始终照常写入，检索与列表展示都不依赖这一列。
	ooTimestampField = "_timestamp"
	// ooContentType 是 `_json` 与 `_search` 共用的请求内容类型。
	ooContentType = "application/json"
	// ooMaxPageSize 是单页最大条数：OpenObserve 对 `size` 有上限，越界会让查询直接报错。
	ooMaxPageSize = 1000
)

// Write 把一批文档写入 OpenObserve（一个 `_json` 请求）。
func (s *OpenObserveSink) Write(ctx context.Context, docs []ESDocument) error {
	if len(docs) == 0 {
		return nil
	}

	records := openObserveRecords(docs)
	body, err := json.Marshal(records)
	if err != nil {
		return fmt.Errorf("failed to encode the openobserve payload: %w", err)
	}

	urls, err := s.candidateURLs()
	if err != nil {
		return err
	}

	var lastErr error
	for _, base := range urls {
		// 与 VictoriaLogs sink 同策略：重试只包住「对某一个地址的一次写入」，换地址属于故障切换，
		// 不该被重试放大成 N 倍请求量。
		lastErr = writeLogSinkWithRetry(ctx, "openobserve", func(ctx context.Context) error {
			return s.insert(ctx, base, body)
		})
		if lastErr == nil {
			return nil
		}
	}
	return lastErr
}

// openObserveRecords 把中立文档转成 OpenObserve 的记录。
//
// 除调用方给的业务字段外只补两个：
//   - `kind`：与 ES / VictoriaLogs 同一约定，四类记录靠它区分（它们共用一个流）；
//   - `_timestamp`：OpenObserve 的时间戳列（微秒）。`At` 为零值时不写，让服务端用摄取时间。
//
// **绝不修改调用方传入的 doc.Fields**：同一批文档可能还要写别的 sink，把辅助字段写回调用方的
// map 会污染那边的 schema。
func openObserveRecords(docs []ESDocument) []map[string]any {
	records := make([]map[string]any, 0, len(docs))
	for _, doc := range docs {
		record := make(map[string]any, len(doc.Fields)+2)
		for key, value := range doc.Fields {
			record[key] = value
		}
		record[esFieldKind] = doc.Kind
		if !doc.At.IsZero() {
			record[ooTimestampField] = doc.At.UnixMicro()
		}
		records = append(records, record)
	}
	return records
}

// openObserveIngestPath 返回 JSON 摄取接口的路径。
func (s *OpenObserveSink) openObserveIngestPath() string {
	return "/api/" + url.PathEscape(s.org()) + "/" + url.PathEscape(s.stream()) + ooIngestPathSuffix
}

// openObserveSearchPath 返回检索接口的路径。
//
// 必须用 **org 级** 路径 `/api/{org}/_search`：v0.91.1 上按流拼的
// `/api/{org}/{stream}/_search` 直接返回 404（实测），而 SQL 里已经写了
// `from "<stream>"`，并不损失信息。旧写法会让整条 OO 通道“写得进、读不出”——
// 审计界面永远报错（验收台账 D-179）。
func (s *OpenObserveSink) openObserveSearchPath() string {
	return "/api/" + url.PathEscape(s.org()) + ooSearchPathSuffix
}

// insert 把已编码好的记录数组发往某一个地址。
func (s *OpenObserveSink) insert(ctx context.Context, base string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+s.openObserveIngestPath(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to build the openobserve ingest request: %w", err)
	}
	req.Header.Set("Content-Type", ooContentType)
	s.setBasicAuth(req)

	res, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to write into openobserve at %s: %w", base, err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}

	failure := fmt.Errorf("openobserve ingest into %s failed: HTTP %d: %s",
		s.stream(), res.StatusCode, readOpenObserveSnippet(res.Body))
	// 4xx 是请求/凭据/数据本身的问题，重试无意义（多 %w：既保留「不可重试」标记，也保留状态码）。
	if res.StatusCode >= 400 && res.StatusCode < 500 {
		return fmt.Errorf("%w: %w", errLogSinkNotRetryable, failure)
	}
	return failure
}

// openObserveSearchQuery 是 `_search` 请求体里的 query 对象。
//
// 高风险面：字段名与语义（尤其 `start_time` / `end_time` 的单位是微秒、以及 `from` / `size` 的
// 分页语义）一旦变化，改这里即可。
type openObserveSearchQuery struct {
	SQL       string `json:"sql"`
	StartTime int64  `json:"start_time"`
	EndTime   int64  `json:"end_time"`
	From      int    `json:"from"`
	Size      int    `json:"size"`
}

// openObserveSearchRequest 是 `_search` 的请求体。
type openObserveSearchRequest struct {
	Query openObserveSearchQuery `json:"query"`
}

// openObserveSearchResponse 是 `_search` 的响应体。
//
// Hits 保持 `json.RawMessage`：下游 adaptArchiveHits 会按字段名适配成与库查询同构的 JSON，
// 这里不需要（也不应该）理解具体 schema。Total 用 RawMessage 是刻意的——不同版本/查询类型可能
// 给数字或字符串，见 parseOpenObserveTotal。
type openObserveSearchResponse struct {
	Hits  []json.RawMessage `json:"hits"`
	Total json.RawMessage   `json:"total"`
}

// Search 用 OpenObserve 的 SQL 检索接口查询归档记录。
func (s *OpenObserveSink) Search(ctx context.Context, query archiveQuery, from, to time.Time, page, size int) (*archiveSearchResult, error) {
	sql, err := s.openObserveSQL(query)
	if err != nil {
		return nil, err
	}

	start, end := openObserveTimeRange(from, to)

	payload, err := json.Marshal(openObserveSearchRequest{Query: openObserveSearchQuery{
		SQL:       sql,
		StartTime: start,
		EndTime:   end,
		From:      openObserveOffset(page, size),
		Size:      openObservePageSize(size),
	}})
	if err != nil {
		return nil, fmt.Errorf("failed to encode the openobserve search request: %w", err)
	}

	urls, err := s.candidateURLs()
	if err != nil {
		return nil, err
	}

	var lastErr error
	for _, base := range urls {
		result, err := s.search(ctx, base, payload)
		if err == nil {
			return result, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// search 向某一个地址发起一次检索。
func (s *OpenObserveSink) search(ctx context.Context, base string, payload []byte) (*archiveSearchResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+s.openObserveSearchPath(), bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("failed to build the openobserve search request: %w", err)
	}
	req.Header.Set("Content-Type", ooContentType)
	s.setBasicAuth(req)

	res, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to search openobserve at %s: %w", base, err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("openobserve search at %s failed: HTTP %d: %s",
			base, res.StatusCode, readOpenObserveSnippet(res.Body))
	}

	var parsed openObserveSearchResponse
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("failed to decode the openobserve search response: %w", err)
	}
	return &archiveSearchResult{Total: parseOpenObserveTotal(parsed.Total), Hits: parsed.Hits}, nil
}

// Ping 探测 OpenObserve 是否可达（保存配置后的连通性自检）。
func (s *OpenObserveSink) Ping(ctx context.Context) error {
	urls, err := s.candidateURLs()
	if err != nil {
		return err
	}

	var lastErr error
	for _, base := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+ooHealthPath, nil)
		if err != nil {
			lastErr = fmt.Errorf("failed to build the openobserve health request: %w", err)
			continue
		}
		res, err := s.client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("failed to reach openobserve at %s: %w", base, err)
			continue
		}
		status := res.StatusCode
		_ = res.Body.Close()
		if status >= 200 && status < 300 {
			return nil
		}
		lastErr = fmt.Errorf("openobserve at %s returned HTTP %d", base, status)
	}
	return lastErr
}

// candidateURLs 返回本次要尝试的地址顺序。
func (s *OpenObserveSink) candidateURLs() ([]string, error) {
	urls := s.endpoints.candidates()
	if len(urls) == 0 {
		return nil, errors.New("openobserve urls are required")
	}
	return urls, nil
}

// org 返回组织名（空值回落默认组织）。
func (s *OpenObserveSink) org() string {
	if org := strings.TrimSpace(s.config.Org); org != "" {
		return org
	}
	return model.DefaultOpenObserveOrg
}

// stream 返回日志流名（空值回落默认流名）。
//
// 连字符要按 OpenObserve 自己的规则换成下划线：实测 OO 建流时会把 `r24-audit`
// 改存为 `r24_audit`，而按原名检索会报 `Search stream not found`。平台默认值
// `aerolink-audit` 本身就带连字符，不在这里归一化的话写入与读取就会分在两个流上
// （验收台账 D-180）。
func (s *OpenObserveSink) stream() string {
	return strings.ReplaceAll(streamNameOrDefault(s.config.Stream), "-", "_")
}

// setBasicAuth 设置 Basic 认证（OpenObserve 的用户名通常是登录邮箱）。
//
// 用户名与密码都为空时不发认证头：有些内网部署关掉了鉴权，硬塞一个空 Basic 头反而会被拒。
func (s *OpenObserveSink) setBasicAuth(req *http.Request) {
	if s.config.Username == "" && s.config.Password == "" {
		return
	}
	req.SetBasicAuth(s.config.Username, string(s.config.Password))
}

// openObserveSQL 把中立条件渲染成 OpenObserve 的 SQL 查询。
//
// 两条刻意的取舍：
//   - **时间窗不写进 SQL**：`_search` 请求体里有专门的 `start_time` / `end_time`（微秒），比在 SQL
//     里比较时间列更稳（时间列名可能被 stream 设置改掉）；分页同理走请求体。
//   - `SELECT *`：四类记录的字段集不同，列裁剪的收益不值得再维护一份列清单；下游按字段名适配，
//     多出来的内部列（`_timestamp` / `_o2_id` 等）会被忽略。
//
// 字段名与字面量一律复用 archive_condition.go 的白名单与转义：SQL 里绝不直接拼用户输入。
func (s *OpenObserveSink) openObserveSQL(query archiveQuery) (string, error) {
	if len(archiveColumnsFor(query.kind)) == 0 {
		return "", fmt.Errorf("unsupported archive kind %q", query.kind)
	}

	stream, err := openObserveIdentifier(s.stream())
	if err != nil {
		return "", err
	}

	where, err := toSQLWhere(query.filters, query.timeField, time.Time{}, time.Time{})
	if err != nil {
		return "", err
	}

	// 四类记录共用一个流，靠 `kind` 区分。kind 只来自我们自己的常量，但仍按字面量转义后拼接。
	kindLiteral, err := sqlLiteral(query.kind)
	if err != nil {
		return "", err
	}
	clauses := esFieldKind + " = " + kindLiteral
	if where != "TRUE" {
		clauses += " AND (" + where + ")"
	}

	// 显式按时间倒序：分页要求稳定的顺序，否则翻页时可能重复或漏行。
	return fmt.Sprintf("SELECT * FROM %s WHERE %s ORDER BY %s DESC", stream, clauses, ooTimestampField), nil
}

// openObserveIdentifier 把流名渲染成 SQL 标识符（双引号包裹，内部双引号翻倍）。
//
// 流名来自配置（管理员填写），仍然走一遍转义与拒绝 NUL：它是唯一进入 SQL 的标识符。
func openObserveIdentifier(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", errors.New("openobserve stream is required")
	}
	if strings.ContainsRune(trimmed, 0) {
		return "", errors.New("openobserve stream contains a NUL byte")
	}
	return `"` + strings.ReplaceAll(trimmed, `"`, `""`) + `"`, nil
}

// parseOpenObserveTotal 解析响应里的 total。
//
// 有版本/查询类型把总数编码成字符串（与 VictoriaLogs 的 stats 输出一样），所以数字与字符串都要认；
// 缺失（空 RawMessage）或解析不出来时返回 0：总数只影响「共 N 条」的展示，不该让整页查询失败。
func parseOpenObserveTotal(raw json.RawMessage) int64 {
	value := strings.TrimSpace(string(raw))
	if value == "" || value == "null" {
		return 0
	}
	value = strings.Trim(value, `"`)
	total, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		klog.Warningf("unexpected openobserve total value %q, treating it as 0", value)
		return 0
	}
	return total
}

// openObserveOffset 返回分页偏移量。
func openObserveOffset(page, size int) int {
	if page < 1 {
		page = 1
	}
	return (page - 1) * openObservePageSize(size)
}

// openObservePageSize 收敛单页条数到 OpenObserve 允许的范围。
func openObservePageSize(size int) int {
	if size <= 0 {
		return 20
	}
	if size > ooMaxPageSize {
		return ooMaxPageSize
	}
	return size
}

// unixMicros 把时间转成 OpenObserve 需要的微秒时间戳；零值返回 0（表示调用方没给这个边界）。
func unixMicros(at time.Time) int64 {
	if at.IsZero() {
		return 0
	}
	return at.UnixMicro()
}

// openobserveEpochFloorMicro 是下界的回退值（纪元后 1 秒）：语义上等于「没有下界」。
const openobserveEpochFloorMicro int64 = 1_000_000

// openObserveTimeRange 把可空的 from / to 夹成 OpenObserve 能接受的窗口。
//
// 实测 v0.91.1：`start_time=0` 会被直接拒掉（HTTP 400 `[file_list] invalid time range`），
// 即使 end 是有效值也一样——旧注释里「0 = 不限制该边界」的假设不成立。而调用方不传时间窗时
// 两侧恰好都是零值，结果是审计接口整个 500（验收台账 D-181）。
func openObserveTimeRange(from, to time.Time) (int64, int64) {
	start, end := unixMicros(from), unixMicros(to)
	if start <= 0 {
		start = openobserveEpochFloorMicro
	}
	if end <= start {
		// to 缺失或不在 from 之后：以当下为上界，而不是把无效窗口丢给服务端。
		if now := time.Now().UnixMicro(); now > start {
			end = now
		}
	}
	return start, end
}

// openObserveSnippetBytes 是错误信息里保留的响应片段长度：够看出原因，又不至于把整页 HTML 灌进日志。
const openObserveSnippetBytes = 512

// readOpenObserveSnippet 读取错误响应的一小段。
func readOpenObserveSnippet(body io.Reader) string {
	snippet, err := io.ReadAll(io.LimitReader(body, openObserveSnippetBytes))
	if err != nil {
		return "<unreadable response>"
	}
	return string(bytes.TrimSpace(snippet))
}
