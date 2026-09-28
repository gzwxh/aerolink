package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/auth"
	"github.com/zxh326/kite/pkg/model"
)

// HandleGetLockedLoginIPs 列出当前因登录失败尝试
// 而被锁定的客户端 IP。
func HandleGetLockedLoginIPs(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"items": auth.BlockedLoginIPs()})
}

// HandleBlockLoginIP 代表管理员锁定某个客户端 IP，使用
// 已配置的 IP 锁定窗口。该封锁优先于允许列表，
// 最迟持续到进程重启；需要永久封锁请使用拒绝列表。
func HandleBlockLoginIP(c *gin.Context) {
	var req struct {
		IP string `json:"ip" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ip := strings.TrimSpace(req.IP)
	// 统一成标准写法，避免同一地址以多种文本形式重复锁定。
	if parsed := net.ParseIP(ip); parsed != nil {
		ip = parsed.String()
	} else {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid IP address"})
		return
	}

	minutes := 30
	if setting, err := model.GetSecuritySetting(); err == nil && setting.IPLoginBlockMinutes > 0 {
		minutes = setting.IPLoginBlockMinutes
	}
	until := time.Now().Add(time.Duration(minutes) * time.Minute)
	auth.BlockLoginIP(ip, until)
	c.JSON(http.StatusOK, gin.H{"success": true, "ip": ip, "blockedUntil": until})
}

// HandleUnlockLoginIP 清除某个客户端 IP 的锁定。
func HandleUnlockLoginIP(c *gin.Context) {
	ip, err := url.PathUnescape(c.Param("ip"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid IP address"})
		return
	}
	ip = strings.TrimSpace(ip)
	parsed := net.ParseIP(ip)
	if parsed == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid IP address"})
		return
	}
	auth.UnblockLoginIP(parsed.String())
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// HandleGetLockedLoginUsers 列出当前因登录失败尝试
// 而被锁定的用户。
func HandleGetLockedLoginUsers(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"items": auth.BlockedLoginUsers()})
}

// HandleBlockLoginUser 代表管理员锁定某个用户，使用已配置的
// 用户锁定窗口。匹配大小写不敏感，最迟持续到进程重启。
func HandleBlockLoginUser(c *gin.Context) {
	var req struct {
		Username string `json:"username" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid username"})
		return
	}

	minutes := 30
	if setting, err := model.GetSecuritySetting(); err == nil && setting.UserLoginBlockMinutes > 0 {
		minutes = setting.UserLoginBlockMinutes
	}
	until := time.Now().Add(time.Duration(minutes) * time.Minute)
	auth.BlockLoginUser(username, until)
	c.JSON(http.StatusOK, gin.H{"success": true, "username": username, "blockedUntil": until})
}

// HandleUnlockLoginUser 清除某个用户的锁定。
func HandleUnlockLoginUser(c *gin.Context) {
	username, err := url.PathUnescape(c.Param("username"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid username"})
		return
	}
	username = strings.TrimSpace(username)
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid username"})
		return
	}
	auth.UnblockLoginUser(username)
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func HandleGetSecuritySetting(c *gin.Context) {
	setting, err := model.GetSecuritySetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load security setting: %v", err)})
		return
	}
	c.JSON(http.StatusOK, setting)
}

// HandleUpdateSecuritySetting 把请求体合并进已存储的策略，
// 因此调用方既可以发送完整策略，也可以只发送改动的字段。
func HandleUpdateSecuritySetting(c *gin.Context) {
	// 这份数据会被请求体整体覆盖后整份写回，必须读最新的（不能用 10 秒缓存，
	// 否则会把别的管理员在这 10 秒内的改动覆盖掉）。
	setting, err := model.LoadSecuritySetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load security setting: %v", err)})
		return
	}

	if err := json.NewDecoder(c.Request.Body).Decode(setting); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid request: %v", err)})
		return
	}

	updated, err := model.UpdateSecuritySetting(*setting)
	if err != nil {
		if errors.Is(err, model.ErrLoginSourceAllowlistRequired) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": err.Error(),
				"code":  "login_source_allowlist_required",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to update security setting: %v", err)})
		return
	}
	// 会话限制有数秒缓存；清掉缓存，
	// 使新策略对下一个请求生效。
	auth.ResetSessionPolicyCache()
	c.JSON(http.StatusOK, updated)
}
