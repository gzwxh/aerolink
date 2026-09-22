package model

import (
	"testing"

	"github.com/zxh326/kite/pkg/utils"
)

func TestUserKey(t *testing.T) {
	tests := []struct {
		name     string
		user     User
		expected string
	}{
		{"username", User{Model: Model{ID: 1}, Username: "alice", Name: "Alice", Sub: "sub"}, "alice"},
		{"name", User{Model: Model{ID: 2}, Name: "Alice", Sub: "sub"}, "Alice"},
		{"sub", User{Model: Model{ID: 3}, Sub: "sub"}, "sub"},
		{"id", User{Model: Model{ID: 4}}, "4"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.user.Key(); got != tt.expected {
				t.Fatalf("Key() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestUserGetAPIKey(t *testing.T) {
	user := User{
		Model:  Model{ID: 42},
		APIKey: SecretString("secret"),
	}

	if got, want := user.GetAPIKey(), "aerolink42-secret"; got != want {
		t.Fatalf("GetAPIKey() = %q, want %q", got, want)
	}
}

// API key 的前缀改了名，但已签发的 key 仍是 `kite<id>-<secret>`，必须继续认：
// 不认旧前缀等于把所有存量 key 当场作废（集群 Agent、脚本、CI 都在用）。
func TestAPIKeyTokenAcceptsLegacyPrefix(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
		ok     bool
	}{
		{name: "current prefix", header: "aerolink42-secret", want: "42-secret", ok: true},
		{name: "legacy prefix", header: "kite42-secret", want: "42-secret", ok: true},
		{name: "no prefix", header: "42-secret", ok: false},
		{name: "unknown prefix", header: "other42-secret", ok: false},
		{name: "empty", header: "", ok: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := APIKeyToken(tc.header)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("APIKeyToken(%q) = %q, %v; want %q, %v", tc.header, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestCheckPassword(t *testing.T) {
	hash, err := utils.HashPassword("secret")
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if !CheckPassword(hash, "secret") {
		t.Fatal("CheckPassword() returned false for matching password")
	}
	if CheckPassword(hash, "wrong") {
		t.Fatal("CheckPassword() returned true for non-matching password")
	}
}
