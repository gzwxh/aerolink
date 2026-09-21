package main

import (
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/utils"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const testEncryptKey = "dbmigrate-test-key-0123456789abcdef"

// useTestEncryptKey 把加解密密钥固定成可预期的值，并负责还原。
func useTestEncryptKey(t *testing.T) {
	t.Helper()
	previous := common.KiteEncryptKey
	common.KiteEncryptKey = testEncryptKey
	t.Cleanup(func() { common.KiteEncryptKey = previous })
}

// newTestDB 建一个空的 sqlite 库、迁出全部模型。
//
// 外键在 DSN 上打开，而不是用 PRAGMA 语句：PRAGMA 只作用于执行它的那一条连接，
// 而连接池随后随时可能新建一条连接（新连接上约束又关掉了），测试会时灵时不灵。
func newTestDB(t *testing.T, name string) *gorm.DB {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), name) + "?_pragma=foreign_keys(1)"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatalf("open %s: %v", name, err)
	}
	if err := db.AutoMigrate(model.Models()...); err != nil {
		t.Fatalf("migrate %s: %v", name, err)
	}
	return db
}

// requireForeignKeyEnforcement 确认外键约束真的在生效。下面的清表顺序反证完全依赖它：
// 约束没生效时那个「应该失败」的调用会静默成功，用例会给出误导性的结论。
func requireForeignKeyEnforcement(t *testing.T, db *gorm.DB) {
	t.Helper()
	insert := "INSERT INTO role_assignments (role_id, subject_type, subject) VALUES (999999, 'user', 'ghost')"
	if err := db.Exec(insert).Error; err == nil {
		t.Fatal("foreign keys are not enforced; the ordering assertions would be meaningless")
	}
}

func mustCreate(t *testing.T, db *gorm.DB, value interface{}) {
	t.Helper()
	if err := db.Create(value).Error; err != nil {
		t.Fatalf("seed %T: %v", value, err)
	}
}

// seedSource 造出一小份有代表性的源数据：加密列（SecretString）、带外键依赖的
// 表（角色/绑定组/审计记录），以及两类会外发审计的写入。
func seedSource(t *testing.T, db *gorm.DB) *model.User {
	t.Helper()

	user := &model.User{
		Username:  "alice",
		Password:  "bcrypt-hash",
		APIKey:    model.SecretString("api-key-plaintext"),
		MFASecret: model.SecretString("mfa-secret-plaintext"),
	}
	mustCreate(t, db, user)

	mustCreate(t, db, &model.Cluster{
		Name:                   "cluster-a",
		Config:                 model.SecretString("apiVersion: v1\nkind: Config"),
		ClusterAgentPrivateKey: model.SecretString("private-key-plaintext"),
	})

	role := &model.Role{Name: "viewer"}
	mustCreate(t, db, role)
	mustCreate(t, db, &model.RoleAssignment{
		RoleID:      role.ID,
		SubjectType: model.SubjectTypeUser,
		Subject:     "alice",
	})

	group := &model.BindingGroup{Cluster: "cluster-a", Name: "team-a"}
	mustCreate(t, db, group)
	mustCreate(t, db, &model.BindingGroupNamespace{
		ProjectID: group.ID,
		Cluster:   "cluster-a",
		Namespace: "default",
	})
	// role_id 上有外键约束：这条记录让「先删 roles、后删成员」必然失败，
	// 从而使清表顺序在测试里真的被校验。
	mustCreate(t, db, &model.BindingGroupMember{
		ProjectID:   group.ID,
		SubjectType: model.SubjectTypeUser,
		Subject:     "alice",
		RoleID:      role.ID,
	})

	mustCreate(t, db, &model.ResourceHistory{
		ClusterName:     "cluster-a",
		ResourceType:    "pods",
		ResourceName:    "web-0",
		OperationType:   "delete",
		OperationSource: "manual",
		OperatorID:      model.OperatorRef(user.ID),
		OperatorName:    "alice",
		ResourceYAML:    "kind: Pod",
	})
	mustCreate(t, db, &model.LoginRecord{
		UserID:   user.ID,
		Username: "alice",
		Provider: "password",
		IP:       "10.0.0.1",
	})
	return user
}

// copyAll 走一遍 run() 里那串对已连上的两个库的操作（不含建目标库结构与最终报告）。
// 只跑 sqlite 目标：序列修正（fixSequences）只对 PostgreSQL 有意义，无法在这里覆盖，
// 已在真实 PostgreSQL 18 上实测过。
func copyAll(t *testing.T, source, target *gorm.DB, batchSize int) []*table {
	t.Helper()
	tables, err := readSource(source)
	if err != nil {
		t.Fatalf("readSource: %v", err)
	}
	if err := clearTarget(target, dbTypeSQLite, tables); err != nil {
		t.Fatalf("clearTarget: %v", err)
	}
	if err := writeTarget(target, tables, batchSize); err != nil {
		t.Fatalf("writeTarget: %v", err)
	}
	return tables
}

func TestCopyAllCopiesEveryRow(t *testing.T) {
	useTestEncryptKey(t)
	source := newTestDB(t, "source.db")
	user := seedSource(t, source)
	target := newTestDB(t, "target.db")

	tables := copyAll(t, source, target, 2)

	for _, tb := range tables {
		var got int64
		if err := target.Table(tb.name).Count(&got).Error; err != nil {
			t.Fatalf("count %s: %v", tb.name, err)
		}
		if int(got) != tb.count {
			t.Errorf("table %s: target has %d rows, source has %d", tb.name, got, tb.count)
		}
	}
	if total := len(tables); total != len(model.Models()) {
		t.Errorf("copied %d tables, want %d", total, len(model.Models()))
	}

	var gotUser model.User
	if err := target.First(&gotUser, user.ID).Error; err != nil {
		t.Fatalf("read the copied user: %v", err)
	}
	if string(gotUser.APIKey) != "api-key-plaintext" {
		t.Errorf("api_key = %q, want %q", gotUser.APIKey, "api-key-plaintext")
	}
	if string(gotUser.MFASecret) != "mfa-secret-plaintext" {
		t.Errorf("mfa_secret = %q, want %q", gotUser.MFASecret, "mfa-secret-plaintext")
	}

	var gotCluster model.Cluster
	if err := target.Where("name = ?", "cluster-a").First(&gotCluster).Error; err != nil {
		t.Fatalf("read the copied cluster: %v", err)
	}
	if string(gotCluster.Config) != "apiVersion: v1\nkind: Config" {
		t.Errorf("cluster config did not survive the round trip: %q", gotCluster.Config)
	}

	var gotHistory model.ResourceHistory
	if err := target.First(&gotHistory).Error; err != nil {
		t.Fatalf("read the copied resource history: %v", err)
	}
	if gotHistory.OperatorID == nil || *gotHistory.OperatorID != user.ID {
		t.Errorf("operator_id = %v, want %d", gotHistory.OperatorID, user.ID)
	}
}

// 反证：密文必须是用目标库的密钥重新加密过的新密文，而不是把源库的字节原样搬过去。
// 否则「换库 + 换 KITE_ENCRYPT_KEY」这条路走不通，且搬运会掩盖密钥不匹配的问题。
func TestCopyAllReencryptsSecrets(t *testing.T) {
	useTestEncryptKey(t)
	source := newTestDB(t, "source.db")
	user := seedSource(t, source)
	target := newTestDB(t, "target.db")

	copyAll(t, source, target, 100)

	read := func(db *gorm.DB) string {
		var cipher string
		if err := db.Raw("SELECT api_key FROM users WHERE id = ?", user.ID).Scan(&cipher).Error; err != nil {
			t.Fatalf("read the stored ciphertext: %v", err)
		}
		return cipher
	}
	sourceCipher, targetCipher := read(source), read(target)
	if sourceCipher == "" || targetCipher == "" {
		t.Fatal("expected both databases to hold a non-empty ciphertext")
	}
	if sourceCipher == targetCipher {
		t.Error("the ciphertext was copied verbatim; the target should hold a fresh ciphertext")
	}
	plaintext, err := utils.DecryptStringWithKey(testEncryptKey, targetCipher)
	if err != nil {
		t.Fatalf("the copied ciphertext does not decrypt with the migration key: %v", err)
	}
	if plaintext != "api-key-plaintext" {
		t.Errorf("decrypted api_key = %q, want %q", plaintext, "api-key-plaintext")
	}
}

// 反证：搬运历史审计记录不能触发 ResourceHistory / LoginRecord 的外发钩子
// （否则会把上千条历史事件当成新事件推到外部 syslog）。
func TestCopyAllDoesNotFireAuditHooks(t *testing.T) {
	useTestEncryptKey(t)
	source := newTestDB(t, "source.db")
	seedSource(t, source)
	target := newTestDB(t, "target.db")

	// 外发回调是「追加注册」的（AddAuditForwarder），没有注销接口：这里只关心自己这个闭包
	// 被调用了多少次，所以不需要清理，也不会被其它测试注册的回调影响。
	var forwarded atomic.Int64
	model.AddAuditForwarder(func(model.AuditMessage) { forwarded.Add(1) })

	copyAll(t, source, target, 100)
	if got := forwarded.Load(); got != 0 {
		t.Errorf("the migration forwarded %d audit messages, want 0", got)
	}

	// 证明这个断言不是空转：同样的写入直接落库时钩子是会响的。
	mustCreate(t, source, &model.LoginRecord{Username: "bob", IP: "10.0.0.2"})
	if got := forwarded.Load(); got != 1 {
		t.Errorf("a direct insert forwarded %d audit messages, want 1", got)
	}
}

// 反证：密钥与源库不一致时必须在动目标库之前失败，而不是搬一堆解不开的密文过去。
func TestReadSourceFailsWithTheWrongEncryptKey(t *testing.T) {
	useTestEncryptKey(t)
	source := newTestDB(t, "source.db")
	seedSource(t, source)

	common.KiteEncryptKey = "another-key-that-never-encrypted-this-data"
	_, err := readSource(source)
	if err == nil {
		t.Fatal("expected readSource to fail with a mismatched encryption key")
	}
	if !strings.Contains(err.Error(), "KITE_ENCRYPT_KEY") {
		t.Errorf("the error should point at the encryption key, got: %v", err)
	}
}

// 反证：把「父表在前」的顺序直接交给 clearTarget（它按传入顺序倒着删，于是真的变成
// 父表先删），外键约束必须拒绝；传模型顺序才对。这条用例保证 model.Models() 的顺序
// 不是「随便排的」。
func TestClearTargetRequiresChildTablesFirst(t *testing.T) {
	useTestEncryptKey(t)
	source := newTestDB(t, "source.db")
	seedSource(t, source)
	target := newTestDB(t, "target.db")
	requireForeignKeyEnforcement(t, target)
	tables := copyAll(t, source, target, 100)

	parentFirst := slices.Clone(tables)
	slices.Reverse(parentFirst)
	if err := clearTarget(target, dbTypeSQLite, parentFirst); err == nil {
		t.Error("expected the foreign key constraint to reject clearing parent tables first")
	}

	if err := clearTarget(target, dbTypeSQLite, tables); err != nil {
		t.Errorf("clearTarget with the model order: %v", err)
	}
}

func TestValidateRejectsDangerousOrIncompleteOptions(t *testing.T) {
	cases := []struct {
		name string
		opts options
	}{
		{"missing target dsn", options{sourceType: dbTypeSQLite, sourceDSN: "dev.db", targetType: dbTypePostgres, batchSize: 100}},
		{"unknown target type", options{sourceType: dbTypeSQLite, sourceDSN: "dev.db", targetType: "oracle", targetDSN: "x", batchSize: 100}},
		{"unknown source type", options{sourceType: "oracle", sourceDSN: "x", targetType: dbTypeSQLite, targetDSN: "y", batchSize: 100}},
		{"non-positive batch size", options{sourceType: dbTypeSQLite, sourceDSN: "dev.db", targetType: dbTypePostgres, targetDSN: "host=db", batchSize: 0}},
		{
			"same sqlite file written differently",
			options{sourceType: dbTypeSQLite, sourceDSN: "dev.db", targetType: dbTypeSQLite, targetDSN: "./dev.db", batchSize: 100},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validate(&tc.opts); err == nil {
				t.Errorf("validate(%+v) = nil, want an error", tc.opts)
			}
		})
	}

	ok := options{sourceType: dbTypeSQLite, sourceDSN: "dev.db", targetType: dbTypePostgres, targetDSN: "host=db", batchSize: 100}
	if err := validate(&ok); err != nil {
		t.Errorf("validate(%+v) = %v, want nil", ok, err)
	}
}

func TestMaskDSNHidesPasswords(t *testing.T) {
	postgres := maskDSN(dbTypePostgres, "host=127.0.0.1 user=kite password=supersecret dbname=kite port=5432")
	if strings.Contains(postgres, "supersecret") {
		t.Errorf("postgres DSN still contains the password: %s", postgres)
	}
	mysqlDSN := maskDSN(dbTypeMySQL, "kite:supersecret@tcp(127.0.0.1:3306)/kite")
	if strings.Contains(mysqlDSN, "supersecret") {
		t.Errorf("mysql DSN still contains the password: %s", mysqlDSN)
	}
	if sqliteDSN := maskDSN(dbTypeSQLite, "dev.db"); sqliteDSN != "dev.db" {
		t.Errorf("sqlite DSN = %q, want it unchanged", sqliteDSN)
	}
}
