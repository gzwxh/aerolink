package apikeys

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
)

type CreateAPIKeyRequest struct {
	Name string `json:"name" binding:"required"`
}

func ListAPIKeys(c *gin.Context) {
	apiKeys, err := model.ListAPIKeyUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list API keys"})
		return
	}
	for i := range apiKeys {
		apiKeys[i].Roles = rbac.GetUserRoles(apiKeys[i])
		apiKeys[i].APIKey = model.SecretString(apiKeys[i].GetAPIKey())
	}
	c.JSON(http.StatusOK, gin.H{"apiKeys": apiKeys})
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
	c.JSON(http.StatusCreated, gin.H{"apiKey": apiKey})
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
