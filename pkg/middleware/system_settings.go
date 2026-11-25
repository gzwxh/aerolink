package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
	"github.com/gzwxh/aerolink/pkg/rbac"
)

// RequireSettingsSection 保护属于某个设置分区的控制台设置接口
// （common.SettingsSection*，映射为 "settings.<section>"）。
// 它是 RequireAdmin 的补充：账号仍需能进入管理 API 区域，
// 但运维可以只授予某一个分区而不授予其它分区。
//
// section 为空表示父级 settings（全部章节），语义与改造前的 RequireSystemSettings 一致。
//
// 读与写分开：GET/HEAD 只要拥有读取权限（settings.<section> + get，或 + update），
// 其它方法必须拥有管理权限（settings.<section> + update）。
func RequireSettingsSection(section string) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := c.Get("user")
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated"})
			c.Abort()
			return
		}
		currentUser := user.(model.User)
		allowed := false
		if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead {
			allowed = rbac.CanViewSettingsSection(currentUser, section)
		} else {
			allowed = rbac.CanManageSettingsSection(currentUser, section, string(common.SystemSettingsVerb))
		}
		if !allowed {
			c.JSON(http.StatusForbidden, gin.H{"error": "System settings permission required"})
			c.Abort()
			return
		}
		c.Next()
	}
}
