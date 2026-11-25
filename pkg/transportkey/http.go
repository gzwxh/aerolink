package transportkey

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/common"
)

// PublicKeyHandler 下发公钥。无需登录：登录表单在拿到会话之前就要用它加密口令。
// 公钥本身不是秘密，但路由应放在限流组内（见 routes.go）。
func PublicKeyHandler(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, Default().Public())
}

// DecryptOrReject 把密文字段解成明文写回 target；失败时直接回 400 并返回 false。
//
// 调用方在密文为空时不要调用它（保持对明文请求的兼容）。
func DecryptOrReject(c *gin.Context, token string, target *string) bool {
	plain, err := DecryptField(token)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
			"error": "invalid encrypted credential",
			"code":  CodeDecryptFailed,
		})
		return false
	}
	*target = plain
	return true
}

// ResolveCredential 取一个凭据字段：有密文（enc）就解密写回 target；只有明文时，
// 普通模式沿用明文（兼容未升级的客户端），强制模式直接回 400。
//
// 返回 false 表示已经写过响应，调用方立即 return。字段整体缺省（target 为空）时不拦截，
// 留给 handler 报「必填」——那种请求里没有任何凭据，没有可泄露的东西。
func ResolveCredential(c *gin.Context, enc string, target *string) bool {
	if enc != "" {
		return DecryptOrReject(c, enc, target)
	}
	if common.RequireEncryptedCredentials && *target != "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
			"error": "credentials must be encrypted",
			"code":  CodeCredentialRequired,
		})
		return false
	}
	return true
}

// UnwrapEnvelopeBody 把 `{"enc": …}` 请求体还原成原始 JSON，供后续中间件（审计要读
// 对象名）与 handler 正常绑定。明文请求原样放行，滚动升级与 tools/apismoke 不受影响。
//
// 必须注册为全局中间件且早于 AdminAudit：审计拿到的必须是还原后的请求体。
func UnwrapEnvelopeBody() gin.HandlerFunc {
	envelopePrefix := []byte(`{"enc"`)

	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodPost, http.MethodPut, http.MethodPatch:
		default:
			c.Next()
			return
		}
		// 只处理 JSON：multipart 上传（头像、Pod 文件）必须保持流式，不能被整体读进内存。
		if c.Request.Body == nil || !strings.Contains(c.GetHeader("Content-Type"), "application/json") {
			c.Next()
			return
		}

		raw, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "unreadable request body"})
			return
		}
		c.Request.Body = io.NopCloser(bytes.NewReader(raw))

		// 绝大多数请求都不是信封：先做一次前缀判断，避免给每个写请求多解一次 JSON。
		if !bytes.HasPrefix(bytes.TrimLeft(raw, " \t\r\n"), envelopePrefix) {
			c.Next()
			return
		}

		var wrapper struct {
			Enc *Envelope `json:"enc"`
		}
		if err := json.Unmarshal(raw, &wrapper); err != nil || wrapper.Enc == nil {
			c.Next()
			return
		}

		body, err := OpenEnvelopeBody(*wrapper.Enc)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
				"error": "invalid encrypted payload",
				"code":  CodePayloadInvalid,
			})
			return
		}

		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		c.Request.ContentLength = int64(len(body))
		c.Request.Header.Set("Content-Length", strconv.Itoa(len(body)))
		c.Next()
	}
}
