package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
)

// RequireClusterAccess guards routes that have no single Kubernetes resource to
// map onto (image tag lookup, templates, chart catalogue) but still expose
// cluster level information. Without it they would sit in front of
// RBACMiddleware — Gin freezes a route's handler chain at registration time, so
// a later Group.Use never applies to them — and any signed-in account, even one
// with no permissions at all, could read them.
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
