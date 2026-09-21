package users

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/imageupload"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// 头像的三个硬限制与服务端其它图片上传共用一套规则，实现在 pkg/imageupload
// （见 docs/dev/plans/2026-09-20-avatar-upload.md）。
const (
	maxAvatarBytes      = imageupload.MaxBytes
	maxAvatarUploadBody = imageupload.MaxBodyBytes
	maxAvatarDimension  = imageupload.MaxDimension
)

// 头像相关的错误码。前端按 code 本地化（见 ui/src/lib/utils.ts 的 translateError
// 与 locales 里的 avatarUpload.errors.*），error 字段只作英文兜底。
const (
	avatarCodeFileMissing        = "avatar_file_missing"
	avatarCodeTooLarge           = "avatar_too_large"
	avatarCodeInvalidType        = "avatar_invalid_type"
	avatarCodeInvalidImage       = "avatar_invalid_image"
	avatarCodeDimensionsTooLarge = "avatar_dimensions_too_large"
)

// AvatarPath 是上传过头像后写进 users.avatar_url 的地址（不带 base path，
// 前端用 withSubPath 补前缀）。query 是图片字节的内容哈希：内容变了 URL 必变，
// 浏览器缓存随之失效；内容没变则复用缓存（见 model.UserAvatar.ContentHash）。
func AvatarPath(userID uint64, contentHash string) string {
	return fmt.Sprintf("/api/users/%d/avatar?v=%s", userID, contentHash)
}

// isUploadedAvatarPath 判断 avatar_url 是否指向某个用户上传的头像。
// 用来维护「有字节行 ⇔ avatar_url 指向它」这条不变式：把 avatar_url 改成别的值
// 时必须删掉字节行，否则会留下永远取不到的孤儿 blob。
//
// 只认本站的相对路径：外链（哪怕路径碰巧写成 /api/users/1/avatar）不算，
// 否则别的站点上的同名路径会被当成「还在用上传的头像」。
func isUploadedAvatarPath(userID uint64, avatarURL string) bool {
	if userID == 0 || avatarURL == "" {
		return false
	}
	parsed, err := url.Parse(avatarURL)
	if err != nil {
		return false
	}
	if parsed.Scheme != "" || parsed.Host != "" {
		return false
	}
	return parsed.Path == fmt.Sprintf("/api/users/%d/avatar", userID)
}

func respondAvatarError(c *gin.Context, status int, code, message string, params gin.H) {
	body := gin.H{"error": message, "code": code}
	if len(params) > 0 {
		body["params"] = params
	}
	c.JSON(status, body)
}

// 校验结果直接沿用 pkg/imageupload 的哨兵错误，这里只改个名，让本包的调用点
// 读起来仍是「头像」的语义；错误码映射见 respondAvatarValidationError。
var (
	errAvatarInvalidType        = imageupload.ErrInvalidType
	errAvatarTooLargeDimensions = imageupload.ErrTooLargeDimensions
)

// respondAvatarValidationError 把校验错误映射成错误码返回。
func respondAvatarValidationError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, errAvatarInvalidType):
		respondAvatarError(c, http.StatusBadRequest, avatarCodeInvalidType, err.Error(), nil)
	case errors.Is(err, errAvatarTooLargeDimensions):
		respondAvatarError(c, http.StatusBadRequest, avatarCodeDimensionsTooLarge, err.Error(), gin.H{
			"dimension": maxAvatarDimension,
		})
	default:
		respondAvatarError(c, http.StatusBadRequest, avatarCodeInvalidImage, err.Error(), nil)
	}
}

// UploadCurrentUserAvatar 上传（或替换）当前登录用户自己的头像。
//
// 路由：POST /api/users/me/avatar（需登录，multipart 字段名为 file）。
//
// 目录同步账号（LDAP / OIDC）同样可以上传：头像在 jit 更新里被显式保留
// （见 model.User 的 directoryAvatarURL），不存在与身份源冲突的问题。
//
// 成功时返回更新后的用户对象，其中的 avatar_url 已指向新头像，
// 调用方无需再猜地址。
func UploadCurrentUserAvatar(c *gin.Context) {
	user := c.MustGet("user").(model.User)

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAvatarUploadBody)
	file, _, err := c.Request.FormFile("file")
	if err != nil {
		if imageupload.IsBodyTooLargeError(err) {
			respondAvatarError(c, http.StatusRequestEntityTooLarge, avatarCodeTooLarge,
				fmt.Sprintf("avatar must be at most %d bytes", maxAvatarBytes), gin.H{
					"limit": maxAvatarBytes,
				})
			return
		}
		respondAvatarError(c, http.StatusBadRequest, avatarCodeFileMissing,
			"a file field is required", nil)
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			klog.Errorf("failed to close the uploaded avatar: %v", err)
		}
	}()

	// 先按上限读，再多读一个字节用来判断「是不是正好超了」：这样即使
	// MaxBytesReader 的余量比文件上限大，也能给出明确的 413。
	data, err := io.ReadAll(io.LimitReader(file, maxAvatarBytes+1))
	if err != nil {
		respondAvatarError(c, http.StatusBadRequest, avatarCodeInvalidImage,
			"failed to read the uploaded file", nil)
		return
	}
	if len(data) == 0 {
		respondAvatarError(c, http.StatusBadRequest, avatarCodeFileMissing,
			"the uploaded file is empty", nil)
		return
	}
	if int64(len(data)) > maxAvatarBytes {
		respondAvatarError(c, http.StatusRequestEntityTooLarge, avatarCodeTooLarge,
			fmt.Sprintf("avatar must be at most %d bytes", maxAvatarBytes), gin.H{
				"limit": maxAvatarBytes,
			})
		return
	}

	contentType, err := imageupload.Validate(data)
	if err != nil {
		respondAvatarValidationError(c, err)
		return
	}

	contentHash, err := model.SaveUserAvatar(uint64(user.ID), contentType, data)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store the avatar"})
		return
	}

	user.AvatarURL = AvatarPath(uint64(user.ID), contentHash)
	if err := model.UpdateUser(&user); err != nil {
		// 字节已经写进去了，但 users.avatar_url 没指向它：按不变式清理掉，
		// 免得留下取不到的孤儿行。
		if cleanupErr := model.DeleteUserAvatar(uint64(user.ID)); cleanupErr != nil {
			klog.V(4).Infof("failed to clean up the avatar of user %d: %v", user.ID, cleanupErr)
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
		return
	}

	c.JSON(http.StatusOK, user)
}

// DeleteCurrentUserAvatar 清除当前用户头像，恢复为首字母占位。
//
// 路由：DELETE /api/users/me/avatar（需登录）。
//
// 同时清掉 users.avatar_url：它可能存着外链地址，留着会出现
// 「字节行删了、界面还显示旧外链」的错位。
func DeleteCurrentUserAvatar(c *gin.Context) {
	user := c.MustGet("user").(model.User)

	if err := model.DeleteUserAvatar(uint64(user.ID)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete the avatar"})
		return
	}
	if user.AvatarURL != "" {
		cleared := user
		cleared.AvatarURL = ""
		if err := model.UpdateUser(&cleared); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
			return
		}
		user.AvatarURL = ""
	}

	c.JSON(http.StatusOK, user)
}

// GetUserAvatar 返回某个用户上传的头像字节。
//
// 路由：GET /api/users/:id/avatar（需登录）。
//
// 只要求登录、不按「只能读自己」判定：头像不敏感（用户列表里所有管理员本来就
// 能看到），按用户判定只会让列表里的头像全部 404。没有上传过时返回 404，
// 前端回落到首字母占位。
func GetUserAvatar(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		c.Status(http.StatusNotFound)
		return
	}

	avatar, err := model.GetUserAvatar(id)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	// ETag 用内容哈希：同一个 URL 的字节永远相同，304 判定不需要再算摘要。
	etag := fmt.Sprintf(`"%s"`, avatar.ContentHash)
	// URL 带 ?v=<version>，版本变化即 URL 变化，所以可以放心长缓存。
	header := c.Writer.Header()
	header.Set("Content-Type", avatar.ContentType)
	header.Set("Cache-Control", "private, max-age=31536000, immutable")
	header.Set("ETag", etag)
	// 图片是用户上传的内容：禁止浏览器按内容猜类型，也不允许它作为文档被渲染。
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Disposition", "inline")

	if match := c.GetHeader("If-None-Match"); match != "" && strings.Contains(match, etag) {
		c.Status(http.StatusNotModified)
		return
	}

	c.Data(http.StatusOK, avatar.ContentType, avatar.Data)
}
