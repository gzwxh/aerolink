package captcha

import (
	"testing"
	"time"
)

func TestVerifySingleUse(t *testing.T) {
	code := "1234"
	expires := time.Now().Add(TTL).Unix()
	id := sign(code, expires)

	// First use passes.
	if !Verify(id, code) {
		t.Fatal("first verify with the correct answer should pass")
	}
	// Replay of the same token fails even with the correct answer.
	if Verify(id, code) {
		t.Fatal("replaying a consumed token must fail")
	}

	// Wrong answers never consume the token (a distinct token instance).
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

	// Expired tokens fail.
	expired := sign(code, time.Now().Add(-time.Minute).Unix())
	if Verify(expired, code) {
		t.Fatal("expired token must not verify")
	}

	// Malformed tokens fail.
	for _, bad := range []string{"", "abc", "123.abc", "no-dot"} {
		if Verify(bad, code) {
			t.Fatalf("malformed token %q must not verify", bad)
		}
	}

	// Case and surrounding whitespace are tolerated on answers.
	id3 := sign(code, time.Now().Add(TTL).Add(2*time.Minute).Unix())
	if !Verify(id3, " 1234 ") {
		t.Fatal("answer trimming should be tolerated")
	}
}
