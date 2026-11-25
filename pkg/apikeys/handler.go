package apikeys

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
	"github.com/gzwxh/aerolink/pkg/rbac"
)

type CreateAPIKeyRequest struct {
	Name string `json:"name" binding:"required"`
}

// APIKeyView 是密钥列表的响应项。
//
// 完整密钥只在创建响应里出现一次（见 CreatedAPIKey）：列表只回显非敏感的
// 前缀 `aerolink<id>-`，够把界面上的条目与配置文件里的 key 对上，但拿不到凭据。
// 这样 `/admin/apikeys` 的响应即使被代理日志或抓包留存，也不构成可用密钥。
type APIKeyView struct {
	ID           uint          `json:"id"`
	Username     string        `json:"username"`
	APIKeyPrefix string        `json:"apiKeyPrefix"`
	LastLoginAt  *time.Time    `json:"lastLoginAt,omitempty"`
	CreatedAt    time.Time     `json:"createdAt"`
	UpdatedAt    time.Time     `json:"updatedAt"`
	Roles        []common.Role `json:"roles,omitempty"`
}

// CreatedAPIKey 比列表项多一个完整密钥，只在创建响应里下发这一次。
type CreatedAPIKey struct {
	APIKeyView
	Key string `json:"key"`
}

func newAPIKeyView(user model.User) APIKeyView {
	return APIKeyView{
		ID:           user.ID,
		Username:     user.Username,
		APIKeyPrefix: fmt.Sprintf("%s%d-", model.APIKeyPrefix, user.ID),
		LastLoginAt:  user.LastLoginAt,
		CreatedAt:    user.CreatedAt,
		UpdatedAt:    user.UpdatedAt,
		Roles:        rbac.GetUserRoles(user),
	}
}

func ListAPIKeys(c *gin.Context) {
	apiKeys, err := model.ListAPIKeyUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list API keys"})
		return
	}
	views := make([]APIKeyView, 0, len(apiKeys))
	for i := range apiKeys {
		views = append(views, newAPIKeyView(apiKeys[i]))
	}
	c.JSON(http.StatusOK, gin.H{"apiKeys": views})
}

func CreateAPIKey(c *gin.Context) {
	var req CreateAPIKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	apiKey, err := model.NewAPIKeyUser(req.Name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to create API key: %v", err)})
		return
	}
	// GetAPIKey 拼出客户端要带在 Authorization 头里的完整密钥；响应是它唯一的出口。
	c.JSON(http.StatusCreated, gin.H{
		"apiKey": CreatedAPIKey{APIKeyView: newAPIKeyView(*apiKey), Key: apiKey.GetAPIKey()},
	})
}

func DeleteAPIKey(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid ID"})
		return
	}

	// 与 ListAPIKeyUsers 一样按 provider 限定：否则持有任意一个设置分区权限的
	// 委派管理员就能借这个接口删除普通账号，绕过 settings.users 授权域
	// （DeleteUserByID 只保护超级管理员与最后一个管理员）。
	user, err := model.GetUserByID(id)
	if err != nil || user.Provider != common.APIKeyProvider {
		c.JSON(http.StatusNotFound, gin.H{"error": "API key not found"})
		return
	}

	// 密钥本身（user.APIKey）由 AuditSnapshot 清掉，审计里只留密钥的名称与配置。
	name := strings.TrimSpace(user.Name)
	if name == "" {
		name = user.Username
	}
	c.Set(common.AdminAuditDetailKey, common.AdminAuditDetail{
		ResourceName: name,
		PreviousYAML: user.AuditSnapshot(),
	})

	if err := model.DeleteUserByID(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete API key"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "API key deleted successfully"})
}
