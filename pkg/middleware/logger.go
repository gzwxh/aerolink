package middleware

import (
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/audit"
	"github.com/gzwxh/aerolink/pkg/model"
)

// dashToEmpty 把日志里的占位符 "-" 还原成空串：归档数据里空就应该是空。
func dashToEmpty(value string) string {
	if value == "-" {
		return ""
	}
	return value
}

var unlogPath = []string{
	"/healthz",
	"/assets/",
	"/favicon.ico",
	"/metrics",
}

func Logger() gin.HandlerFunc {
	return gin.LoggerWithConfig(gin.LoggerConfig{
		Formatter: func(param gin.LogFormatterParams) string {
			// 对健康检查与静态资源路径跳过日志记录
			for _, path := range unlogPath {
				if param.Path == path || strings.HasPrefix(param.Path, path) {
					return ""
				}
			}
			name := "-"
			userID := uint(0)
			if v, ok := param.Keys["user"]; ok {
				if user, ok := v.(model.User); ok {
					name = user.Key()
					userID = user.ID
				}
			}

			cluster := "-"
			if clusterName, exists := param.Keys[ClusterNameKey]; exists {
				cluster = clusterName.(string)
			}

			requestID, _ := param.Keys[RequestIDKey].(string)
			entry := audit.AccessLogEntry{
				At:       param.TimeStamp,
				ClientIP: param.ClientIP,
				Method:   param.Method,
				// 不能用 param.Path：gin 在那里塞了 RawQuery（见 gin.LoggerWithConfig 的实现），
				// 而查询串可能带 token 等敏感值，绝不能进归档（方案 §5）。取原始 URL.Path。
				Path:       param.Request.URL.Path,
				StatusCode: param.StatusCode,
				LatencyMs:  param.Latency.Milliseconds(),
				Cluster:    dashToEmpty(cluster),
				User:       dashToEmpty(name),
				UserID:     userID,
				RequestID:  requestID,
			}
			// 归档（parquet / ES）：非阻塞投递；归档未启用时是空操作。
			// 用 param.Path（URL.Path）而不是带查询串的完整 URL，避免 token 等进入归档。
			audit.RecordAccessLog(entry)

			// 输出格式二选一（方案 §10.3 步骤 11）：默认 text，保持改造前的输出。
			if audit.CurrentAccessLogFormat() == model.LogFormatJSON {
				return audit.FormatAccessLogJSON(entry)
			}

			return fmt.Sprintf("%s - %s \"%s %s\" %d %s %s %s\n",
				param.ClientIP,
				param.TimeStamp.Format("2006-01-02 15:04:05"),
				param.Method,
				param.Path,
				param.StatusCode,
				param.Latency,
				cluster,
				name,
			)
		},
	})
}
