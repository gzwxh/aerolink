package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
)

// mfaTicketTTL 是第三方登录「待验证」票据的有效期。
//
// 这个窗口量的是人的操作时间（掏手机、打开认证器、看清 6 位数），不是动态码本身的
// 有效期：动态码在提交那一刻现算。太短会让慢手用户反复重走身份源登录，太长则让
// URL 里那张票据在浏览器历史和访问日志里躺得过久。
const mfaTicketTTL = 5 * time.Minute

// mfaTicketSigningPrefix 做域分隔，让这张票据的 HMAC 不会与同样使用
// JwtSecret 的其它签名（JWT、MFA 信任 cookie）互相顶替。
const mfaTicketSigningPrefix = "aerolink-mfa-pending:"

// errMFATicketInvalid 覆盖签名不对、格式不对、过期等情况。对外只说「票据不可用」，
// 不区分是哪一种，免得给探测者反馈。
var errMFATicketInvalid = errors.New("mfa pending ticket is invalid")

// mfaTicketPayload 是票据的内容。它**不**包含任何凭据：
// 拿到票据本身换不到任何权限，必须再加上正确的动态码。
type mfaTicketPayload struct {
	UserID uint   `json:"uid"`
	Issued int64  `json:"iat"`
	Nonce  string `json:"nonce"`
}

// issueMFATicket 为一次第三方登录签发短时票据，并把它的 nonce 登记进库
// （一次性由 `model.ConsumeMFAPendingTicket` 的原子删除保证）。
func issueMFATicket(userID uint) (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	encodedNonce := base64.RawURLEncoding.EncodeToString(nonce)
	now := time.Now()
	if err := model.SaveMFAPendingTicket(encodedNonce, userID, now.Add(mfaTicketTTL)); err != nil {
		return "", err
	}

	raw, err := json.Marshal(mfaTicketPayload{
		UserID: userID,
		Issued: now.Unix(),
		Nonce:  encodedNonce,
	})
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	return body + "." + signMFATicket(body), nil
}

func signMFATicket(body string) string {
	mac := hmac.New(sha256.New, []byte(common.JwtSecret))
	mac.Write([]byte(mfaTicketSigningPrefix))
	mac.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// validateMFATicket 校验签名与有效期并返回票据内容。
//
// 它**不**消费票据：票据只在动态码校验通过后才作废（见 consumeMFATicket），
// 否则用户输错一次就得重新走一遍身份源登录。
func validateMFATicket(ticket string, now time.Time) (mfaTicketPayload, error) {
	var payload mfaTicketPayload

	body, signature, ok := strings.Cut(ticket, ".")
	if !ok || body == "" || signature == "" {
		return payload, errMFATicketInvalid
	}
	if !hmac.Equal([]byte(signMFATicket(body)), []byte(signature)) {
		return payload, errMFATicketInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return payload, errMFATicketInvalid
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return payload, errMFATicketInvalid
	}
	if payload.UserID == 0 || payload.Nonce == "" {
		return payload, errMFATicketInvalid
	}

	issued := time.Unix(payload.Issued, 0)
	if now.Sub(issued) > mfaTicketTTL {
		return mfaTicketPayload{}, errMFATicketInvalid
	}
	// 明显来自未来的签发作息（时钟回拨或伪造）：留一分钟容差。
	if issued.Sub(now) > time.Minute {
		return mfaTicketPayload{}, errMFATicketInvalid
	}
	return payload, nil
}

// consumeMFATicket 作废一张票据（一次性）。返回 errMFATicketInvalid 表示它不存在、
// 已过期或已经被兑换过。
//
// 状态在数据库里而不是进程内存里，所以控制台跑多个副本时，兑换请求落到哪个副本都成立。
func consumeMFATicket(payload mfaTicketPayload, now time.Time) error {
	consumed, err := model.ConsumeMFAPendingTicket(payload.Nonce, now)
	if err != nil {
		return err
	}
	if !consumed {
		return errMFATicketInvalid
	}
	return nil
}
