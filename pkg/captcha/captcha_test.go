package captcha

import (
	"testing"
	"time"
)

func TestVerifySingleUse(t *testing.T) {
	code := "1234"
	expires := time.Now().Add(TTL).Unix()
	id := sign(code, expires)

	// 首次使用通过。
	if !Verify(id, code) {
		t.Fatal("first verify with the correct answer should pass")
	}
	// 同一个令牌重放会失败，即使答案正确。
	if Verify(id, code) {
		t.Fatal("replaying a consumed token must fail")
	}

	// 错误答案不会消费令牌（使用另一个令牌实例）。
	id2 := sign(code, time.Now().Add(TTL).Add(time.Minute).Unix())
	if Verify(id2, "0000") {
		t.Fatal("wrong answer must not verify")
	}
	if !Verify(id2, code) {
		t.Fatal("token should still verify after wrong attempts")
	}
	if Verify(id2, code) {
		t.Fatal("second correct use must fail")
	}

	// 过期令牌会失败。
	expired := sign(code, time.Now().Add(-time.Minute).Unix())
	if Verify(expired, code) {
		t.Fatal("expired token must not verify")
	}

	// 格式损坏的令牌会失败。
	for _, bad := range []string{"", "abc", "123.abc", "no-dot"} {
		if Verify(bad, code) {
			t.Fatalf("malformed token %q must not verify", bad)
		}
	}

	// 答案的大小写与首尾空白会被容忍。
	id3 := sign(code, time.Now().Add(TTL).Add(2*time.Minute).Unix())
	if !Verify(id3, " 1234 ") {
		t.Fatal("answer trimming should be tolerated")
	}
}
