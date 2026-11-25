package resources

import (
	"math"
	"net/http"
	"strconv"

	"aerolink/pkg/cluster"
	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"k8s.io/kubectl/pkg/describe"
)

func (h *GenericResourceHandler[T, V]) registerCustomRoutes(group *gin.RouterGroup) {
	// 列表页「平台操作时间」列的批量取数：一次请求覆盖一个命名空间（`_all` 表示全部）。
	group.GET("/:namespace/last-updates", h.ListLastUpdates)
}

// resourceHistoryUnsupportedCode 是「资源级变更历史在当前审计落地方式下不可用」的机器可读标识
// （sink≠database）：界面据它给出说明，而不是把空列表当成「这个资源从没被改过」。
const resourceHistoryUnsupportedCode = "resource_history_requires_database_sink"

// rejectUnsupportedResourceHistory 在审计记录不落库时拒绝资源级变更历史，并说明原因。
//
// 它不是配置错误，而是这个能力在 sink≠database 时**不存在**：
//   - sink=parquet：YAML 默认不写进 parquet（内容可能很大，见 includeResourceYAML）；
//   - sink=elasticsearch：ES 文档按设计不含 YAML。
//
// 两者都撑不起「变更前后对比 → 回滚」这件事，所以明确返回 501 + code，让界面能说清原因。
func rejectUnsupportedResourceHistory(c *gin.Context) bool {
	if model.AuditSinkUsesDatabase() {
		return false
	}
	c.JSON(http.StatusNotImplemented, gin.H{
		"error": "resource change history requires auditSink=database: the yaml diff needs the audit records in the database",
		"code":  resourceHistoryUnsupportedCode,
	})
	return true
}

func (h *GenericResourceHandler[T, V]) ListHistory(c *gin.Context) {
	if rejectUnsupportedResourceHistory(c) {
		return
	}
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	namespace := c.Param("namespace")
	resourceName := c.Param("name")
	pageSize, err := strconv.Atoi(c.DefaultQuery("pageSize", "10"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pageSize parameter"})
		return
	}
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid page parameter"})
		return
	}

	var total int64
	if err := model.DB.Model(&model.ResourceHistory{}).Where("cluster_name = ? AND resource_type = ? AND resource_name = ? AND namespace = ?", cs.Name, h.name, resourceName, namespace).Count(&total).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	history := []model.ResourceHistory{}
	if err := model.DB.Preload("Operator", func(db *gorm.DB) *gorm.DB {
		return db.Select("id", "username", "provider")
	}).Where("cluster_name = ? AND resource_type = ? AND resource_name = ? AND namespace = ?", cs.Name, h.name, resourceName, namespace).Order("created_at DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&history).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	totalPages := int(math.Ceil(float64(total) / float64(pageSize)))
	hasNextPage := page < totalPages
	hasPrevPage := page > 1

	response := gin.H{
		"data": history,
		"pagination": gin.H{
			"page":        page,
			"pageSize":    pageSize,
			"total":       total,
			"totalPages":  totalPages,
			"hasNextPage": hasNextPage,
			"hasPrevPage": hasPrevPage,
		},
	}

	c.JSON(http.StatusOK, response)
}

func (h *GenericResourceHandler[T, V]) Describe(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	gk := h.getGroupKind()
	describer, ok := describe.DescriberFor(gk, cs.K8sClient.Configuration)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no describer found for this resource"})
		return
	}
	namespace := c.Param("namespace")
	name := c.Param("name")
	out, err := describer.Describe(namespace, name, describe.DescriberSettings{
		ShowEvents: true,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"result": out})
}
