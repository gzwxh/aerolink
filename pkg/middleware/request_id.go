package middleware

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"aerolink/pkg/model"
	"github.com/gin-gonic/gin"
)

// RequestIDHeader 是请求关联 ID 的 HTTP 头。
//
// 既用于接收上游（网关 / 反向代理）传入的 ID，也用于在响应里回传：用户报障时可以直接
// 提供这个值，运维据此在日志平台精确定位同一次请求的全部日志。
const RequestIDHeader = "X-Request-ID"

// RequestIDKey 是请求关联 ID 在 gin context 里的键。
const RequestIDKey = "request_id"

// requestIDMaxLength 是接受上游传入 ID 的最大长度，避免超长请求头被写进每一行日志。
const requestIDMaxLength = 128

// RequestID 为每个请求确定一个关联 ID，并注入请求 context 与响应头。
//
// 上游已带 X-Request-ID 时复用它（同一条链上游可能已经打过日志），否则本地生成一个。
// 注入请求 context 是给审计记录用的：审计写入发生在 model 层的 AfterCreate 钩子里，
// 经由 gorm 的 Statement.Context 取到同一个 ID（见 model.RequestIDFromContext）。
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := strings.TrimSpace(c.GetHeader(RequestIDHeader))
		if requestID == "" || len(requestID) > requestIDMaxLength {
			requestID = newRequestID()
		}

		c.Set(RequestIDKey, requestID)
		c.Request = c.Request.WithContext(model.WithRequestID(c.Request.Context(), requestID))
		c.Header(RequestIDHeader, requestID)
		c.Next()
	}
}

// RequestIDFromGin 读取当前请求的关联 ID（没有时返回空串）。
func RequestIDFromGin(c *gin.Context) string {
	if c == nil {
		return ""
	}
	if value, ok := c.Get(RequestIDKey); ok {
		if requestID, ok := value.(string); ok {
			return requestID
		}
	}
	return ""
}

// newRequestID 生成 16 字节随机数的十六进制表示（32 个字符）。
//
// 不引入 ULID 依赖：这个 ID 只需要在链路内唯一且不可预测。
func newRequestID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		// 随机源不可用时退化成时间戳：仍然比空值有用，且不会让请求失败。
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buffer)
}
