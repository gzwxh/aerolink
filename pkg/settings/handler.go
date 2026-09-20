package settings

import (
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

func HandleGetGeneralSetting(c *gin.Context) {
	setting, err := model.GetGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load general setting: %v", err)})
		return
	}
	hasAIAPIKey := strings.TrimSpace(string(setting.AIAPIKey)) != ""
	c.JSON(http.StatusOK, gin.H{
		"aiAgentEnabled":        setting.AIAgentEnabled,
		"aiProvider":            setting.AIProvider,
		"aiModel":               setting.AIModel,
		"aiApiKey":              "",
		"aiApiKeyConfigured":    hasAIAPIKey,
		"aiBaseUrl":             setting.AIBaseURL,
		"aiMaxTokens":           setting.AIMaxTokens,
		"kubectlEnabled":        setting.KubectlEnabled,
		"kubectlImage":          setting.KubectlImage,
		"nodeTerminalImage":     setting.NodeTerminalImage,
		"clusterAgentImage":     setting.ClusterAgentImage,
		"autoBindUserNamespace": setting.AutoBindUserNamespace,
		"enableAnalytics":       setting.EnableAnalytics,
		"enableVersionCheck":    setting.EnableVersionCheck,
		"passwordLoginDisabled": setting.PasswordLoginDisabled,
		"enableMFA":             setting.EnableMFA,
		"loginPrompt":           setting.LoginPrompt,
		"logoUrl":               setting.LogoURL,
		"siteName":              setting.SiteName,
	})
}

// maxLogoURLLength 是自定义 logo 的长度上限（字符）。它同时允许 http(s) 地址与
// data: URL（管理员可以直接传图片），但 bootstrap 是公开接口、每次打开控制台都会拉，
// 所以限制在 256 KiB 以内；更大的图片建议放静态服务器后用 URL 引用。
const maxLogoURLLength = 256 * 1024

// maxSiteNameLength 与 users 表无关，是控制台名称本身的上限（列宽 varchar(100)）。
const maxSiteNameLength = 100

type UpdateGeneralSettingRequest struct {
	AIAgentEnabled    *bool   `json:"aiAgentEnabled"`
	AIProvider        *string `json:"aiProvider"`
	AIModel           *string `json:"aiModel"`
	AIAPIKey          *string `json:"aiApiKey"`
	AIBaseURL         *string `json:"aiBaseUrl"`
	AIMaxTokens       *int    `json:"aiMaxTokens"`
	KubectlEnabled    *bool   `json:"kubectlEnabled"`
	KubectlImage      *string `json:"kubectlImage"`
	NodeTerminalImage *string `json:"nodeTerminalImage"`
	ClusterAgentImage *string `json:"clusterAgentImage"`
	// AutoBindUserNamespace 控制普通用户新建命名空间后是否自动纳入其权限范围。
	AutoBindUserNamespace *bool   `json:"autoBindUserNamespace"`
	EnableAnalytics       *bool   `json:"enableAnalytics"`
	EnableVersionCheck    *bool   `json:"enableVersionCheck"`
	PasswordLoginDisabled *bool   `json:"passwordLoginDisabled"`
	EnableMFA             *bool   `json:"enableMFA"`
	LoginPrompt           *string `json:"loginPrompt"`
	LogoURL               *string `json:"logoUrl"`
	SiteName              *string `json:"siteName"`
}

func HandleUpdateGeneralSetting(c *gin.Context) { //nolint:gocyclo
	var req UpdateGeneralSettingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid request: %v", err)})
		return
	}
	// 更新流程按当前值补默认值，必须读最新的（不能用读缓存）。
	currentSetting, err := model.LoadGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load general setting: %v", err)})
		return
	}

	aiProvider := model.NormalizeGeneralAIProvider(currentSetting.AIProvider)
	if req.AIProvider != nil {
		incomingProvider := strings.ToLower(strings.TrimSpace(*req.AIProvider))
		if incomingProvider != "" {
			if !model.IsGeneralAIProviderSupported(incomingProvider) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported aiProvider"})
				return
			}
			aiProvider = model.NormalizeGeneralAIProvider(incomingProvider)
		}
	}

	aiModel := strings.TrimSpace(currentSetting.AIModel)
	if req.AIModel != nil {
		aiModel = strings.TrimSpace(*req.AIModel)
	}
	if aiModel == "" {
		aiModel = model.DefaultGeneralAIModelByProvider(aiProvider)
	}
	aiAPIKey := strings.TrimSpace(string(currentSetting.AIAPIKey))
	shouldUpdateAIAPIKey := false
	if req.AIAPIKey != nil {
		incomingKey := strings.TrimSpace(*req.AIAPIKey)
		if incomingKey != "" {
			aiAPIKey = incomingKey
			shouldUpdateAIAPIKey = true
		}
	}
	aiAgentEnabled := currentSetting.AIAgentEnabled
	if req.AIAgentEnabled != nil {
		aiAgentEnabled = *req.AIAgentEnabled
	}
	if aiAgentEnabled && aiAPIKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "aiApiKey is required when aiAgentEnabled is true"})
		return
	}

	kubectlEnabled := currentSetting.KubectlEnabled
	if req.KubectlEnabled != nil {
		kubectlEnabled = *req.KubectlEnabled
	}
	kubectlImage := strings.TrimSpace(currentSetting.KubectlImage)
	if req.KubectlImage != nil {
		kubectlImage = strings.TrimSpace(*req.KubectlImage)
	}
	if kubectlEnabled && req.KubectlImage != nil && strings.TrimSpace(*req.KubectlImage) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kubectlImage is required when kubectlEnabled is true"})
		return
	}
	if kubectlImage == "" {
		kubectlImage = model.DefaultGeneralKubectlImageValue()
	}
	nodeTerminalImage := strings.TrimSpace(currentSetting.NodeTerminalImage)
	if req.NodeTerminalImage != nil {
		nodeTerminalImage = strings.TrimSpace(*req.NodeTerminalImage)
	}
	if nodeTerminalImage == "" {
		nodeTerminalImage = model.DefaultGeneralNodeTerminalImageValue()
	}
	clusterAgentImage := strings.TrimSpace(currentSetting.ClusterAgentImage)
	if req.ClusterAgentImage != nil {
		clusterAgentImage = strings.TrimSpace(*req.ClusterAgentImage)
	}
	if clusterAgentImage == "" {
		clusterAgentImage = model.DefaultGeneralClusterAgentImageValue()
	}

	aiMaxTokens := currentSetting.AIMaxTokens
	if req.AIMaxTokens != nil {
		aiMaxTokens = *req.AIMaxTokens
	}
	if aiMaxTokens <= 0 {
		aiMaxTokens = 16384
	}

	updates := map[string]interface{}{}
	if req.AIAgentEnabled != nil {
		updates["ai_agent_enabled"] = aiAgentEnabled
	}
	if req.AIProvider != nil {
		updates["ai_provider"] = aiProvider
	}
	if req.AIModel != nil {
		updates["ai_model"] = aiModel
	}
	if req.AIBaseURL != nil {
		updates["ai_base_url"] = strings.TrimSpace(*req.AIBaseURL)
	}
	if req.AIMaxTokens != nil {
		updates["ai_max_tokens"] = aiMaxTokens
	}
	if req.KubectlEnabled != nil {
		updates["kubectl_enabled"] = kubectlEnabled
	}
	if req.KubectlImage != nil {
		updates["kubectl_image"] = kubectlImage
	}
	if req.NodeTerminalImage != nil {
		updates["node_terminal_image"] = nodeTerminalImage
	}
	if req.ClusterAgentImage != nil {
		updates["cluster_agent_image"] = clusterAgentImage
	}
	if req.AutoBindUserNamespace != nil {
		updates["auto_bind_user_namespace"] = *req.AutoBindUserNamespace
	}
	if req.EnableAnalytics != nil {
		updates["enable_analytics"] = *req.EnableAnalytics
	}
	if req.EnableVersionCheck != nil {
		updates["enable_version_check"] = *req.EnableVersionCheck
	}
	if req.LoginPrompt != nil {
		updates["login_prompt"] = strings.TrimSpace(*req.LoginPrompt)
	}
	if req.LogoURL != nil {
		logoURL := strings.TrimSpace(*req.LogoURL)
		if len(logoURL) > maxLogoURLLength {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("logoUrl must be at most %d characters", maxLogoURLLength)})
			return
		}
		updates["logo_url"] = logoURL
	}
	if req.SiteName != nil {
		siteName := strings.TrimSpace(*req.SiteName)
		if utf8.RuneCountInString(siteName) > maxSiteNameLength {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("siteName must be at most %d characters", maxSiteNameLength)})
			return
		}
		updates["site_name"] = siteName
	}
	if req.PasswordLoginDisabled != nil {
		updates["password_login_disabled"] = *req.PasswordLoginDisabled
	}
	if req.EnableMFA != nil {
		updates["enable_mfa"] = *req.EnableMFA
	}
	if shouldUpdateAIAPIKey {
		updates["ai_api_key"] = model.SecretString(aiAPIKey)
	}

	updated, err := model.UpdateGeneralSetting(updates)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to update general setting: %v", err)})
		return
	}

	hasAIAPIKey := strings.TrimSpace(string(updated.AIAPIKey)) != ""
	c.JSON(http.StatusOK, gin.H{
		"aiAgentEnabled":        updated.AIAgentEnabled,
		"aiProvider":            updated.AIProvider,
		"aiModel":               updated.AIModel,
		"aiApiKey":              "",
		"aiApiKeyConfigured":    hasAIAPIKey,
		"aiBaseUrl":             updated.AIBaseURL,
		"aiMaxTokens":           updated.AIMaxTokens,
		"kubectlEnabled":        updated.KubectlEnabled,
		"kubectlImage":          updated.KubectlImage,
		"nodeTerminalImage":     updated.NodeTerminalImage,
		"clusterAgentImage":     updated.ClusterAgentImage,
		"autoBindUserNamespace": updated.AutoBindUserNamespace,
		"enableAnalytics":       updated.EnableAnalytics,
		"enableVersionCheck":    updated.EnableVersionCheck,
		"passwordLoginDisabled": updated.PasswordLoginDisabled,
		"enableMFA":             updated.EnableMFA,
		"loginPrompt":           updated.LoginPrompt,
		"logoUrl":               updated.LogoURL,
		"siteName":              updated.SiteName,
	})
}
