package model

import (
	"os"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/utils"
	"gorm.io/driver/postgres"
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

	// 在内置密钥生效期间写入的数据。
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

	// 运维配置了真正的密钥：已存的密钥必须被重写。
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

	// 用同一个密钥第二次启动必须是空操作。
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

	// 密钥是用某个既不是当前密钥、也不是内置默认密钥的密钥加密的。
	//
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

	// 不允许重写任何内容：数据保持原样，以便运维恢复正确的密钥。
	//
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

// openMissingTableDB 返回一个「一张表都没建」的空库，用来验证「表还不存在时也要能启动」。
//
// 默认用进程内 sqlite；设置 KITE_TEST_PG_DSN 时改用真实 PostgreSQL：
//
//	KITE_TEST_PG_DSN='host=127.0.0.1 user=kite password=... dbname=kite_empty port=5433 sslmode=disable TimeZone=Asia/Shanghai' \
//	    go test ./pkg/model -run MissingTable -v
//
// 这个开关不是可有可无的：下面这段容忍逻辑原先靠匹配驱动的错误文本来判断「表不存在」，
// 而 sqlite 说 "no such table"、PostgreSQL 说 `relation "x" does not exist`——只跑 sqlite
// 的 CI 永远发现不了这类写法，必须在真 PG 上跑一次才能验证。
func openMissingTableDB(t *testing.T) *gorm.DB {
	t.Helper()

	var dialector gorm.Dialector
	if dsn := strings.TrimSpace(os.Getenv("KITE_TEST_PG_DSN")); dsn != "" {
		dialector = postgres.Open(dsn)
	} else {
		dialector = sqlite.Open("file:" + t.Name() + "?mode=memory&cache=shared")
	}
	db, err := gorm.Open(dialector, &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open test database: %v", err)
	}
	if db.Migrator().HasTable("general_settings") {
		t.Fatalf("这个用例需要空库，但 general_settings 已存在（%s）：%s",
			db.Dialector.Name(), "KITE_TEST_PG_DSN 请指向一个从未做过 AutoMigrate 的库")
	}

	previousDB := DB
	DB = db
	t.Cleanup(func() { DB = previousDB })
	return db
}

func TestEncryptionKeyToleratesMissingTables(t *testing.T) {
	db := openMissingTableDB(t)

	// 指纹所在的那一行还没建出来：按「尚未记录」处理，不能报错，否则全新安装起不来。
	fingerprint, err := storedEncryptionKeyFingerprint()
	if err != nil {
		t.Fatalf("storedEncryptionKeyFingerprint() on a database without tables: %v", err)
	}
	if fingerprint != "" {
		t.Fatalf("fingerprint = %q, want empty", fingerprint)
	}

	// 从未用过的功能表不存在时，密钥迁移要跳过它们并正常提交，而不是整体失败——
	// 否则「换 KITE_ENCRYPT_KEY」在 PostgreSQL 上会直接失败。
	migrated, err := migrateEncryptedColumns("old-key", "new-key")
	if err != nil {
		t.Fatalf("migrateEncryptedColumns() on a database without tables: %v", err)
	}
	if migrated != 0 {
		t.Fatalf("migrated = %d, want 0", migrated)
	}

	// 探测过程不能在空库上留下任何东西。
	if db.Migrator().HasTable("general_settings") {
		t.Fatal("probing must not create tables")
	}
}
