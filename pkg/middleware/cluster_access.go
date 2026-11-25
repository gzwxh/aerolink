package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/cluster"
	"github.com/gzwxh/aerolink/pkg/model"
	"github.com/gzwxh/aerolink/pkg/rbac"
)

// RequireClusterAccess 保护那些没有单一 Kubernetes 资源可映射
// （镜像 tag 查询、模板、chart 目录）但仍会暴露
// 集群级信息的路由。没有它，这些路由会位于
// RBACMiddleware 之前——Gin 在注册时就固定了路由的处理器链，
// 之后再用 Group.Use 对它们无效——于是任何已登录账号，
// 即便完全没有权限，也能读取它们。
func RequireClusterAccess() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := c.Get("user")
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			c.Abort()
			return
		}
		cs, ok := c.Get("cluster")
		if !ok {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "cluster not found"})
			c.Abort()
			return
		}
		if !rbac.CanAccessCluster(user.(model.User), cs.(*cluster.ClientSet).Name) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
			c.Abort()
			return
		}
		c.Next()
	}
}
