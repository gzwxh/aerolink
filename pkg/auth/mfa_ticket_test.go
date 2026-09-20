package auth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

// setupTicketTestDB 建一个带票据登记表的测试库：票据的「一次性」落在数据库上，
// 这样控制台跑多个副本时，兑换请求落到哪个副本都成立。
func setupTicketTestDB(t *testing.T) {
	t.Helper()
	setupAuthIntegrationDB(t)
	if err := model.DB.AutoMigrate(&model.MFAPendingTicket{}); err != nil {
		t.Fatalf("migrating mfa pending tickets: %v", err)
	}
}

// withTicketSecret 固定住签名密钥：票据的 HMAC 是绑在 common.JwtSecret 上的。
func withTicketSecret(t *testing.T) {
	t.Helper()
	original := common.JwtSecret
	common.JwtSecret = "mfa-ticket-test-secret"
	t.Cleanup(func() { common.JwtSecret = original })
}

func countPendingTicket(t *testing.T, nonce string) int64 {
	t.Helper()
	var count int64
	if err := model.DB.Model(&model.MFAPendingTicket{}).Where("nonce = ?", nonce).Count(&count).Error; err != nil {
		t.Fatalf("counting pending tickets: %v", err)
	}
	return count
}

func TestMFATicketRoundTrip(t *testing.T) {
	setupTicketTestDB(t)
	withTicketSecret(t)

	ticket, err := issueMFATicket(42)
	if err != nil {
		t.Fatalf("issueMFATicket() error = %v", err)
	}

	payload, err := validateMFATicket(ticket, time.Now())
	if err != nil {
		t.Fatalf("validateMFATicket() error = %v", err)
	}
	if payload.UserID != 42 {
		t.Fatalf("payload.UserID = %d, want 42", payload.UserID)
	}
	if payload.Nonce == "" {
		t.Fatal("payload.Nonce is empty")
	}
	if got := countPendingTicket(t, payload.Nonce); got != 1 {
		t.Fatalf("pending ticket rows = %d, want 1", got)
	}

	// 两张票据的 nonce 必须不同，否则「一次性」失去意义。
	second, err := issueMFATicket(42)
	if err != nil {
		t.Fatalf("issueMFATicket() error = %v", err)
	}
	secondPayload, err := validateMFATicket(second, time.Now())
	if err != nil {
		t.Fatalf("validateMFATicket() error = %v", err)
	}
	if secondPayload.Nonce == payload.Nonce {
		t.Fatal("two tickets share the same nonce")
	}
}

func TestValidateMFATicketRejectsBadInput(t *testing.T) {
	setupTicketTestDB(t)
	withTicketSecret(t)

	ticket, err := issueMFATicket(7)
	if err != nil {
		t.Fatalf("issueMFATicket() error = %v", err)
	}

	// 签名绑定密钥：换密钥后同一张票据必须失效，否则任何拿到过密钥的人
	// （例如换过 JwtSecret 的旧部署）签的票据还能用。
	swapped := common.JwtSecret
	common.JwtSecret = "rotated-secret"
	_, swappedErr := validateMFATicket(ticket, time.Now())
	common.JwtSecret = swapped
	if !errors.Is(swappedErr, errMFATicketInvalid) {
		t.Fatalf("a ticket signed with another secret was accepted: %v", swappedErr)
	}

	// 过期：票据只在签发后的窗口内有效。
	if _, err := validateMFATicket(ticket, time.Now().Add(mfaTicketTTL+time.Second)); !errors.Is(err, errMFATicketInvalid) {
		t.Fatalf("an expired ticket was accepted: %v", err)
	}
	// 边界内仍然有效，别把窗口收紧成 0。
	if _, err := validateMFATicket(ticket, time.Now().Add(mfaTicketTTL-time.Second)); err != nil {
		t.Fatalf("a ticket inside the window was rejected: %v", err)
	}

	for _, bad := range []string{
		"",
		"not-a-ticket",
		"a.b",
		ticket + "x",
		ticket[:len(ticket)-1] + "A",
	} {
		if _, err := validateMFATicket(bad, time.Now()); !errors.Is(err, errMFATicketInvalid) {
			t.Errorf("validateMFATicket(%q) error = %v, want errMFATicketInvalid", bad, err)
		}
	}

	// 明显来自未来的签发作息（时钟回拨/伪造）必须拒绝。手工造一张签名合法的票据。
	raw, err := json.Marshal(mfaTicketPayload{
		UserID: 7,
		Issued: time.Now().Add(10 * time.Minute).Unix(),
		Nonce:  base64.RawURLEncoding.EncodeToString([]byte("future-nonce")),
	})
	if err != nil {
		t.Fatalf("marshalling payload: %v", err)
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	if _, err := validateMFATicket(body+"."+signMFATicket(body), time.Now()); !errors.Is(err, errMFATicketInvalid) {
		t.Fatalf("a ticket issued in the future was accepted: %v", err)
	}
}

// 一次性由数据库保证：兑换就是删掉登记行，所以同一张票据第二次兑换必然失败——
// 多副本部署下这个性质同样成立（状态不在进程内存里）。
func TestConsumeMFATicketIsSingleUse(t *testing.T) {
	setupTicketTestDB(t)
	withTicketSecret(t)

	ticket, err := issueMFATicket(9)
	if err != nil {
		t.Fatalf("issueMFATicket() error = %v", err)
	}
	payload, err := validateMFATicket(ticket, time.Now())
	if err != nil {
		t.Fatalf("validateMFATicket() error = %v", err)
	}

	if err := consumeMFATicket(payload, time.Now()); err != nil {
		t.Fatalf("consumeMFATicket() error = %v", err)
	}
	if got := countPendingTicket(t, payload.Nonce); got != 0 {
		t.Fatalf("pending ticket rows = %d after consumption, want 0", got)
	}
	if err := consumeMFATicket(payload, time.Now()); !errors.Is(err, errMFATicketInvalid) {
		t.Fatalf("the same ticket was consumed twice: %v", err)
	}
}

// 过期的登记行既不能兑换，也不会留在表里（签发新票据时会顺手清理）。
func TestExpiredMFATicketCannotBeConsumedAndIsCleanedUp(t *testing.T) {
	setupTicketTestDB(t)
	withTicketSecret(t)

	ticket, err := issueMFATicket(11)
	if err != nil {
		t.Fatalf("issueMFATicket() error = %v", err)
	}
	payload, err := validateMFATicket(ticket, time.Now())
	if err != nil {
		t.Fatalf("validateMFATicket() error = %v", err)
	}

	expiredAt := time.Now().Add(mfaTicketTTL + time.Minute)
	if err := consumeMFATicket(payload, expiredAt); !errors.Is(err, errMFATicketInvalid) {
		t.Fatalf("an expired ticket was consumed: %v", err)
	}
	if got := countPendingTicket(t, payload.Nonce); got != 1 {
		t.Fatalf("an expired row was dropped before the cleanup ran: %d", got)
	}

	if err := model.CleanupExpiredMFAPendingTickets(expiredAt); err != nil {
		t.Fatalf("cleanup error = %v", err)
	}
	if got := countPendingTicket(t, payload.Nonce); got != 0 {
		t.Fatalf("expired rows were not cleaned up: %d left", got)
	}
}
