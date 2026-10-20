package transportkey

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	cipher := testCipher(t)
	body := []byte(`{"kind":"Secret","data":{"tls.key":"-----BEGIN PRIVATE KEY-----"}}`)

	envelope, err := cipher.EncryptEnvelopeBody(body)
	if err != nil {
		t.Fatalf("encrypting envelope: %v", err)
	}
	got, err := cipher.OpenEnvelope(envelope)
	if err != nil {
		t.Fatalf("opening envelope: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("envelope body = %s, want %s", got, body)
	}
}

func TestEnvelopeRejectsTamperedPayload(t *testing.T) {
	cipher := testCipher(t)
	envelope, err := cipher.EncryptEnvelopeBody([]byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("encrypting envelope: %v", err)
	}

	data := []byte(envelope.Data)
	data[0] ^= 0x01
	envelope.Data = string(data)

	if _, err := cipher.OpenEnvelope(envelope); err == nil {
		t.Fatal("tampered envelope accepted")
	}
}

func TestEnvelopeRejectsStaleTimestamp(t *testing.T) {
	cipher := testCipher(t)
	stale := time.Now().Add(-2 * MaxAge * time.Second).Unix()

	envelope, err := cipher.encryptEnvelopeBody([]byte(`{"a":1}`), stale)
	if err != nil {
		t.Fatalf("encrypting envelope: %v", err)
	}
	if _, err := cipher.OpenEnvelope(envelope); err == nil {
		t.Fatal("stale envelope accepted")
	}
}

func TestEnvelopeRejectsForeignKey(t *testing.T) {
	sender := testCipher(t)
	receiver := testCipher(t)

	envelope, err := sender.EncryptEnvelopeBody([]byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("encrypting envelope: %v", err)
	}
	if _, err := receiver.OpenEnvelope(envelope); err == nil {
		t.Fatal("envelope from another key pair accepted")
	}
}

// 信封是给整段请求体用的：审计等后续中间件必须看到还原后的 JSON。
func TestUnwrapEnvelopeBodyMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("AEROLINK_TRANSPORT_KEY_PATH", filepath.Join(t.TempDir(), "transport-key.pem"))

	router := gin.New()
	router.Use(UnwrapEnvelopeBody())

	var seenBody map[string]any
	router.POST("/echo", func(c *gin.Context) {
		var payload map[string]any
		if err := json.NewDecoder(c.Request.Body).Decode(&payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		seenBody = payload
		c.Status(http.StatusNoContent)
	})

	body := []byte(`{"username":"alice","password":"p@ss"}`)
	envelope, err := Default().EncryptEnvelopeBody(body)
	if err != nil {
		t.Fatalf("encrypting envelope: %v", err)
	}
	wrapped, err := json.Marshal(map[string]any{"enc": envelope})
	if err != nil {
		t.Fatalf("marshaling envelope: %v", err)
	}

	wantBody := map[string]any{"username": "alice", "password": "p@ss"}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/echo", bytes.NewReader(wrapped))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d: %s", w.Code, http.StatusNoContent, w.Body.String())
	}
	if !reflect.DeepEqual(seenBody, wantBody) {
		t.Fatalf("handler saw %v, want %v", seenBody, wantBody)
	}

	// 明文请求保持兼容：未升级的工具链与滚动升级期间的旧页面照常可用。
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/echo", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("plaintext status = %d, want %d", w.Code, http.StatusNoContent)
	}
	if !reflect.DeepEqual(seenBody, wantBody) {
		t.Fatalf("plaintext handler saw %v, want %v", seenBody, wantBody)
	}

	// 解不开的信封必须硬失败，不能悄悄当明文继续走。
	broken := bytes.Replace(wrapped, []byte(`"data":"`), []byte(`"data":"A`), 1)
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/echo", bytes.NewReader(broken))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest || !bytes.Contains(w.Body.Bytes(), []byte(CodePayloadInvalid)) {
		t.Fatalf("broken envelope status/body = %d/%s, want 400 with %s", w.Code, w.Body.String(), CodePayloadInvalid)
	}
}
