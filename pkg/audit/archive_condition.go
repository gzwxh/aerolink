package audit

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// 过滤条件的操作类型。
type conditionOp string

const (
	// opEq 精确匹配（ES term / SQL 等值）。
	opEq conditionOp = "eq"
	// opNotEq 排除某个值（ES must_not term / SQL <>）。用于「登录失败 = result 不是 success」。
	opNotEq conditionOp = "not_eq"
	// opContains 关键字包含（ES multi_match / SQL 多列 ILIKE）。
	opContains conditionOp = "contains"
	// opIn 命中一组取值之一（ES terms / SQL IN）。
	//
	// 用于「文件操作」这类一次筛多个操作类型的视图（view-file,download-file,upload-file）。
	// value 的形态是 []any：单个条件里带多个取值，而不是把同一字段重复成多个 eq 条件——
	// 后者在 SQL 里会渲染成 `a = 'x' AND a = 'y'`，永远匹配不到任何行。
	opIn conditionOp = "in"
)

// archiveCondition 是与检索后端无关的过滤条件。
//
// 以前过滤条件直接就是 ES 的 DSL（`map[string]any`），绑死在 ES 上；现在同一套条件要能同时
// 交给 ES 与 DuckDB(SQL)，必须先中立，再由各自的翻译器渲染（见 toESFilters / toSQLWhere）。
//
// 这样也把「双后端语义漂移」收敛到一处：条件只有一份，两个翻译器各自单测。
type archiveCondition struct {
	// field 是 §5 schema 里的字段名（如 client_ip）。SQL 侧还要过列名白名单。
	field string
	op    conditionOp
	// value 取值 string / int / bool：由类型决定如何渲染，绝不把用户字符串直接当语法。
	value any
	// searchFields 仅用于 opContains：关键字在哪些列里找。
	searchFields []string
}

// eqCondition 构造一个精确匹配条件；value 为空时返回 false（表示「不限制」）。
func eqCondition(field, value string) (archiveCondition, bool) {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return archiveCondition{field: field, op: opEq, value: trimmed}, true
	}
	return archiveCondition{}, false
}

// addEqCondition 把非空的精确匹配条件追加到列表里（空值表示「不限制」）。
func addEqCondition(conditions *[]archiveCondition, field, value string) {
	if condition, ok := eqCondition(field, value); ok {
		*conditions = append(*conditions, condition)
	}
}

// notEqCondition 构造「排除某个值」的条件（值必须是已知常量，不来自自由输入）。
func notEqCondition(field, value string) archiveCondition {
	return archiveCondition{field: field, op: opNotEq, value: value}
}

// statusCodeCondition 构造状态码的精确匹配条件（数字按数字渲染，不做字符串比较）。
func statusCodeCondition(raw string) (archiveCondition, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return archiveCondition{}, nil
	}
	code, err := strconv.Atoi(trimmed)
	if err != nil {
		return archiveCondition{}, fmt.Errorf("invalid statusCode parameter")
	}
	return archiveCondition{field: esFieldStatusCode, op: opEq, value: code}, nil
}

// containsCondition 构造关键字条件。searchFields 为空时由后端给默认列集。
func containsCondition(value string, searchFields ...string) (archiveCondition, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return archiveCondition{}, false
	}
	return archiveCondition{op: opContains, value: trimmed, searchFields: searchFields}, true
}

// toESFilters 把中立条件渲染成 ES DSL 的 filter 子句。
//
// 字符串字段用 `.keyword` 子字段做精确匹配：索引 mapping 由 ES 动态生成，字符串会映射成
// text（带 .keyword），对 text 做 term 查询会先分词再匹配，`PUT` 这类大写值匹配不上。
func toESFilters(conditions []archiveCondition) []map[string]any {
	filters := make([]map[string]any, 0, len(conditions))
	for _, condition := range conditions {
		switch condition.op {
		case opEq:
			if condition.field == esFieldStatusCode {
				filters = append(filters, map[string]any{"term": map[string]any{condition.field: condition.value}})
				continue
			}
			filters = append(filters, map[string]any{"term": map[string]any{keywordField(condition.field): condition.value}})
		case opNotEq:
			filters = append(filters, map[string]any{
				"bool": map[string]any{
					"must_not": []map[string]any{
						{"term": map[string]any{keywordField(condition.field): condition.value}},
					},
				},
			})
		case opContains:
			filters = append(filters, map[string]any{
				"multi_match": map[string]any{
					"query":  condition.value,
					"fields": condition.searchFields,
				},
			})
		case opIn:
			values, ok := condition.value.([]any)
			if !ok || len(values) == 0 {
				continue
			}
			filters = append(filters, map[string]any{
				"terms": map[string]any{keywordField(condition.field): values},
			})
		}
	}
	return filters
}

// allowedSQLColumns 是允许出现在生成 SQL 里的列名白名单（与 §5 parquet schema 一一对应）。
//
// DuckDB CLI 方式没有占位符，字段名一旦来自外部就是注入面。这里做纵深防御：即使将来有人把
// 用户输入接到 field 上，也只会被拒绝，而不是被拼进 SQL。
var allowedSQLColumns = map[string]bool{
	"id": true, "created_at": true, "ts": true,
	"cluster_name": true, "resource_type": true, "resource_name": true, "namespace": true,
	"operation_type": true, "operation_source": true, "success": true, "error_message": true,
	"client_ip": true, "user_agent": true, "operator_id": true, "operator_name": true,
	"user_id": true, "username": true, "provider": true, "result": true,
	"operator": true, "source": true,
	"method": true, "path": true, "status_code": true, "latency_ms": true,
	"cluster": true, "user": true,
}

// sqlLiteral 把字符串渲染成 SQL 安全字面量：单引号翻倍，并拒绝 NUL 字节。
func sqlLiteral(value string) (string, error) {
	if strings.ContainsRune(value, 0) {
		return "", errors.New("value contains a NUL byte")
	}
	return "'" + strings.ReplaceAll(value, "'", "''") + "'", nil
}

// sqlValue 按 Go 类型渲染字面量：字符串走转义，数字/布尔按字面量拼（绝不接受字符串直出）。
func sqlValue(value any) (string, error) {
	switch typed := value.(type) {
	case string:
		return sqlLiteral(typed)
	case int:
		return strconv.Itoa(typed), nil
	case int64:
		return strconv.FormatInt(typed, 10), nil
	case bool:
		return strconv.FormatBool(typed), nil
	case time.Time:
		return strconv.FormatInt(typed.UnixMilli(), 10), nil
	default:
		return "", fmt.Errorf("unsupported condition value type %T", value)
	}
}

// sqlIdentifier 校验并返回列名（必须命中白名单）。
func sqlIdentifier(field string) (string, error) {
	if !allowedSQLColumns[field] {
		return "", fmt.Errorf("column %q is not allowed in archive queries", field)
	}
	return field, nil
}

// toSQLWhere 把中立条件渲染成 SQL 的 WHERE 片段（含时间范围，不含 ORDER BY / LIMIT）。
//
// timeField 是时间列（created_at / ts），在 parquet 里是毫秒 BIGINT，因此直接与毫秒整数比较。
func toSQLWhere(conditions []archiveCondition, timeField string, from, to time.Time) (string, error) {
	timeColumn, err := sqlIdentifier(timeField)
	if err != nil {
		return "", err
	}

	clauses := make([]string, 0, len(conditions)+2)
	if !from.IsZero() {
		clauses = append(clauses, timeColumn+" >= "+strconv.FormatInt(from.UnixMilli(), 10))
	}
	if !to.IsZero() {
		clauses = append(clauses, timeColumn+" < "+strconv.FormatInt(to.UnixMilli(), 10))
	}

	for _, condition := range conditions {
		switch condition.op {
		case opEq, opNotEq:
			column, err := sqlIdentifier(condition.field)
			if err != nil {
				return "", err
			}
			literal, err := sqlValue(condition.value)
			if err != nil {
				return "", err
			}
			operator := " = "
			if condition.op == opNotEq {
				operator = " <> "
			}
			clauses = append(clauses, column+operator+literal)
		case opContains:
			literal, err := sqlLiteral(fmt.Sprint(condition.value))
			if err != nil {
				return "", err
			}
			// ILIKE 做大小写不敏感包含；多列之间是 OR。
			matches := make([]string, 0, len(condition.searchFields))
			for _, field := range condition.searchFields {
				column, err := sqlIdentifier(field)
				if err != nil {
					return "", err
				}
				matches = append(matches, column+" ILIKE '%' || "+literal+" || '%'")
			}
			if len(matches) == 0 {
				continue
			}
			clauses = append(clauses, "("+strings.Join(matches, " OR ")+")")
		case opIn:
			column, err := sqlIdentifier(condition.field)
			if err != nil {
				return "", err
			}
			values, ok := condition.value.([]any)
			if !ok || len(values) == 0 {
				continue
			}
			literals := make([]string, 0, len(values))
			for _, value := range values {
				literal, err := sqlValue(value)
				if err != nil {
					return "", err
				}
				literals = append(literals, literal)
			}
			clauses = append(clauses, column+" IN ("+strings.Join(literals, ", ")+")")
		}
	}

	if len(clauses) == 0 {
		return "TRUE", nil
	}
	return strings.Join(clauses, " AND "), nil
}
