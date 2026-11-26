package audit

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"aerolink/pkg/model"
	"github.com/elastic/go-elasticsearch/v8"
	"k8s.io/klog/v2"
)

// ErrESArchiveDisabled 表示 Elasticsearch 归档未启用。调用方据此跳过写入，而不是当成故障。
var ErrESArchiveDisabled = errors.New("elasticsearch archiving is disabled")

// ES 文档的分类（写入 `kind` 字段，查询接口按它过滤）。
// 四类文档共用按天索引 `<indexPrefix>-YYYY.MM.DD`。
const (
	ESKindAuditHistory      = "audit_history"
	ESKindLoginRecord       = "login_record"
	ESKindPasswordChangeLog = "password_change_log"
	ESKindAccessLog         = "access_log"
)

// ES 文档的字段名。字段集与 parquet schema（方案 §5）保持一致，
// 查询接口也按这些常量构造过滤条件，避免两侧字段名各自漂移。
const (
	esFieldKind          = "kind"
	esFieldCreatedAt     = "created_at"
	esFieldTimestamp     = "ts"
	esFieldClusterName   = "cluster_name"
	esFieldResourceType  = "resource_type"
	esFieldResourceName  = "resource_name"
	esFieldNamespace     = "namespace"
	esFieldOperationType = "operation_type"
	esFieldOperatorName  = "operator_name"
	esFieldUsername      = "username"
	esFieldProvider      = "provider"
	esFieldResult        = "result"
	esFieldClientIP      = "client_ip"
	// esFieldSourceIP 是登录日志的原始客户端 IP（X-Forwarded-For 最左边）。
	esFieldSourceIP   = "source_ip"
	esFieldMethod     = "method"
	esFieldPath       = "path"
	esFieldStatusCode = "status_code"
)

// ESDocument 是一条待写入的日志文档。
//
// Fields 由调用方按 §5 的 schema 填充（本 sink 不绑定具体结构，只负责按天索引与
// bulk 写入），Kind 会被注入到 `kind` 字段用于检索区分。
type ESDocument struct {
	// Kind 是文档分类，取值见 ESKind* 常量。
	Kind string
	// ID 是稳定标识（本地自增主键），用于重复投递时覆盖同一文档、保证幂等。
	ID string
	// At 是事件的业务时间，决定落到哪一天的索引。
	At time.Time
	// Fields 是文档正文字段，键名与 §5 schema 一致。
	Fields map[string]any
}

// ESSink 把审计/访问日志写入 Elasticsearch（按天索引，bulk + 重试）。
//
// 与 S3Sink 一样，它只负责「写入一批文档」：数据从哪来、本地 parquet 怎么落盘
// 都由调用方决定，因此可以脱离 writer 单独测试。ES 是**检索面**，不替代 S3 归档
// 与本地 MySQL（见方案 §8.2）。
type ESSink struct {
	client *elasticsearch.Client
	config model.ESArchive
}

// NewESSink 按配置构造 ES 客户端。未启用时返回 ErrESArchiveDisabled。
func NewESSink(config model.ESArchive) (*ESSink, error) {
	if !config.Enabled {
		return nil, ErrESArchiveDisabled
	}
	if len(config.URLs) == 0 {
		return nil, errors.New("elasticsearch urls are required")
	}

	client, err := elasticsearch.NewClient(elasticsearch.Config{
		Addresses: config.URLs,
		Username:  config.Username,
		Password:  string(config.Password),
		Transport: newESTransport(config.TLSInsecureSkipVerify),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create elasticsearch client: %w", err)
	}
	return &ESSink{client: client, config: config}, nil
}

// Ping 探测 ES 是否可达（保存配置后的连通性自检用）。
//
// 用集群根接口而不是 _search：它不要求索引已存在、权限要求最低，且能一并验证地址、认证与
// 证书链——正是"这份配置到底能不能用"要回答的问题。
func (s *ESSink) Ping(ctx context.Context) error {
	response, err := s.client.Info(s.client.Info.WithContext(ctx))
	if err != nil {
		return fmt.Errorf("failed to reach elasticsearch: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.IsError() {
		return fmt.Errorf("elasticsearch returned HTTP %s", response.Status())
	}
	return nil
}

// esIndexDateLayout 是索引名里日期后缀的格式（与 IndexName 一致）。
const esIndexDateLayout = "2006.01.02"

// indexPrefix 返回按天索引的前缀（未配置时用默认值）。
func (s *ESSink) indexPrefix() string {
	if s.config.IndexPrefix == "" {
		return model.DefaultESIndexPrefix
	}
	return s.config.IndexPrefix
}

// indexPattern 返回检索用的索引通配（跨天分区），如 `aerolink-audit-*`。
func (s *ESSink) indexPattern() string {
	return s.indexPrefix() + "-*"
}

// IndexName 返回某天对应的按天索引名：`<indexPrefix>-YYYY.MM.DD`。
func (s *ESSink) IndexName(at time.Time) string {
	return s.indexPrefix() + "-" + at.Format(esIndexDateLayout)
}

// indexDay 解析按天索引名里的那一天；名字不是 `<前缀>-YYYY.MM.DD` 时返回 false。
func (s *ESSink) indexDay(name string) (time.Time, bool) {
	suffix, ok := strings.CutPrefix(name, s.indexPrefix()+"-")
	if !ok {
		return time.Time{}, false
	}
	// 用本机时区解析：索引名是写入时按本机时间 Format 出来的（IndexName）。
	day, err := time.ParseInLocation(esIndexDateLayout, suffix, time.Local)
	if err != nil {
		return time.Time{}, false
	}
	return day, true
}

// DeleteIndicesBefore 删除「整天数据都已过期」的按天索引，返回被删掉的索引名。
//
// 过期数据按索引整体删除，而不是逐文档删除：索引名自带日期，删一个索引就是删掉那一天的
// 全部记录，代价与文档量无关（这也是 ES 侧一直用按天索引的原因）。因此**粒度只能到「天」**：
// 索引里装着那一天四类记录的全部文档，半天过期就删会把还在保留期内的记录一起删掉，所以
// 只有整天的数据都早于 cutoff 才动它。
//
// 只处理**能认出日期**的本应用索引：前缀不是本应用的、后缀不是日期的（同一集群里别人的索引、
// 或人工建的索引）一律跳过——保留策略宁可漏删，也不能误删别人的数据。
func (s *ESSink) DeleteIndicesBefore(ctx context.Context, cutoff time.Time) ([]string, error) {
	names, err := s.listIndices(ctx)
	if err != nil {
		return nil, err
	}

	deleted := make([]string, 0, len(names))
	var failures []error
	for _, name := range names {
		day, ok := s.indexDay(name)
		if !ok {
			continue
		}
		// 该索引覆盖 [day, day+1)：整天都早于 cutoff 才删（end == cutoff 时当天记录全部过期）。
		if end := day.AddDate(0, 0, 1); end.After(cutoff) {
			continue
		}

		res, err := s.client.Indices.Delete(
			[]string{name},
			s.client.Indices.Delete.WithContext(ctx),
		)
		if err != nil {
			failures = append(failures, fmt.Errorf("failed to delete index %s: %w", name, err))
			continue
		}
		status := res.StatusCode
		_ = res.Body.Close()
		if status == http.StatusNotFound {
			// 另一个副本（或上一次没跑完的清理）刚删掉了它：目标已经达成，不算失败。
			deleted = append(deleted, name)
			continue
		}
		if status >= http.StatusBadRequest {
			failures = append(failures, fmt.Errorf("failed to delete index %s: elasticsearch returned HTTP %d", name, status))
			continue
		}
		deleted = append(deleted, name)
	}
	// 一个索引删失败不影响其它索引：逐个删、把失败汇总返回，调用方按「部分成功」处理。
	return deleted, errors.Join(failures...)
}

// listIndices 列出本应用建的按天索引（`<前缀>-*`）。
//
// 用 `_cat/indices` 而不是 `_aliases`：只需要索引名，cat 的返回最小、权限要求也最低。
// 索引还没有一个时 ES 返回 404，那是「还没写过」的正常状态，不是错误。
func (s *ESSink) listIndices(ctx context.Context) ([]string, error) {
	res, err := s.client.Cat.Indices(
		s.client.Cat.Indices.WithContext(ctx),
		s.client.Cat.Indices.WithIndex(s.indexPattern()),
		s.client.Cat.Indices.WithFormat("json"),
		s.client.Cat.Indices.WithH("index"),
		// 被 ILM/人工关掉的索引同样要按保留策略清理，否则磁盘永远回收不了。
		s.client.Cat.Indices.WithExpandWildcards("open,closed"),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list archive indices: %w", err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.IsError() {
		return nil, fmt.Errorf("failed to list archive indices: %s", res.String())
	}

	var rows []struct {
		Index string `json:"index"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rows); err != nil {
		return nil, fmt.Errorf("failed to decode the archive index list: %w", err)
	}
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.Index != "" {
			names = append(names, row.Index)
		}
	}
	return names, nil
}

// Write 把一批文档写入 ES。同一批可能跨天（例如 flush 边界），按索引分组分别 bulk。
//
// 命名与 VictoriaLogs / OpenObserve 的写入方法保持一致（见 documentSink），
// 好让归档运行时用同一个接口驱动三种外部日志存储。
func (s *ESSink) Write(ctx context.Context, docs []ESDocument) error {
	if len(docs) == 0 {
		return nil
	}

	groups := make(map[string][]ESDocument)
	order := make([]string, 0, 1)
	for _, doc := range docs {
		index := s.IndexName(doc.At)
		if _, ok := groups[index]; !ok {
			order = append(order, index)
		}
		groups[index] = append(groups[index], doc)
	}

	for _, index := range order {
		if err := s.bulkWithRetry(ctx, index, groups[index]); err != nil {
			return err
		}
	}
	return nil
}

// esMaxAttempts 是单次 bulk 的最大尝试次数（含首次）。
const esMaxAttempts = 3

// esRetryBackoff 是重试退避的起点，每次翻倍（300ms → 600ms）。
const esRetryBackoff = 300 * time.Millisecond

// errESNotRetryable 标记「重试没有意义」的失败：请求或数据本身不合法（mapping 冲突、
// 字段类型不匹配等）。这类错误重试三遍只是白跑。
var errESNotRetryable = errors.New("elasticsearch request is not retryable")

// bulkWithRetry 对 bulk 做有限次退避重试。
//
// ES 的短暂抖动（滚动重启、分片迁移、429 限流）不该让整批审计文档直接丢掉——归档是
// 尽力而为，但「能救回来的就别丢」。数据本身有问题的失败不重试。
func (s *ESSink) bulkWithRetry(ctx context.Context, index string, docs []ESDocument) error {
	backoff := esRetryBackoff
	var lastErr error

	for attempt := 1; attempt <= esMaxAttempts; attempt++ {
		lastErr = s.bulk(ctx, index, docs)
		if lastErr == nil {
			return nil
		}
		if errors.Is(lastErr, errESNotRetryable) || ctx.Err() != nil {
			return lastErr
		}
		if attempt == esMaxAttempts {
			break
		}

		klog.Warningf("elasticsearch bulk into %s failed (attempt %d/%d), retrying in %s: %v",
			index, attempt, esMaxAttempts, backoff, lastErr)

		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return lastErr
		case <-timer.C:
		}
		backoff *= 2
	}
	return lastErr
}

// bulk 用一个 bulk 请求写入同一索引下的一批文档（NDJSON）。
func (s *ESSink) bulk(ctx context.Context, index string, docs []ESDocument) error {
	var buffer bytes.Buffer
	for _, doc := range docs {
		meta := map[string]any{"index": map[string]any{"_index": index}}
		if doc.ID != "" {
			meta["index"].(map[string]any)["_id"] = doc.ID
		}
		if err := writeNDJSON(&buffer, meta); err != nil {
			return err
		}

		// 复制一份，避免把 kind 写回调用方的 map（副作用）。
		body := make(map[string]any, len(doc.Fields)+1)
		for key, value := range doc.Fields {
			body[key] = value
		}
		body[esFieldKind] = doc.Kind
		if err := writeNDJSON(&buffer, body); err != nil {
			return err
		}
	}

	res, err := s.client.Bulk(bytes.NewReader(buffer.Bytes()), s.client.Bulk.WithContext(ctx))
	if err != nil {
		return fmt.Errorf("failed to bulk index into %s: %w", index, err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.IsError() {
		err := fmt.Errorf("elasticsearch bulk index into %s failed: %s", index, res.String())
		// 4xx 是请求或数据本身有问题（重试无意义）；5xx 与连接抖动才值得重试。
		// 两个错误都保留（两个 %w）：调用方既要能 errors.Is 到「不可重试」标记，也要能读到状态码与响应体。
		if res.StatusCode >= 400 && res.StatusCode < 500 {
			return fmt.Errorf("%w: %w", errESNotRetryable, err)
		}
		return err
	}

	var result esBulkResponse
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to decode elasticsearch bulk response: %w", err)
	}
	if result.Errors {
		// 文档级拒绝（mapping 冲突、字段类型不符）：重试同一批数据没有意义。
		return fmt.Errorf("%w: elasticsearch rejected a document in %s: %s",
			errESNotRetryable, index, result.firstError())
	}
	return nil
}

// esBulkResponse 只解析排障需要的字段：整体错误标志与第一条失败项。
type esBulkResponse struct {
	Errors bool                           `json:"errors"`
	Items  []map[string]esBulkItemOutcome `json:"items"`
}

type esBulkItemOutcome struct {
	Status int             `json:"status"`
	Error  json.RawMessage `json:"error"`
}

func (r esBulkResponse) firstError() string {
	for _, item := range r.Items {
		for _, outcome := range item {
			if len(outcome.Error) > 0 {
				return fmt.Sprintf("status=%d error=%s", outcome.Status, string(outcome.Error))
			}
		}
	}
	return "unknown error"
}

// writeNDJSON 写一行 JSON 并换行（bulk API 的 NDJSON 格式）。
func writeNDJSON(buffer *bytes.Buffer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("failed to encode bulk payload: %w", err)
	}
	buffer.Write(data)
	buffer.WriteByte('\n')
	return nil
}

// newESTransport 构造 ES 的 HTTP transport。仅在管理员显式开启时才跳过证书校验
// （内网自签证书场景），默认走系统根证书。
func newESTransport(insecureSkipVerify bool) http.RoundTripper {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		// #nosec G402 -- 自签场景由管理员显式开启，与 syslog 的 skipVerify 同等级别。
		InsecureSkipVerify: insecureSkipVerify,
		MinVersion:         tls.VersionTLS12,
	}
	return transport
}
