package settings

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/auth"
	"github.com/zxh326/kite/pkg/model"
)

// HandleGetLockedLoginIPs lists the client IPs that are currently locked out
// because of failed sign-in attempts.
func HandleGetLockedLoginIPs(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"items": auth.BlockedLoginIPs()})
}

func HandleGetSecuritySetting(c *gin.Context) {
	setting, err := model.GetSecuritySetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load security setting: %v", err)})
		return
	}
	c.JSON(http.StatusOK, setting)
}

// HandleUpdateSecuritySetting merges the request body into the stored policy, so
// callers may send either the whole policy or just the fields they changed.
func HandleUpdateSecuritySetting(c *gin.Context) {
	setting, err := model.GetSecuritySetting()
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to update security setting: %v", err)})
		return
	}
	c.JSON(http.StatusOK, updated)
}
