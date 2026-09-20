package auth

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// SessionHeartbeat 是前端会话心跳：成功一律返回 204。它挂在 RequireAuth 后面，
// 所以当单点登录用新会话顶替旧会话时，这里会先返回 401 + code=session_superseded
// 并清掉 cookie——前端每 10 秒打一次这个接口，就能「马上」在其它已登录页面上
// 弹出「账号在其他设备登录」的提示，而不是等用户下一次操作。
func (h *AuthHandler) SessionHeartbeat(c *gin.Context) {
	c.Status(http.StatusNoContent)
}
