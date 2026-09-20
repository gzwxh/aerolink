package audit

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
)

// parsePagination 读取审计接口共用的 `page`/`size` 查询参数，
// 输入非法时写出 400 响应并返回 ok=false。
func parsePagination(c *gin.Context) (page, size int, ok bool) {
	page = 1
	size = 20

	if p := strings.TrimSpace(c.Query("page")); p != "" {
		parsed, err := strconv.Atoi(p)
		if err != nil || parsed <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid page parameter"})
			return 0, 0, false
		}
		page = parsed
	}
	if s := strings.TrimSpace(c.Query("size")); s != "" {
		parsed, err := strconv.Atoi(s)
		if err != nil || parsed <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid size parameter"})
			return 0, 0, false
		}
		size = parsed
	}
	return page, size, true
}

// parseUintQuery 解析一个可选的 uint 查询参数，
// 输入非法时写出 400 响应并返回 ok=false。
func parseUintQuery(c *gin.Context, name string) (value uint64, ok bool) {
	raw := strings.TrimSpace(c.Query(name))
	if raw == "" {
		return 0, true
	}
	parsed, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid " + name + " parameter"})
		return 0, false
	}
	return parsed, true
}

// maxOperationFilters 限制 operations 参数的取值个数，避免构造超长的 IN 条件。
const maxOperationFilters = 20

// parseOperationList 解析逗号分隔的操作类型（
// 如「文件操作」视图的 view-file,download-file,upload-file）。
func parseOperationList(raw string) []string {
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		values = append(values, trimmed)
		if len(values) >= maxOperationFilters {
			break
		}
	}
	return values
}

// parseTimeRange 解析 from / to 两个查询参数，支持 RFC3339 与 2006-01-02（日期按当地 0 点）。
// 缺省时返回零值，表示不限制该端。
func parseTimeRange(c *gin.Context) (from, to time.Time, ok bool) {
	parse := func(name string) (time.Time, bool) {
		raw := strings.TrimSpace(c.Query(name))
		if raw == "" {
			return time.Time{}, true
		}
		if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
			return parsed, true
		}
		if parsed, err := time.ParseInLocation("2006-01-02", raw, time.Local); err == nil {
			return parsed, true
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid " + name + " parameter, want RFC3339 or YYYY-MM-DD"})
		return time.Time{}, false
	}

	from, ok = parse("from")
	if !ok {
		return time.Time{}, time.Time{}, false
	}
	to, ok = parse("to")
	if !ok {
		return time.Time{}, time.Time{}, false
	}
	if !from.IsZero() && !to.IsZero() && to.Before(from) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "to must not be earlier than from"})
		return time.Time{}, time.Time{}, false
	}
	return from, to, true
}

// applyTimeRange 给查询加上时间窗口。`to` 只给到日期时包含当天，所以按次日 0 点做开区间。
func applyTimeRange(query *gorm.DB, from, to time.Time, toIsDateOnly bool) *gorm.DB {
	from, to = effectiveTimeRange(from, to, toIsDateOnly)
	if !from.IsZero() {
		query = query.Where("created_at >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("created_at < ?", to)
	}
	return query
}

// effectiveTimeRange 返回实际生效的时间窗口（半开区间 `[from, to)`）。`to` 只给到日期时
// +1 天，这样导出响应头里报的范围与查询条件一致，而不是一个零长度的窗口。
func effectiveTimeRange(from, to time.Time, toIsDateOnly bool) (time.Time, time.Time) {
	if !to.IsZero() && toIsDateOnly {
		to = to.AddDate(0, 0, 1)
	}
	return from, to
}

// toIsDateOnly 判断 `to` 查询参数是否只给了日期（未给时间）：只给日期时 `to` 应当包含当天。
func toIsDateOnly(c *gin.Context) bool {
	raw := strings.TrimSpace(c.Query("to"))
	if raw == "" {
		return false
	}
	_, err := time.Parse("2006-01-02", raw)
	return err == nil
}

// auditLogQuery 组装操作日志的查询条件（列表与导出共用，保证导出结果与页面一致）。
func auditLogQuery(c *gin.Context, from, to time.Time, toIsDateOnly bool) (*gorm.DB, bool) {
	operatorID, ok := parseUintQuery(c, "operatorId")
	if !ok {
		return nil, false
	}

	search := strings.TrimSpace(c.Query("search"))
	operation := strings.TrimSpace(c.Query("operation"))
	clusterName := strings.TrimSpace(c.Query("cluster"))
	resourceType := strings.TrimSpace(c.Query("resourceType"))
	resourceName := strings.TrimSpace(c.Query("resourceName"))
	namespace := strings.TrimSpace(c.Query("namespace"))
	operations := parseOperationList(c.Query("operations"))

	query := model.DB.Model(&model.ResourceHistory{})
	if operatorID > 0 {
		query = query.Where("operator_id = ?", operatorID)
	}
	if clusterName != "" {
		query = query.Where("cluster_name = ?", clusterName)
	}
	if resourceType != "" {
		query = query.Where("resource_type = ?", resourceType)
	}
	if resourceName != "" {
		query = query.Where("resource_name = ?", resourceName)
	}
	if namespace != "" {
		query = query.Where("namespace = ?", namespace)
	}
	if search != "" {
		like := "%" + search + "%"
		query = query.Where("resource_name LIKE ?", like)
	}
	if operation != "" {
		query = query.Where("operation_type = ?", operation)
	}
	if len(operations) > 0 {
		query = query.Where("operation_type IN ?", operations)
	}
	return applyTimeRange(query, from, to, toIsDateOnly), true
}

// loginLogQuery 组装登录日志的查询条件（列表与导出共用）。
func loginLogQuery(c *gin.Context, from, to time.Time, toIsDateOnly bool) (*gorm.DB, bool) {
	userID, ok := parseUintQuery(c, "userId")
	if !ok {
		return nil, false
	}

	search := strings.TrimSpace(c.Query("search"))
	provider := strings.TrimSpace(c.Query("provider"))
	outcome := strings.TrimSpace(c.Query("outcome"))

	query := model.DB.Model(&model.LoginRecord{})
	if userID > 0 {
		query = query.Where("user_id = ?", userID)
	}
	if provider != "" {
		query = query.Where("provider = ?", provider)
	}
	switch outcome {
	case "success":
		// 历史行是在 result 列存在之前写入的，可能为 NULL。
		query = query.Where("result IS NULL OR result = ?", model.LoginResultSuccess)
	case "failure":
		query = query.Where("result IS NOT NULL AND result <> ?", model.LoginResultSuccess)
	}
	if search != "" {
		like := "%" + search + "%"
		query = query.Where("username LIKE ? OR ip LIKE ?", like, like)
	}
	return applyTimeRange(query, from, to, toIsDateOnly), true
}

// passwordChangeLogQuery 组装改密日志的查询条件（列表与导出共用）。
func passwordChangeLogQuery(c *gin.Context, from, to time.Time, toIsDateOnly bool) (*gorm.DB, bool) {
	userID, ok := parseUintQuery(c, "userId")
	if !ok {
		return nil, false
	}

	search := strings.TrimSpace(c.Query("search"))

	query := model.DB.Model(&model.PasswordChangeLog{})
	if userID > 0 {
		query = query.Where("user_id = ?", userID)
	}
	if search != "" {
		like := "%" + search + "%"
		query = query.Where("username LIKE ? OR operator LIKE ?", like, like)
	}
	return applyTimeRange(query, from, to, toIsDateOnly), true
}

// respondAuditPage 是所有审计列表接口共用的收尾：计数 → 按时间倒序分页 → 返回
// {data, total, page, size}。操作 / 登录 / 改密三个列表只有查询条件与记录类型不同，
// 收尾动作完全一致；抽出来也保证了分页语义不会各自漂移。
func respondAuditPage[T any](c *gin.Context, page, size int, query *gorm.DB) {
	var total int64
	if err := query.Count(&total).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// make(..., 0) 而不是 var：空结果也要序列化成 []，而不是 null。
	records := make([]T, 0)
	if err := query.Order("created_at DESC").
		Offset((page - 1) * size).Limit(size).Find(&records).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data":  records,
		"total": total,
		"page":  page,
		"size":  size,
	})
}

func ListAuditLogs(c *gin.Context) {
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}
	from, to, ok := parseTimeRange(c)
	if !ok {
		return
	}
	query, ok := auditLogQuery(c, from, to, toIsDateOnly(c))
	if !ok {
		return
	}

	// 仅列表需要操作者对象；导出用 OperatorName 快照。
	query = query.Preload("Operator", func(db *gorm.DB) *gorm.DB {
		return db.Select("id", "username", "provider")
	})
	respondAuditPage[model.ResourceHistory](c, page, size, query)
}

// ListLoginLogs 返回登录审计记录：成功登录，以及——由于失败尝试
// 也会被记录（等保三级安全审计）——被拒绝的登录，
// 其失败原因记录在 `result` 字段中。
func ListLoginLogs(c *gin.Context) {
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}
	from, to, ok := parseTimeRange(c)
	if !ok {
		return
	}
	query, ok := loginLogQuery(c, from, to, toIsDateOnly(c))
	if !ok {
		return
	}
	respondAuditPage[model.LoginRecord](c, page, size, query)
}

// ListPasswordChangeLogs 返回密码变更审计记录。
func ListPasswordChangeLogs(c *gin.Context) {
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}
	from, to, ok := parseTimeRange(c)
	if !ok {
		return
	}
	query, ok := passwordChangeLogQuery(c, from, to, toIsDateOnly(c))
	if !ok {
		return
	}
	respondAuditPage[model.PasswordChangeLog](c, page, size, query)
}
