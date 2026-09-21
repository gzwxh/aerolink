package audit

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
)

// ArchiveBackends 报告归档检索可用哪些后端、以及默认用哪个。
//
// 路由：GET /api/v1/admin/archive-backends（需 settings.audit 的读权限）
//
// 界面据此渲染后端选择器：
//   - 跟随 sink：sink=parquet 时只有 DuckDB 可用（查本地 / S3 的 parquet），sink=elasticsearch
//     时只有 ES 可用；两者都不可用时界面给出配置引导。
//   - 不可用的后端也会返回（带着原因），而不是直接不出现——管理员才能知道「为什么选不了」。
//
// 响应里带上 sink：五条通道互斥（见方案 §12.13/§12.14），界面需要知道这个部署到底有没有归档，
// 才能给出正确的引导（sink=database 时不该让管理员去审计设置里打开那些已置灰的开关）。
func ArchiveBackends(c *gin.Context) {
	statuses, defaultBackend, err := describeArchiveBackends()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"backends": statuses,
		"default":  string(defaultBackend),
		"sink":     model.AuditSink,
	})
}
