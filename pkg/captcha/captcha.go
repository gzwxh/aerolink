// Package captcha 负责渲染并校验登录验证码。
//
// 生成器遵循参考实现使用的可读性规则：
// 纯白不透明背景、深色数字、只含数字，以及一条
// 空心干扰线（无噪点、无横穿数字的实心笔画、无透明度）。
//
// 与基于存储的实现（Redis / 内存）不同，答案本身
// 从不被保存：返回给客户端的 id 携带过期时间，以及对期望答案的
// HMAC，因此无法从 id 中反推出验证码。
// 唯一的服务端状态是已消费 id 的集合，
// 这让每个令牌都是一次性的。
package captcha

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gzwxh/aerolink/pkg/common"
)

const (
	// TTL 是一个已生成验证码的有效时长。
	TTL = 5 * time.Minute
	// CodeLength 是验证码的数字位数。
	CodeLength = 4

	// 画布尺寸；与前端 .captcha-box（120x44）一致，
	// 这样图片不会被拉伸。
	imageWidth  = 120
	imageHeight = 44

	// 4 个字形按 4 倍尺寸绘制（每个 20x28px），字形之间与四周各留 8px 边距。
	scale = 4
)

// font 保存 "0"-"9" 的 5x7 位图；五个 bit 中最高位
// 对应最左侧那一列。
var font = [10][7]uint8{
	{0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E}, // 0
	{0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E}, // 1
	{0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F}, // 2
	{0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E}, // 3
	{0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02}, // 4
	{0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E}, // 5
	{0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E}, // 6
	{0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08}, // 7
	{0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E}, // 8
	{0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C}, // 9
}

// consumed 记录已经通过校验的 idKey。没有它的话，
// 令牌在整个 TTL 内都有效，其 4 位数字码可以被
// 反复提交暴力枚举。条目保存过期时间戳，
// 由下面的清理协程回收。
var consumed sync.Map

// Make 返回一个新验证码的签名 id 与渲染后的图片（PNG data URL）。
func Make() (idKey string, image string, err error) {
	code, err := randomCode()
	if err != nil {
		return "", "", err
	}
	rendered, err := render(code)
	if err != nil {
		return "", "", err
	}
	return sign(code, time.Now().Add(TTL).Unix()), rendered, nil
}

// Verify 报告答案是否与该 id 签名时的验证码一致。
// 令牌是一次性的：一旦某个答案被接受，同一个 idKey 就永远
// 无法再次通过校验，因此短验证码无法在其 TTL 内被枚举。
func Verify(idKey string, answer string) bool {
	expiresPart, signature, ok := strings.Cut(strings.TrimSpace(idKey), ".")
	if !ok {
		return false
	}
	expires, err := strconv.ParseInt(expiresPart, 10, 64)
	if err != nil || time.Now().Unix() > expires {
		return false
	}
	if !hmac.Equal([]byte(signAnswer(answer, expires)), []byte(signature)) {
		return false
	}
	// LoadOrStore 是原子的：同一个令牌的两次并发提交
	// 不可能都成功。
	_, alreadyUsed := consumed.LoadOrStore(idKey, expires)
	if alreadyUsed {
		return false
	}
	startJanitor()
	return true
}

// startJanitor 清掉已消费的条目——它们反正已经过期。
var janitorOnce sync.Once

func startJanitor() {
	janitorOnce.Do(func() {
		go func() {
			for {
				time.Sleep(TTL)
				now := time.Now().Unix()
				consumed.Range(func(key, value any) bool {
					if expiry, ok := value.(int64); ok && now > expiry {
						consumed.Delete(key)
					}
					return true
				})
			}
		}()
	})
}

func sign(code string, expires int64) string {
	return strconv.FormatInt(expires, 10) + "." + signAnswer(code, expires)
}

func signAnswer(answer string, expires int64) string {
	// 与同一密钥的其它 HMAC 用途（例如 MFA
	// 信任 cookie）做了域分离，所以两者绝不会互相混淆。
	mac := hmac.New(sha256.New, []byte(common.JwtSecret))
	mac.Write([]byte("captcha:" + strings.ToLower(strings.TrimSpace(answer)) + ":" + strconv.FormatInt(expires, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

func randomCode() (string, error) {
	var builder strings.Builder
	for i := 0; i < CodeLength; i++ {
		digit, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		builder.WriteString(strconv.FormatInt(digit.Int64(), 10))
	}
	return builder.String(), nil
}

func randomInt(max int) int {
	value, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
	if err != nil {
		return 0
	}
	return int(value.Int64())
}

func render(code string) (string, error) {
	img := image.NewRGBA(image.Rect(0, 0, imageWidth, imageHeight))
	// 不透明纯白：让数字保持高对比，并避免整张
	// 图片在深色登录背景上变暗。
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{R: 255, G: 255, B: 255, A: 255}}, image.Point{}, draw.Src)

	glyphWidth := 5 * scale
	glyphHeight := 7 * scale
	margin := (imageWidth - CodeLength*glyphWidth) / (CodeLength + 1)

	for i, char := range code {
		glyph := font[int(char-'0')]
		offsetX := margin + i*(glyphWidth+margin) + randomInt(3) - 1
		offsetY := (imageHeight-glyphHeight)/2 + randomInt(5) - 2
		ink := inkColor()
		for row := 0; row < 7; row++ {
			for col := 0; col < 5; col++ {
				if glyph[row]&(1<<uint(4-col)) == 0 {
					continue
				}
				for dy := 0; dy < scale; dy++ {
					for dx := 0; dx < scale; dx++ {
						img.Set(offsetX+col*scale+dx, offsetY+row*scale+dy, ink)
					}
				}
			}
		}
	}

	drawHollowLine(img)

	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buffer.Bytes()), nil
}

// drawHollowLine 绘制唯一那条只有轮廓的干扰曲线：两条
// 相距几个像素的细线、中间镂空，因此它读起来绝不像
// 一条横穿数字的实心条。
func drawHollowLine(img *image.RGBA) {
	amplitude := 7 + float64(randomInt(4))
	frequency := 1.5 + float64(randomInt(2))
	ink := lineColor()

	for x := 0; x < imageWidth; x++ {
		offset := int(amplitude * math.Sin(2*math.Pi*frequency*float64(x)/float64(imageWidth)))
		center := imageHeight/2 + offset
		img.Set(x, center-2, ink)
		img.Set(x, center+2, ink)
	}
}

func inkColor() color.RGBA {
	return color.RGBA{
		R: uint8(17 + randomInt(60)),
		G: uint8(24 + randomInt(60)),
		B: uint8(39 + randomInt(60)),
		A: 255,
	}
}

func lineColor() color.RGBA {
	return color.RGBA{R: 150, G: 158, B: 178, A: 255}
}
