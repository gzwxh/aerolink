// Package imageupload 收敛「上传的图片能不能收」这一件事：按内容嗅探类型、
// 只读图片头验证结构可解、限制边长与体积。
//
// 头像（pkg/users）与集群徽章图标（pkg/cluster）都用它。这类判定是安全边界
// （类型白名单决定了什么内容会被内联返回给浏览器），各写一份迟早会漂移出缺口，
// 所以只有这一份实现。
package imageupload

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"net/http"
	"strings"

	// 只接受 PNG / JPEG：这两个解码器必须注册，否则 image.DecodeConfig 认不出来。
	_ "image/jpeg"
	_ "image/png"
)

// 上传图片的三个硬限制，服务端强制、前端同时给出说明
// （见 docs/dev/plans/2026-09-20-集群徽章与集群切换器.md）。
const (
	// MaxBytes 是单张图片的字节上限。前端会先在浏览器里裁方并缩放到目标边长以内
	// 再上传（头像 512×512、集群图标 256×256，通常 20–80 KB），正常操作撞不到这个上限。
	MaxBytes = 1 << 20 // 1 MiB
	// MaxBodyBytes 给 multipart 的边界与字段名留出余量，超出的请求体直接拒收，
	// 不会读进内存。
	MaxBodyBytes = MaxBytes + 64<<10
	// MaxDimension 是边长上限，只读图片头（image.DecodeConfig）判定，不解码全图。
	MaxDimension = 1024
)

// contentTypes 是允许的图片类型（按内容嗅探得到的 MIME）。
// SVG 不在其中：它是脚本载体，内联返回等于存储型 XSS。
var contentTypes = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpeg",
}

var (
	ErrInvalidType        = errors.New("image must be a PNG or JPEG image")
	ErrInvalidImage       = errors.New("image is not a readable image")
	ErrTooLargeDimensions = fmt.Errorf("image must not exceed %d×%d pixels", MaxDimension, MaxDimension)
)

// Validate 按内容判定上传的字节是否是允许的图片，返回嗅探出的 MIME。
// 只信内容：客户端的文件名与 Content-Type 都可以随便写。
func Validate(data []byte) (string, error) {
	contentType := http.DetectContentType(data)
	expectedFormat, ok := contentTypes[contentType]
	if !ok {
		return "", ErrInvalidType
	}

	// DecodeConfig 只解析图片头，顺便验证结构可解（截断/损坏的文件在这里被拒），
	// 并拿到边长。format 与嗅探结果必须一致，避免「PNG 头 + 其它数据」这类混淆。
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", ErrInvalidImage
	}
	if format != expectedFormat {
		return "", ErrInvalidType
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return "", ErrInvalidImage
	}
	if cfg.Width > MaxDimension || cfg.Height > MaxDimension {
		return "", ErrTooLargeDimensions
	}
	return contentType, nil
}

// IsBodyTooLargeError 判断错误是不是 http.MaxBytesReader 抛出的超限错误。
// 驱动在不同版本下措辞不同，统一按子串判定（与 pod 文件上传的做法一致）。
func IsBodyTooLargeError(err error) bool {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		return true
	}
	return strings.Contains(err.Error(), "request body too large")
}
