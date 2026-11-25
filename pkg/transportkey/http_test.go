package transportkey

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/common"
)

// 强制模式只收紧「明文凭据」这一个判定：密文、字段整体缺省、开关关闭都必须照旧。
func TestResolveCredentialEnforcement(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("AEROLINK_TRANSPORT_KEY_PATH", filepath.Join(t.TempDir(), "transport-key.pem"))
	// 开关是包级全局，用例结束复原，避免污染同包其它用例。
	t.Cleanup(func() { common.RequireEncryptedCredentials = false })

	router := gin.New()
	router.POST("/credential", func(c *gin.Context) {
		var req struct {
			Password    string `json:"password"`
			PasswordEnc string `json:"password_enc"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if !ResolveCredential(c, req.PasswordEnc, &req.Password) {
			return
		}
		c.JSON(http.StatusOK, gin.H{"password": req.Password})
	})

	post := func(t *testing.T, body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshaling body: %v", err)
		}
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/credential", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(w, req)
		return w
	}

	// 开关关闭时明文照旧可用：滚动升级期间未升级的客户端不能被打断。
	common.RequireEncryptedCredentials = false
	if w := post(t, map[string]any{"password": "p@ss"}); w.Code != http.StatusOK {
		t.Fatalf("plaintext with the switch off = %d, want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	// 开关打开后，明文凭据硬失败，且错误码要能让前端分辨「被拒」与「解不开」。
	common.RequireEncryptedCredentials = true
	w := post(t, map[string]any{"password": "p@ss"})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), CodeCredentialRequired) {
		t.Fatalf("plaintext with the switch on = %d/%s, want 400 with %s", w.Code, w.Body.String(), CodeCredentialRequired)
	}

	// 密文不受影响，解出来的仍是原值。
	encrypted, err := Default().EncryptFields(map[string]string{"password": "p@ss-中文"})
	if err != nil {
		t.Fatalf("encrypting: %v", err)
	}
	w = post(t, map[string]any{"password_enc": encrypted})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "p@ss-中文") {
		t.Fatalf("encrypted credential = %d/%s, want 200 with the decrypted password", w.Code, w.Body.String())
	}

	// 字段整体缺省不拦：留给 handler 报「必填」，而不是报「必须加密」。
	if w := post(t, map[string]any{}); w.Code != http.StatusOK {
		t.Fatalf("omitted credential = %d, want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	// 解不开的密文仍是解密失败，不能被误报成「必须加密」。
	w = post(t, map[string]any{"password_enc": "not-a-token"})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), CodeDecryptFailed) {
		t.Fatalf("broken ciphertext = %d/%s, want 400 with %s", w.Code, w.Body.String(), CodeDecryptFailed)
	}
}
