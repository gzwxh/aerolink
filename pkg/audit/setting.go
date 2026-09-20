package audit

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

// GetAuditSetting 返回审计章节的配置：保留策略 + syslog 外发。
//
// 路由：GET /api/v1/admin/audit-setting（需 settings.audit 的读权限）
func GetAuditSetting(c *gin.Context) {
	setting, err := model.GetAuditSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load audit setting: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"setting":              setting,
		"minRetentionDays":     model.MinAuditRetentionDays,
		"recommendedRetention": recommendedRetentionDays,
	})
}

// recommendedRetentionDays 是等保 /《网络安全法》通常核查的最低保留期（不少于 6 个月）。
// 它是提示值而非下限：下限由 model.MinAuditRetentionDays 强制。
const recommendedRetentionDays = 180

// UpdateAuditSetting 保存审计配置。
//
// 路由：PUT /api/v1/admin/audit-setting（需 settings.audit 的写权限）
//
// 这是审计管理员唯一能"改"的东西：保留策略与 syslog 外发。审计记录本身仍然只能读
// （没有任何手工删除接口），删除只可能由保留策略按时间自动滚动发生，且每次都留痕。
func UpdateAuditSetting(c *gin.Context) {
	var req model.AuditSettingData
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	setting, err := model.UpdateAuditSetting(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 保留策略 / 外发地址一变，外发器要立即按新配置工作。
	reloadSyslogConfig()

	c.JSON(http.StatusOK, gin.H{"setting": setting})
}
