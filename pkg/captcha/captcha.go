// Package captcha renders the login captcha and verifies it.
//
// The generator follows the readability rules used by the reference
// implementation: pure white opaque background, dark digits, digits only and a
// single hollow interference line (no speckles, no solid strokes crossing the
// digits, no transparency).
//
// Unlike a store backed implementation (Redis / in-memory) the answer itself is
// never stored: the id returned to the client carries the expiry and an HMAC
// over the expected answer, so the code can never be read back out of the id.
// The only server side state is the set of already consumed ids, which makes
// every token single use.
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

	"github.com/zxh326/kite/pkg/common"
)

const (
	// TTL is how long a generated captcha stays valid.
	TTL = 5 * time.Minute
	// CodeLength is the number of digits in a captcha.
	CodeLength = 4

	// Canvas size; matches the frontend .captcha-box (120x44) so the image is
	// not stretched.
	imageWidth  = 120
	imageHeight = 44

	// 4 glyphs at 4x (20x28px each) leave an 8px margin between and around them.
	scale = 4
)

// font holds the 5x7 bitmaps of "0"-"9"; the most significant of the five bits
// is the left-most column.
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

// consumed tracks the idKeys that already passed verification. Without it a
// token stays valid for the whole TTL and its 4-digit code can be brute
// forced with repeated submissions. Entries hold the expiry timestamp and are
// swept by the janitor below.
var consumed sync.Map

// Make returns the signed id and the rendered image (PNG data URL) of a fresh
// captcha.
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

// Verify reports whether the answer matches the code the id was signed for.
// A token is single use: once an answer is accepted the same idKey can never
// verify again, so the short code cannot be enumerated within its TTL.
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
	// LoadOrStore is atomic: two concurrent submissions of the same token
	// cannot both win.
	_, alreadyUsed := consumed.LoadOrStore(idKey, expires)
	if alreadyUsed {
		return false
	}
	startJanitor()
	return true
}

// startJanitor drops consumed entries once they are expired anyway.
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
	// Domain-separated from other HMAC uses of the same secret (e.g. the MFA
	// trust cookie) so the two can never be confused with each other.
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
	// Opaque pure white: keeps the digits high contrast and avoids the whole
	// image turning dark on dark login backgrounds.
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

// drawHollowLine draws the single outline-only interference curve: two thin
// strokes a couple of pixels apart with an empty middle, so it never reads as a
// solid bar across the digits.
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
