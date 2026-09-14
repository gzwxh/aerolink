package audit

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
)

// parsePagination reads the shared `page`/`size` query parameters used by the
// audit endpoints, writing a 400 response and returning ok=false on bad input.
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

// parseUintQuery parses an optional unsigned integer query parameter, writing a
// 400 response and returning ok=false on bad input.
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

func ListAuditLogs(c *gin.Context) {
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}

	operatorID, ok := parseUintQuery(c, "operatorId")
	if !ok {
		return
	}

	search := strings.TrimSpace(c.Query("search"))
	operation := strings.TrimSpace(c.Query("operation"))
	clusterName := strings.TrimSpace(c.Query("cluster"))
	resourceType := strings.TrimSpace(c.Query("resourceType"))
	resourceName := strings.TrimSpace(c.Query("resourceName"))
	namespace := strings.TrimSpace(c.Query("namespace"))

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

	var total int64
	if err := query.Count(&total).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	history := []model.ResourceHistory{}
	if err := query.Preload("Operator", func(db *gorm.DB) *gorm.DB {
		return db.Select("id", "username", "provider")
	}).Order("created_at DESC").Offset((page - 1) * size).Limit(size).Find(&history).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data":  history,
		"total": total,
		"page":  page,
		"size":  size,
	})
}

// ListLoginLogs returns successful sign-ins recorded in login_records.
func ListLoginLogs(c *gin.Context) {
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}

	userID, ok := parseUintQuery(c, "userId")
	if !ok {
		return
	}

	search := strings.TrimSpace(c.Query("search"))
	provider := strings.TrimSpace(c.Query("provider"))

	query := model.DB.Model(&model.LoginRecord{})
	if userID > 0 {
		query = query.Where("user_id = ?", userID)
	}
	if provider != "" {
		query = query.Where("provider = ?", provider)
	}
	if search != "" {
		like := "%" + search + "%"
		query = query.Where("username LIKE ? OR ip LIKE ?", like, like)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	records := []model.LoginRecord{}
	if err := query.Order("created_at DESC").Offset((page - 1) * size).Limit(size).Find(&records).Error; err != nil {
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

// ListPasswordChangeLogs returns the password change audit trail.
func ListPasswordChangeLogs(c *gin.Context) {
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}

	userID, ok := parseUintQuery(c, "userId")
	if !ok {
		return
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

	var total int64
	if err := query.Count(&total).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	records := []model.PasswordChangeLog{}
	if err := query.Order("created_at DESC").Offset((page - 1) * size).Limit(size).Find(&records).Error; err != nil {
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
