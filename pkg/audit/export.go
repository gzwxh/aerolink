package audit

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

// exportRowLimit 限制单次导出的最大条数，避免一次请求把整张表读进内存。
const exportRowLimit = 100000

// ExportAuditLogs 把操作日志导出为 CSV。
//
// 路由：GET /api/v1/admin/audit-logs/export（需 settings.audit 的读权限）
//
// 过滤条件与列表接口完全一致（同一套 query 构造函数），所以「页面上看到的」和
// 「导出的」永远对得上。条目数与时间范围放在响应头里（CSV 本身不适合塞元数据）：
//   - X-Audit-Row-Count
//   - X-Audit-Time-Range
//
// 导出动作本身会落进操作日志（见 middleware.isAdminAuditRead）。
func ExportAuditLogs(c *gin.Context) {
	// sink≠database 时数据不在库里，直接走归档导出。两条路径的表头是刻意对齐的
	// （见 archive_export.go），所以产出的 CSV 可以直接合并分析。
	if !model.AuditSinkUsesDatabase() {
		ExportAuditHistoryArchive(c)
		return
	}

	from, to, ok := parseTimeRange(c)
	if !ok {
		return
	}
	dateOnly := toIsDateOnly(c)
	query, ok := auditLogQuery(c, from, to, dateOnly)
	if !ok {
		return
	}

	var rows []model.ResourceHistory
	if err := query.Order("created_at DESC").Limit(exportRowLimit).Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	records := make([][]string, 0, len(rows))
	for _, row := range rows {
		operator := row.OperatorName
		if row.Operator != nil && row.Operator.Username != "" {
			operator = row.Operator.Username
		}
		records = append(records, []string{
			row.CreatedAt.Format(time.RFC3339),
			operator,
			row.OperationType,
			row.OperationSource,
			row.ClusterName,
			row.Namespace,
			row.ResourceType,
			row.ResourceName,
			strconv.FormatBool(row.Success),
			row.ErrorMessage,
			row.ClientIP,
			row.UserAgent,
		})
	}

	header := []string{
		"time", "operator", "operation", "source", "cluster", "namespace",
		"resourceType", "resourceName", "success", "errorMessage", "clientIp", "userAgent",
	}
	from, to = effectiveTimeRange(from, to, dateOnly)
	writeCSV(c, "aerolink-audit-logs", header, records, from, to)
}

// ExportLoginLogs 把登录日志（含被拒绝的登录尝试）导出为 CSV。
func ExportLoginLogs(c *gin.Context) {
	if !model.AuditSinkUsesDatabase() {
		ExportLoginRecordArchive(c)
		return
	}

	from, to, ok := parseTimeRange(c)
	if !ok {
		return
	}
	dateOnly := toIsDateOnly(c)
	query, ok := loginLogQuery(c, from, to, dateOnly)
	if !ok {
		return
	}

	var rows []model.LoginRecord
	if err := query.Order("created_at DESC").Limit(exportRowLimit).Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	records := make([][]string, 0, len(rows))
	for _, row := range rows {
		records = append(records, []string{
			row.CreatedAt.Format(time.RFC3339),
			row.Username,
			row.Provider,
			strconv.FormatBool(row.Result == model.LoginResultSuccess),
			row.Result,
			row.IP,
			row.UserAgent,
		})
	}

	header := []string{"time", "username", "provider", "success", "reason", "ip", "userAgent"}
	from, to = effectiveTimeRange(from, to, dateOnly)
	writeCSV(c, "aerolink-login-logs", header, records, from, to)
}

// ExportPasswordChangeLogs 把改密日志导出为 CSV。
func ExportPasswordChangeLogs(c *gin.Context) {
	if !model.AuditSinkUsesDatabase() {
		ExportPasswordChangeRecordArchive(c)
		return
	}

	from, to, ok := parseTimeRange(c)
	if !ok {
		return
	}
	dateOnly := toIsDateOnly(c)
	query, ok := passwordChangeLogQuery(c, from, to, dateOnly)
	if !ok {
		return
	}

	var rows []model.PasswordChangeLog
	if err := query.Order("created_at DESC").Limit(exportRowLimit).Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	records := make([][]string, 0, len(rows))
	for _, row := range rows {
		records = append(records, []string{
			row.CreatedAt.Format(time.RFC3339),
			row.Username,
			row.Operator,
			row.Source,
		})
	}

	header := []string{"time", "username", "operator", "source"}
	from, to = effectiveTimeRange(from, to, dateOnly)
	writeCSV(c, "aerolink-password-change-logs", header, records, from, to)
}

// writeCSV 输出 CSV，并把条目数、时间范围与内容指纹放进响应头（供界面提示与留档）。
//
// 整份响应体先渲染到内存里再一次性写出去：这样才能对**实际发出的字节**算指纹，
// 否则边写边算就只能碰到分块后的碎片。`exportRowLimit` 已经限住了单次导出的体量。
func writeCSV(c *gin.Context, name string, header []string, records [][]string, from, to time.Time) {
	body := renderCSV(header, records)

	filename := name + "-" + time.Now().Format("20060102-150405") + ".csv"
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	c.Header("X-Audit-Row-Count", strconv.Itoa(len(records)))
	c.Header("X-Audit-Time-Range", formatTimeRange(from, to))
	// 完整性指纹：接收方对拿到的文件执行 sha256sum，应等于这个值。
	// HMAC 用服务端持有的密钥算，因此除了校验「文件没被改动」之外，还能证明
	// 「这份导出确实由本服务器生成」——单靠 sha256 的话，谁都能給伪造文件配一个。
	c.Header("X-Audit-Content-SHA256", sha256Hex(body))
	c.Header("X-Audit-Content-HMAC", exportHMAC(body))

	_, _ = c.Writer.Write(body)
}

// renderCSV 把表头与记录渲染成 CSV 字节（带 BOM，让 Excel 正确识别 UTF-8：
// 导出的操作人、错误信息里会有中文）。
func renderCSV(header []string, records [][]string) []byte {
	buffer := &bytes.Buffer{}
	buffer.Write([]byte{0xEF, 0xBB, 0xBF})
	writer := csv.NewWriter(buffer)
	_ = writer.Write(header)
	for _, record := range records {
		if err := writer.Write(record); err != nil {
			break
		}
	}
	writer.Flush()
	return buffer.Bytes()
}

// sha256Hex 计算内容的 SHA-256（十六进制小写）。
func sha256Hex(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

// exportHMAC 用从部署密钥派生的密钥给导出内容签名。
//
// 不直接用 KiteEncryptKey 当 HMAC 密钥：它是给存储凭据加密用的，混用会让同一份
// 密钥承担两种用途。这里先做一次 SHA-256 派生（用途分隔），密钥本身仍然不进日志。
func exportHMAC(content []byte) string {
	seed := sha256.Sum256([]byte("aerolink-audit-export:" + common.KiteEncryptKey))
	mac := hmac.New(sha256.New, seed[:])
	mac.Write(content)
	return hex.EncodeToString(mac.Sum(nil))
}

// formatTimeRange 渲染成 `from/to`（未限制的一端用 *）。
func formatTimeRange(from, to time.Time) string {
	format := func(t time.Time) string {
		if t.IsZero() {
			return "*"
		}
		return t.Format(time.RFC3339)
	}
	return format(from) + "/" + format(to)
}
