package model

import (
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/utils"
	"gorm.io/gorm"
)

func openEncryptionTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open test database: %v", err)
	}
	if err := db.AutoMigrate(&GeneralSetting{}, &Cluster{}); err != nil {
		t.Fatalf("failed to migrate test database: %v", err)
	}
	previousDB := DB
	DB = db
	t.Cleanup(func() { DB = previousDB })
	return db
}

func TestEnsureEncryptionKeyMigratesFromDefaultKey(t *testing.T) {
	db := openEncryptionTestDB(t)
	previousKey := common.KiteEncryptKey
	t.Cleanup(func() { common.KiteEncryptKey = previousKey })

	// Data written while the built-in key was in use.
	common.KiteEncryptKey = common.DefaultKiteEncryptKey
	if err := db.Create(&GeneralSetting{Model: Model{ID: 1}}).Error; err != nil {
		t.Fatalf("failed to create general setting: %v", err)
	}
	if err := db.Exec("UPDATE general_settings SET encrypt_key_fingerprint = ? WHERE id = 1",
		encryptionKeyFingerprint(common.DefaultKiteEncryptKey)).Error; err != nil {
		t.Fatalf("failed to seed fingerprint: %v", err)
	}
	cluster := Cluster{Name: "c1", Config: SecretString("kubeconfig-payload")}
	if err := db.Create(&cluster).Error; err != nil {
		t.Fatalf("failed to create cluster: %v", err)
	}

	// The operator configures a real key: the stored secret must be rewritten.
	common.KiteEncryptKey = "production-key-0123456789"
	EnsureEncryptionKey()

	var raw string
	if err := db.Raw("SELECT config FROM clusters WHERE id = ?", cluster.ID).Scan(&raw).Error; err != nil {
		t.Fatalf("failed to read raw config: %v", err)
	}
	plain, err := utils.DecryptStringWithKey("production-key-0123456789", raw)
	if err != nil {
		t.Fatalf("stored secret was not re-encrypted with the new key: %v", err)
	}
	if plain != "kubeconfig-payload" {
		t.Fatalf("migrated secret = %q, want %q", plain, "kubeconfig-payload")
	}

	fingerprint, err := storedEncryptionKeyFingerprint()
	if err != nil {
		t.Fatalf("failed to read fingerprint: %v", err)
	}
	if fingerprint != encryptionKeyFingerprint("production-key-0123456789") {
		t.Fatalf("fingerprint = %q, want the new key fingerprint", fingerprint)
	}

	// A second start with the same key must be a no-op.
	EnsureEncryptionKey()
	if err := db.Raw("SELECT config FROM clusters WHERE id = ?", cluster.ID).Scan(&raw).Error; err != nil {
		t.Fatalf("failed to read raw config again: %v", err)
	}
	if plain, err := utils.DecryptStringWithKey("production-key-0123456789", raw); err != nil || plain != "kubeconfig-payload" {
		t.Fatalf("idempotent run broke the secret: %q, %v", plain, err)
	}
}

func TestEnsureEncryptionKeyKeepsUnknownRotationIntact(t *testing.T) {
	db := openEncryptionTestDB(t)
	previousKey := common.KiteEncryptKey
	t.Cleanup(func() { common.KiteEncryptKey = previousKey })

	// Secrets were encrypted with some key that is neither the current nor the
	// built-in default one.
	common.KiteEncryptKey = "some-other-key"
	if err := db.Create(&GeneralSetting{Model: Model{ID: 1}}).Error; err != nil {
		t.Fatalf("failed to create general setting: %v", err)
	}
	if err := db.Exec("UPDATE general_settings SET encrypt_key_fingerprint = ? WHERE id = 1",
		encryptionKeyFingerprint("some-other-key")).Error; err != nil {
		t.Fatalf("failed to seed fingerprint: %v", err)
	}
	encrypted, err := utils.EncryptStringWithKey("some-other-key", "kubeconfig-payload")
	if err != nil {
		t.Fatalf("failed to prepare ciphertext: %v", err)
	}
	cluster := Cluster{Name: "c1", Config: SecretString("placeholder")}
	if err := db.Create(&cluster).Error; err != nil {
		t.Fatalf("failed to create cluster: %v", err)
	}
	if err := db.Exec("UPDATE clusters SET config = ? WHERE id = ?", encrypted, cluster.ID).Error; err != nil {
		t.Fatalf("failed to seed ciphertext: %v", err)
	}

	common.KiteEncryptKey = "yet-another-key"
	EnsureEncryptionKey()

	// Nothing may be rewritten: the data is left untouched so the operator can
	// restore the correct key.
	var raw string
	if err := db.Raw("SELECT config FROM clusters WHERE id = ?", cluster.ID).Scan(&raw).Error; err != nil {
		t.Fatalf("failed to read raw config: %v", err)
	}
	if raw != encrypted {
		t.Fatal("a mismatched key must not rewrite stored ciphertext")
	}
	if plain, err := utils.DecryptStringWithKey("some-other-key", raw); err != nil || plain != "kubeconfig-payload" {
		t.Fatalf("original data must stay readable with its own key: %q, %v", plain, err)
	}
}
