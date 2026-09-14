package auth

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

type UpdateLDAPSettingRequest struct {
	Enabled              *bool   `json:"enabled"`
	ServerURL            *string `json:"serverUrl"`
	UseStartTLS          *bool   `json:"useStartTLS"`
	BindDN               *string `json:"bindDn"`
	BindPassword         *string `json:"bindPassword"`
	UserBaseDN           *string `json:"userBaseDn"`
	UserFilter           *string `json:"userFilter"`
	UsernameAttribute    *string `json:"usernameAttribute"`
	DisplayNameAttribute *string `json:"displayNameAttribute"`
	GroupBaseDN          *string `json:"groupBaseDn"`
	GroupFilter          *string `json:"groupFilter"`
	GroupNameAttribute   *string `json:"groupNameAttribute"`
	AutoSync             *bool   `json:"autoSync"`
	SyncIntervalMinutes  *int    `json:"syncIntervalMinutes"`
}

func (h *AuthHandler) GetLDAPSetting(c *gin.Context) {
	setting, err := model.GetLDAPSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load ldap setting: %v", err)})
		return
	}

	c.JSON(http.StatusOK, ldapSettingResponse(setting))
}

func (h *AuthHandler) UpdateLDAPSetting(c *gin.Context) {
	if common.IsSectionManaged("ldap") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	var req UpdateLDAPSettingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid request: %v", err)})
		return
	}

	currentSetting, err := model.GetLDAPSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load ldap setting: %v", err)})
		return
	}

	updatedSetting := mergeLDAPSetting(currentSetting, req)
	if err := updatedSetting.Validate(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	updated, err := model.UpdateLDAPSetting(&updatedSetting)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to update ldap setting: %v", err)})
		return
	}

	// Re-sync promptly after the settings are saved so fixes to the directory
	// configuration (or newly enabled LDAP) are reflected quickly.
	TriggerLDAPSync()

	c.JSON(http.StatusOK, ldapSettingResponse(updated))
}

func ldapSettingResponse(setting *model.LDAPSetting) gin.H {
	return gin.H{
		"enabled":                setting.Enabled,
		"serverUrl":              setting.ServerURL,
		"useStartTLS":            setting.UseStartTLS,
		"bindDn":                 setting.BindDN,
		"bindPassword":           "",
		"bindPasswordConfigured": setting.BindPasswordConfigured(),
		"userBaseDn":             setting.UserBaseDN,
		"userFilter":             setting.UserFilter,
		"usernameAttribute":      setting.UsernameAttribute,
		"displayNameAttribute":   setting.DisplayNameAttribute,
		"groupBaseDn":            setting.GroupBaseDN,
		"groupFilter":            setting.GroupFilter,
		"groupNameAttribute":     setting.GroupNameAttribute,
		"autoSync":               setting.AutoSync,
		"syncIntervalMinutes":    setting.SyncIntervalMinutes,
	}
}

// SyncLDAPUsers triggers an immediate alignment sync. It never provisions new
// users — new accounts are created through ImportLDAPUsers after the admin
// picks them interactively.
func (h *AuthHandler) SyncLDAPUsers(c *gin.Context) {
	setting, err := model.GetLDAPSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load ldap setting: %v", err)})
		return
	}
	if !setting.Enabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "LDAP is not enabled"})
		return
	}
	if !StartManualLDAPSync() {
		c.JSON(http.StatusConflict, gin.H{"error": "an LDAP sync is already running or queued"})
		return
	}
	c.JSON(http.StatusAccepted, GetLDAPSyncStatus())
}

func (h *AuthHandler) GetLDAPSyncStatus(c *gin.Context) {
	c.JSON(http.StatusOK, GetLDAPSyncStatus())
}

// ListLDAPImportCandidates exposes directory users for the interactive import
// picker (username, display name, already-imported / conflict flags).
func (h *AuthHandler) ListLDAPImportCandidates(c *gin.Context) {
	setting, err := model.GetLDAPSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load ldap setting: %v", err)})
		return
	}
	if !setting.Enabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "LDAP is not enabled"})
		return
	}
	candidates, err := ListLDAPImportCandidates(setting)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to list ldap users: %v", err)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": candidates, "total": len(candidates)})
}

// ImportLDAPUsers imports the directory users the admin selected in the picker.
func (h *AuthHandler) ImportLDAPUsers(c *gin.Context) {
	var req struct {
		Usernames      []string `json:"usernames"`
		EnableImported bool     `json:"enableImported"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid request: %v", err)})
		return
	}
	if len(req.Usernames) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no users selected"})
		return
	}
	setting, err := model.GetLDAPSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load ldap setting: %v", err)})
		return
	}
	if !setting.Enabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "LDAP is not enabled"})
		return
	}
	result, err := ImportLDAPUsers(setting, req.Usernames, req.EnableImported)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to import ldap users: %v", err)})
		return
	}
	TriggerLDAPSync()
	c.JSON(http.StatusOK, result)
}

func mergeLDAPSetting(current *model.LDAPSetting, req UpdateLDAPSettingRequest) model.LDAPSetting {
	merged := current.Normalized()
	if req.Enabled != nil {
		merged.Enabled = *req.Enabled
	}
	if req.ServerURL != nil {
		merged.ServerURL = strings.TrimSpace(*req.ServerURL)
	}
	if req.UseStartTLS != nil {
		merged.UseStartTLS = *req.UseStartTLS
	}
	if req.BindDN != nil {
		merged.BindDN = strings.TrimSpace(*req.BindDN)
	}
	if req.BindPassword != nil && *req.BindPassword != "" {
		merged.BindPassword = model.SecretString(*req.BindPassword)
	}
	if req.UserBaseDN != nil {
		merged.UserBaseDN = strings.TrimSpace(*req.UserBaseDN)
	}
	if req.UserFilter != nil {
		merged.UserFilter = strings.TrimSpace(*req.UserFilter)
	}
	if req.UsernameAttribute != nil {
		merged.UsernameAttribute = strings.TrimSpace(*req.UsernameAttribute)
	}
	if req.DisplayNameAttribute != nil {
		merged.DisplayNameAttribute = strings.TrimSpace(*req.DisplayNameAttribute)
	}
	if req.GroupBaseDN != nil {
		merged.GroupBaseDN = strings.TrimSpace(*req.GroupBaseDN)
	}
	if req.GroupFilter != nil {
		merged.GroupFilter = strings.TrimSpace(*req.GroupFilter)
	}
	if req.GroupNameAttribute != nil {
		merged.GroupNameAttribute = strings.TrimSpace(*req.GroupNameAttribute)
	}
	if req.AutoSync != nil {
		merged.AutoSync = *req.AutoSync
	}
	if req.SyncIntervalMinutes != nil {
		merged.SyncIntervalMinutes = *req.SyncIntervalMinutes
	}
	return merged.Normalized()
}
