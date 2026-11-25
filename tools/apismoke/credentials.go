package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"aerolink/pkg/transportkey"
)

// login 用口令登录。服务端开启 AEROLINK_REQUIRE_ENCRYPTED_CREDENTIALS 后会拒收
// 明文口令（400 encrypted_credential_required），此时按 GET /api/v1/transport-key
// 下发的公钥加密口令重试一次——冒烟脚本是用来验证部署的，不该因为这条安全开关中断。
func (r *runner) login() (int, []byte, error) {
	status, raw, err := r.client.request("POST", "/api/auth/login/password", map[string]string{
		"username": r.opts.username,
		"password": r.opts.password,
	})
	if err != nil || !bytes.Contains(raw, []byte(transportkey.CodeCredentialRequired)) {
		return status, raw, err
	}

	encrypted, encErr := r.encryptPassword()
	if encErr != nil {
		return status, raw, fmt.Errorf("服务端要求密文凭据，但取公钥/加密失败：%w", encErr)
	}
	fmt.Fprintln(os.Stderr, "服务端要求密文凭据（AEROLINK_REQUIRE_ENCRYPTED_CREDENTIALS），改用密文重试登录")
	return r.client.request("POST", "/api/auth/login/password", map[string]string{
		"username":     r.opts.username,
		"password_enc": encrypted,
	})
}

// encryptPassword 取服务端公钥，把口令打成短字段密文（协议见 pkg/transportkey）。
func (r *runner) encryptPassword() (string, error) {
	status, raw, err := r.client.request("GET", "/api/v1/transport-key", nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("GET /api/v1/transport-key status=%d %s", status, truncate(string(raw), 200))
	}
	var key transportkey.PublicKey
	if err := json.Unmarshal(raw, &key); err != nil {
		return "", fmt.Errorf("解析公钥响应: %w", err)
	}
	pub, err := transportkey.ParsePublicKey(key.PublicKey)
	if err != nil {
		return "", fmt.Errorf("解析公钥: %w", err)
	}
	return transportkey.EncryptFieldsWithPublicKey(pub, map[string]string{"password": r.opts.password})
}
