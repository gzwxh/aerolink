package model

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 登录日志同时记录成功与失败（等保三级安全审计）：成功登录的 Result 为空，
// 失败尝试写入原因码，且账号不存在时也要能落库（UserID 为 0）。
func TestLoginRecordOutcomes(t *testing.T) {
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&LoginRecord{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = previousDB })

	// IP 与 SourceIP 分开落库：公网出口与内网原始来源同时保留。
	if _, err := RecordLogin(7, "alice", AuthProviderPassword, "203.0.113.7", "10.1.2.100", "agent"); err != nil {
		t.Fatalf("recording a successful login: %v", err)
	}
	if err := RecordLoginFailure("mallory", AuthProviderPassword, "203.0.113.9", "203.0.113.9", "agent", LoginResultInvalidCredentials); err != nil {
		t.Fatalf("recording a failed login: %v", err)
	}
	// 空原因码没有意义，退回到通用失败码而不是伪装成成功登录。
	if err := RecordLoginFailure("mallory", AuthProviderPassword, "203.0.113.9", "203.0.113.9", "agent", LoginResultSuccess); err != nil {
		t.Fatalf("recording a failed login without a reason: %v", err)
	}
	if err := RecordLoginFailure("carol", AuthProviderLDAP, "203.0.113.9", "203.0.113.9", "agent", LoginResultNotProvisioned); err != nil {
		t.Fatalf("recording a directory login failure: %v", err)
	}

	var rows []LoginRecord
	if err := DB.Order("id").Find(&rows).Error; err != nil {
		t.Fatalf("loading login records: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("expected 4 login records, got %d", len(rows))
	}

	signedIn := rows[0]
	if signedIn.Result != LoginResultSuccess {
		t.Fatalf("successful login result = %q, want empty", signedIn.Result)
	}
	if signedIn.UserID != 7 {
		t.Fatalf("successful login userId = %d, want 7", signedIn.UserID)
	}
	if signedIn.IP != "203.0.113.7" || signedIn.SourceIP != "10.1.2.100" {
		t.Fatalf("ip/sourceIp = %q/%q, want 203.0.113.7/10.1.2.100", signedIn.IP, signedIn.SourceIP)
	}

	for i, row := range rows[1:] {
		if row.Result == LoginResultSuccess {
			t.Fatalf("row %d must not look like a successful login", i+1)
		}
		if row.UserID != 0 {
			t.Fatalf("row %d userId = %d, want 0 for an unauthenticated attempt", i+1, row.UserID)
		}
	}
	if rows[1].Result != LoginResultInvalidCredentials || rows[2].Result != LoginResultInvalidCredentials {
		t.Fatalf("unexpected failure reasons: %q, %q", rows[1].Result, rows[2].Result)
	}
}
