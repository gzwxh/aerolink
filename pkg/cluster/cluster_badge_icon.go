package cluster

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/imageupload"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

// 集群徽章图标相关的错误码。前端按 code 本地化（见 ui/src/lib/utils.ts 的
// translateError 与 locales 里的 clusterBadge.errors.*），error 字段只作英文兜底。
const (
	clusterIconCodeFileMissing        = "cluster_icon_file_missing"
	clusterIconCodeTooLarge           = "cluster_icon_too_large"
	clusterIconCodeInvalidType        = "cluster_icon_invalid_type"
	clusterIconCodeInvalidImage       = "cluster_icon_invalid_image"
	clusterIconCodeDimensionsTooLarge = "cluster_icon_dimensions_too_large"
)

// BadgeIconPath 是上传过图标后写进 clusters.badge_icon_url 的地址（不带 base path，
// 前端用 withSubPath 补前缀）。query 是图片字节的内容哈希：内容变了 URL 必变，
// 浏览器缓存随之失效；内容没变则复用缓存（见 model.ClusterBadgeIcon.ContentHash）。
//
// 前缀用 /api/v1 而不是头像那边的 /api：取图接口就挂在集群列表同一组路由上
// （见 routes.go 的 registerProtectedRoutes）。
func BadgeIconPath(clusterID uint, contentHash string) string {
	return fmt.Sprintf("/api/v1/clusters/%d/badge-icon?v=%s", clusterID, contentHash)
}

func respondClusterIconError(c *gin.Context, status int, code, message string, params gin.H) {
	body := gin.H{"error": message, "code": code}
	if len(params) > 0 {
		body["params"] = params
	}
	c.JSON(status, body)
}

// respondClusterIconValidationError 把 pkg/imageupload 的校验错误映射成错误码。
func respondClusterIconValidationError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, imageupload.ErrInvalidType):
		respondClusterIconError(c, http.StatusBadRequest, clusterIconCodeInvalidType, err.Error(), nil)
	case errors.Is(err, imageupload.ErrTooLargeDimensions):
		respondClusterIconError(c, http.StatusBadRequest, clusterIconCodeDimensionsTooLarge, err.Error(), gin.H{
			"dimension": imageupload.MaxDimension,
		})
	default:
		respondClusterIconError(c, http.StatusBadRequest, clusterIconCodeInvalidImage, err.Error(), nil)
	}
}

// loadClusterForIcon 解析路径上的集群 id 并取出集群，顺带把错误响应发出去。
// 图标的路由参数是 id（集群名可以改，id 不能），与 PUT/DELETE /admin/clusters/:id 一致。
func loadClusterForIcon(c *gin.Context) (*model.Cluster, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid cluster id"})
		return nil, false
	}
	cluster, err := model.GetClusterByID(uint(id))
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "cluster not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return nil, false
	}
	return cluster, true
}

// UploadClusterBadgeIcon 上传（或替换）集群的徽章图标。
//
// 路由：POST /api/v1/admin/clusters/:id/badge-icon（需 clusters 设置权限，multipart
// 字段名为 file）。
//
// 和头像一样只信内容不信声明：类型按嗅探结果判定，只允许 PNG / JPEG
// （SVG 是脚本载体，内联返回等于存储型 XSS）。
//
// 上传会顺带打开 badge_icon_enabled：图标位在界面上归「自定义图标」开关管，
// 传了图却不打开开关的话，用户看不到任何变化，只能当成功能坏了。
func UploadClusterBadgeIcon(c *gin.Context) {
	if common.IsSectionManaged("clusters") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	cluster, ok := loadClusterForIcon(c)
	if !ok {
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, imageupload.MaxBodyBytes)
	file, _, err := c.Request.FormFile("file")
	if err != nil {
		if imageupload.IsBodyTooLargeError(err) {
			respondClusterIconError(c, http.StatusRequestEntityTooLarge, clusterIconCodeTooLarge,
				fmt.Sprintf("icon must be at most %d bytes", imageupload.MaxBytes), gin.H{
					"limit": imageupload.MaxBytes,
				})
			return
		}
		respondClusterIconError(c, http.StatusBadRequest, clusterIconCodeFileMissing,
			"a file field is required", nil)
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			klog.Errorf("failed to close the uploaded cluster icon: %v", err)
		}
	}()

	// 先按上限读，再多读一个字节用来判断「是不是正好超了」：这样即使
	// MaxBytesReader 的余量比文件上限大，也能给出明确的 413。
	data, err := io.ReadAll(io.LimitReader(file, imageupload.MaxBytes+1))
	if err != nil {
		respondClusterIconError(c, http.StatusBadRequest, clusterIconCodeInvalidImage,
			"failed to read the uploaded file", nil)
		return
	}
	if len(data) == 0 {
		respondClusterIconError(c, http.StatusBadRequest, clusterIconCodeFileMissing,
			"the uploaded file is empty", nil)
		return
	}
	if int64(len(data)) > imageupload.MaxBytes {
		respondClusterIconError(c, http.StatusRequestEntityTooLarge, clusterIconCodeTooLarge,
			fmt.Sprintf("icon must be at most %d bytes", imageupload.MaxBytes), gin.H{
				"limit": imageupload.MaxBytes,
			})
		return
	}

	contentType, err := imageupload.Validate(data)
	if err != nil {
		respondClusterIconValidationError(c, err)
		return
	}

	contentHash, err := model.SaveClusterBadgeIcon(cluster.ID, contentType, data)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store the badge icon"})
		return
	}

	iconPath := BadgeIconPath(cluster.ID, contentHash)
	updates := map[string]interface{}{
		"badge_icon_url":     iconPath,
		"badge_icon_enabled": true,
	}
	if err := model.UpdateCluster(cluster, updates); err != nil {
		// 字节已经写进去了，但 clusters.badge_icon_url 没指向它：按不变式清理掉，
		// 免得留下取不到的孤儿行。
		if cleanupErr := model.DeleteClusterBadgeIcon(cluster.ID); cleanupErr != nil {
			klog.V(4).Infof("failed to clean up the badge icon of cluster %d: %v", cluster.ID, cleanupErr)
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update cluster"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":      "badge icon updated successfully",
		"badgeIconUrl": iconPath,
	})
}

// DeleteClusterBadgeIcon 删除集群的徽章图标，图标位回落为默认图标或图标文本。
//
// 路由：DELETE /api/v1/admin/clusters/:id/badge-icon（需 clusters 设置权限）。
//
// 字节行与 clusters.badge_icon_url 必须一起清掉：只删一个会留下孤儿 blob，
// 或者留下一个 404 的图片地址（界面上就是图标位一直空白）。
func DeleteClusterBadgeIcon(c *gin.Context) {
	if common.IsSectionManaged("clusters") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	cluster, ok := loadClusterForIcon(c)
	if !ok {
		return
	}

	if err := model.DeleteClusterBadgeIcon(cluster.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete the badge icon"})
		return
	}
	if cluster.BadgeIconURL != "" {
		if err := model.UpdateCluster(cluster, map[string]interface{}{"badge_icon_url": ""}); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update cluster"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"message": "badge icon deleted successfully"})
}

// GetClusterBadgeIcon 返回某个集群上传的图标字节。
//
// 路由：GET /api/v1/clusters/:id/badge-icon（需登录）。
//
// 只要求登录、不按「这个集群对当前用户可见」判定：图标不敏感（能进集群切换器
// 的账号本来就看得见集群名），按可见性判定只会让列表里的图标全部 404。
// 没有上传过时返回 404，前端回落到默认图标或图标文本。
func GetClusterBadgeIcon(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil || id == 0 {
		c.Status(http.StatusNotFound)
		return
	}

	icon, err := model.GetClusterBadgeIcon(uint(id))
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	// ETag 用内容哈希：同一个 URL 的字节永远相同，304 判定不需要再算摘要。
	etag := fmt.Sprintf(`"%s"`, icon.ContentHash)
	// URL 带 ?v=<version>，版本变化即 URL 变化，所以可以放心长缓存。
	header := c.Writer.Header()
	header.Set("Content-Type", icon.ContentType)
	header.Set("Cache-Control", "private, max-age=31536000, immutable")
	header.Set("ETag", etag)
	// 图片是管理员上传的内容：禁止浏览器按内容猜类型，也不允许它作为文档被渲染。
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Disposition", "inline")

	if match := c.GetHeader("If-None-Match"); match != "" && strings.Contains(match, etag) {
		c.Status(http.StatusNotModified)
		return
	}

	c.Data(http.StatusOK, icon.ContentType, icon.Data)
}
