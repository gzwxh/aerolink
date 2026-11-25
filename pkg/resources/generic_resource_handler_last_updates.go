package resources

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/cluster"
	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
	"github.com/gzwxh/aerolink/pkg/rbac"
	"k8s.io/klog/v2"
)

// lastUpdateOperationTypes 是算作「平台改过这个对象」的写操作类型。
// 不含 delete：对象已从列表里消失，同名新对象会另起一条创建记录。
var lastUpdateOperationTypes = []string{"create", "update", "patch", "apply", "rollback"}

// ResourceLastUpdate 是一条「平台操作时间」聚合结果：该对象最近一次通过
// AeroLink 成功落地的写操作时间。
type ResourceLastUpdate struct {
	ResourceName  string    `json:"resourceName"`
	Namespace     string    `json:"namespace"`
	LastUpdatedAt time.Time `json:"lastUpdatedAt"`
}

// ListLastUpdates 返回一个命名空间（`_all` 表示全部）内本资源类型每个对象
// 「最近一次平台操作」的时间，供列表页补更新时间列。
//
// 两条边界要界面上说清楚，不能装成「对象从未被改过」：
//   - 口径只覆盖通过 AeroLink 的修改：kubectl、CI 直接改集群不会留下审计记录；
//   - 审计 sink 不落库（parquet / ES）时没有可查的数据，明确返回 501
//     （复用 rejectUnsupportedResourceHistory，与资源历史标签页同一口径）。
//
// 集群名与资源类型的过滤条件与 ListHistory 完全一致，保证列表上的时间与
// 详情页历史标签页看到同一批记录。
func (h *GenericResourceHandler[T, V]) ListLastUpdates(c *gin.Context) {
	if rejectUnsupportedResourceHistory(c) {
		return
	}
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	user := c.MustGet("user").(model.User)
	namespace := c.Param("namespace")
	allNamespaces := namespace == "" || namespace == common.AllNamespaces

	// 先按对象聚合出「最后一次成功写入」的 id，再回表取时间。
	//
	// 不在聚合结果里直接取 MAX(created_at)：那是个表达式列，驱动不知道它的类型，
	// SQLite 上会报 `unsupported Scan ... type string into type *time.Time`；回表按
	// 具名列 created_at 取，三库都能正常解析。id 单调递增，同一秒内的多次写入也能
	// 取到最后一条。
	sub := model.DB.Model(&model.ResourceHistory{}).
		Select("MAX(id) AS id").
		Where("cluster_name = ? AND resource_type = ? AND success = ? AND operation_type IN ?",
			cs.Name, h.name, true, lastUpdateOperationTypes)
	if !allNamespaces {
		sub = sub.Where("namespace = ?", namespace)
	}
	sub = sub.Group("resource_name, namespace")

	records := []model.ResourceHistory{}
	if err := model.DB.Model(&model.ResourceHistory{}).
		Select("resource_name", "namespace", "created_at").
		Where("id IN (?)", sub).
		Find(&records).Error; err != nil {
		klog.Errorf("Failed to load platform update times for %s: %v", h.name, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 跨命名空间时逐条判权限，与 list 处理器同一规则：中间件只确认用户拿得到
	// `_all` 子路由的请求权，能看到哪些命名空间由这里决定。
	visible := make([]ResourceLastUpdate, 0, len(records))
	for _, record := range records {
		if allNamespaces && !h.isClusterScoped && record.Namespace != "" &&
			!rbac.CanAccess(user, h.name, string(common.VerbGet), cs.Name, record.Namespace) {
			continue
		}
		visible = append(visible, ResourceLastUpdate{
			ResourceName:  record.ResourceName,
			Namespace:     record.Namespace,
			LastUpdatedAt: record.CreatedAt,
		})
	}

	c.JSON(http.StatusOK, gin.H{"data": visible})
}
