package audit

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

// —— 归档结果 → 列表接口的字段适配 ——
//
// 列表接口（/admin/audit-logs 等）返回的是模型的 camelCase JSON，而归档检索（parquet / ES）
// 回来的行是方案 §5 schema 的 snake_case 字段。前端不该因为后端换了存储就改渲染逻辑——把
// 字段名在这一层对齐，是「切 sink 对界面透明」的前提。

// archiveFieldAliases 是 §5 schema 字段名 → 模型 JSON 字段名的映射。
//
// 只列两者**不一致**的字段：一致的（namespace / success / username / provider / result /
// ip / operator / source…）不需要映射。映射表越小越不容易漂移。
var archiveFieldAliases = map[string]string{
	"created_at":       "createdAt",
	"cluster_name":     "clusterName",
	"resource_type":    "resourceType",
	"resource_name":    "resourceName",
	"operation_type":   "operationType",
	"operation_source": "operationSource",
	"resource_yaml":    "resourceYaml",
	"previous_yaml":    "previousYaml",
	"error_message":    "errorMessage",
	"client_ip":        "clientIp",
	"user_agent":       "userAgent",
	"operator_id":      "operatorId",
	"operator_name":    "operatorName",
	"user_id":          "userId",
}

// adaptArchiveHits 把归档检索的命中行转换成模型结构（字段名按 archiveFieldAliases 对齐）。
//
// 走一次 JSON 往返而不是手写逐字段赋值：字段有十几个、且未来加列时两边容易漏改；
// 交给结构体自己的 json tag 去认领，漏掉的字段会**静默为空**而不是编译报错——所以
// 新增列时记得同时更新上面的映射表（有单测盯着这张表）。
func adaptArchiveHits[T any](hits []json.RawMessage) ([]T, error) {
	records := make([]T, 0, len(hits))
	for _, hit := range hits {
		var row map[string]any
		if err := json.Unmarshal(hit, &row); err != nil {
			return nil, err
		}

		adapted := make(map[string]any, len(row))
		for key, value := range row {
			name := key
			if alias, ok := archiveFieldAliases[key]; ok {
				name = alias
			}
			adapted[name] = value
		}

		data, err := json.Marshal(adapted)
		if err != nil {
			return nil, err
		}
		var record T
		if err := json.Unmarshal(data, &record); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, nil
}

// archiveListView 描述一次「用归档后端回答列表请求」的查询。
type archiveListView struct {
	// kind 是 ES/接口层的分类（ESKindAuditHistory 等），决定查哪类归档。
	kind string
	// timeField 是时间列（created_at / ts），列表按它倒序。
	timeField string
	// filters 是与数据库查询等价的筛选条件（由各列表接口翻译而来）。
	filters      []archiveCondition
	from, to     time.Time
	toIsDateOnly bool
	page, size   int
}

// respondArchiveList 用归档后端回答列表请求，响应结构与数据库列表接口**保持一致**。
//
// 这样前端拿到的 data/total/page/size 语义完全相同，只多出两个说明性字段
// （backend / queryDelaySeconds），界面据此提示"数据来源"与"可能的延迟"。
func respondArchiveList[T any](c *gin.Context, view archiveListView) {
	searcher, backend, err := currentArchiveSearcher(backendAuto)
	if err != nil {
		// 与"没有可用检索后端"的既有语义一致：给出明确原因，而不是返回一个空列表让人
		// 以为"确实没有记录"。
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// `to` 只给到日期时要包含当天——与数据库列表接口同一语义（半开区间取次日 0 点）。
	from, to := effectiveTimeRange(view.from, view.to, view.toIsDateOnly)

	result, err := searcher.Search(c.Request.Context(), archiveQuery{
		kind:      view.kind,
		timeField: view.timeField,
		filters:   view.filters,
	}, from, to, view.page, view.size)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	records, err := adaptArchiveHits[T](result.Hits)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to adapt archive records: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data":  records,
		"total": result.Total,
		"page":  view.page,
		"size":  view.size,
		// backend：这份数据来自哪个后端（界面显示"数据来源"）。
		// queryDelaySeconds：刚发生的操作最晚多久之后才可能被查到。parquet 是攒批落盘的，
		// 这个值就是它的攒批间隔；界面必须明示，否则用户会以为"操作丢了"。
		"backend":           string(backend),
		"queryDelaySeconds": archiveQueryDelaySeconds(),
	})
}

// archiveQueryDelaySeconds 返回当前配置下「刚发生的审计事件最晚多久可查」。
//
// 取的是**审计日志**的攒批间隔（列表接口查的是操作/登录/改密，不是访问日志）。
// 配置读不到时返回 0：界面会退化成不显示延迟提示，而不是显示一个编造的数字。
func archiveQueryDelaySeconds() int {
	setting, err := model.GetAuditSetting()
	if err != nil {
		return 0
	}
	interval := setting.Archive.Flush.IntervalSeconds
	if interval <= 0 {
		interval = model.DefaultArchiveFlushInterval
	}
	return interval
}
