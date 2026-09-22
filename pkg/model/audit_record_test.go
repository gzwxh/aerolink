package model

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// setupAuditRecordTestDB 准备一个内存库，并在用例结束后还原全局 DB 与 sink。
//
// AuditSink 是全局变量，用例必须自己恢复——否则一个用例把它设成 parquet，后面的用例会
// 莫名其妙地"不落库"。
func setupAuditRecordTestDB(t *testing.T) {
	t.Helper()

	originalDB := DB
	originalSink := AuditSink

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&ResourceHistory{}, &LoginRecord{}, &PasswordChangeLog{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}

	DB = db
	t.Cleanup(func() {
		DB = originalDB
		AuditSink = originalSink
	})
}

// sink 取值必须严格：配错了要报错，而不是静默按 database 跑（那会让人以为配置生效了）。
func TestNormalizeAuditSink(t *testing.T) {
	for _, value := range []string{"", "database", "DATABASE", " parquet ", "elasticsearch", "Elasticsearch"} {
		if _, err := NormalizeAuditSink(value); err != nil {
			t.Errorf("NormalizeAuditSink(%q) error = %v", value, err)
		}
	}
	for _, value := range []string{"minio", "parquet2", "es", "file", "kafka"} {
		if _, err := NormalizeAuditSink(value); err == nil {
			t.Errorf("NormalizeAuditSink(%q) 应报错（未知取值不能静默回落）", value)
		}
	}
}

// 默认 sink：走数据库，主键由数据库分配（改造前行为）。
func TestRecordAuditWritesToDatabaseByDefault(t *testing.T) {
	setupAuditRecordTestDB(t)
	AuditSink = AuditSinkDatabase

	record := &ResourceHistory{ResourceType: "pods", ResourceName: "web", OperationType: "delete", Success: true}
	if err := RecordAudit(context.Background(), record); err != nil {
		t.Fatalf("RecordAudit() error = %v", err)
	}
	if record.ID == 0 {
		t.Error("落库时应由数据库分配自增主键")
	}

	var count int64
	DB.Model(&ResourceHistory{}).Count(&count)
	if count != 1 {
		t.Errorf("落库行数 = %d, want 1", count)
	}
}

// 不落库：记录不进数据库，但必须被转发出去，且标识与时间要自己补齐。
func TestRecordAuditSkipsDatabaseWhenSinkIsParquet(t *testing.T) {
	setupAuditRecordTestDB(t)
	AuditSink = AuditSinkParquet

	// AddAuditForwarder 是追加注册且没有注销接口：这里只统计自己这个闭包收到的消息，
	// 其它用例注册的回调不影响断言。
	var received []AuditMessage
	AddAuditForwarder(func(message AuditMessage) { received = append(received, message) })

	record := &ResourceHistory{ResourceType: "pods", ResourceName: "web", OperationType: "delete", Success: true}
	if err := RecordAudit(context.Background(), record); err != nil {
		t.Fatalf("RecordAudit() error = %v", err)
	}

	var count int64
	DB.Model(&ResourceHistory{}).Count(&count)
	if count != 0 {
		t.Errorf("sink=parquet 时不应写库, 落库行数 = %d", count)
	}

	if record.ID == 0 {
		t.Error("不落库时必须自行合成记录标识（parquet / ES 都要用它做幂等键）")
	}
	if record.CreatedAt.IsZero() {
		t.Error("不落库时必须补齐创建时间，否则归档里的时间是 1970 年")
	}

	found := false
	for _, message := range received {
		if message.Kind == AuditKindOperation && message.ResourceName == "web" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("审计消息必须被转发到 sink 通道, got %+v", received)
	}
}

// 登录记录走同一套 sink 逻辑。
func TestRecordLoginRespectsSink(t *testing.T) {
	setupAuditRecordTestDB(t)

	AuditSink = AuditSinkDatabase
	isNewIP, err := RecordLogin(1, "alice", "password", "10.0.0.1", "curl/8")
	if err != nil {
		t.Fatalf("RecordLogin() error = %v", err)
	}
	// 首次登录（库表里没有历史）不算异地。
	if isNewIP {
		t.Error("首次登录不该被判定为新 IP")
	}
	var count int64
	DB.Model(&LoginRecord{}).Count(&count)
	if count != 1 {
		t.Fatalf("落库行数 = %d, want 1", count)
	}

	AuditSink = AuditSinkParquet
	if _, err := RecordLogin(1, "alice", "password", "10.0.0.2", "curl/8"); err != nil {
		t.Fatalf("RecordLogin() error = %v", err)
	}
	DB.Model(&LoginRecord{}).Count(&count)
	if count != 1 {
		t.Errorf("sink=parquet 时不该再写库, 落库行数 = %d, want 1", count)
	}
}

// 合成的标识必须单调递增且不重复（否则 ES 的幂等覆盖会张冠李戴）。
func TestNextSyntheticAuditIDIsMonotonicAndUnique(t *testing.T) {
	const count = 2000
	seen := make(map[uint]bool, count)
	var last uint

	for i := 0; i < count; i++ {
		id := nextSyntheticAuditID()
		if id <= last {
			t.Fatalf("标识应单调递增: %d <= %d", id, last)
		}
		if seen[id] {
			t.Fatalf("标识重复: %d", id)
		}
		seen[id] = true
		last = id
	}
}

// 合成标识的位布局：时间戳在最高位（新旧归档文件能一起排序），实例标识与毫秒内序号在低 16 位。
func TestSyntheticAuditIDLayout(t *testing.T) {
	ms := uint(time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC).UnixMilli())
	id := syntheticAuditID(ms, 7, 3)

	if got := id >> auditIDMsShift; got != ms {
		t.Errorf("时间戳应能从 id 里还原: got %d, want %d", got, ms)
	}
	if got := (id >> auditIDSeqBits) & auditIDTagMask; got != 7 {
		t.Errorf("实例标识 = %d, want 7", got)
	}
	if got := id & auditIDSeqMask; got != 3 {
		t.Errorf("毫秒内序号 = %d, want 3", got)
	}

	// 同一毫秒、同一序号、不同实例（= 不同副本）必须得到不同的 id，这正是多副本下不能共用
	// 一个「毫秒 + 毫秒内自增」的原因。
	if other := syntheticAuditID(ms, 8, 3); other == id {
		t.Error("不同实例在同一毫秒里应得到不同的 id，否则多副本会互相覆盖（ES 文档/parquet 主键）")
	}
}

// 实例标识：同一身份恒定、落在 [1, 1023]（0 留给旧布局的序号区间），且不同身份要能散开。
func TestAuditInstanceTag(t *testing.T) {
	tag := auditInstanceTagFor("aerolink-7d9f8b6c4-x2k4p", 1)
	if tag < 1 || tag > auditIDTagMask {
		t.Fatalf("auditInstanceTagFor() = %d, want within [1, %d]", tag, auditIDTagMask)
	}
	if again := auditInstanceTagFor("aerolink-7d9f8b6c4-x2k4p", 1); again != tag {
		t.Errorf("同一身份的实例标识必须恒定: %d != %d", again, tag)
	}

	// 不同 Pod / 同 Pod 的不同进程（多容器）要散到不同标识上。是否撞号取决于散列，无法断言到
	// 每一对；这里验证的是分布没有退化（散列恒定的实现会在这里失败）。
	seen := make(map[uint]bool, 1000)
	for i := 0; i < 5000; i++ {
		seen[auditInstanceTagFor(fmt.Sprintf("aerolink-7d9f8b6c4-pod%d", i), 1)] = true
	}
	if len(seen) < 900 {
		t.Errorf("5000 个不同身份只散出 %d 个实例标识，散列退化了", len(seen))
	}
}

// parquet 作为唯一存储时，攒批间隔就是「刚发生的操作查不到」的窗口，超过 5 分钟必须拒绝。
func TestParquetSinkRejectsTooLongFlushInterval(t *testing.T) {
	originalSink := AuditSink
	t.Cleanup(func() { AuditSink = originalSink })

	data := DefaultAuditSettingData()
	data.Archive.Flush.IntervalSeconds = MaxParquetQueryDelaySeconds + 1

	AuditSink = AuditSinkDatabase
	if err := data.Normalize(); err != nil {
		t.Errorf("sink=database 时不该限制攒批间隔: %v", err)
	}

	AuditSink = AuditSinkParquet
	if err := data.Normalize(); err == nil {
		t.Error("sink=parquet 时超过 5 分钟的攒批间隔必须被拒绝")
	}

	data.Archive.Flush.IntervalSeconds = MaxParquetQueryDelaySeconds
	if err := data.Normalize(); err != nil {
		t.Errorf("正好 5 分钟应放行: %v", err)
	}

	// 0 表示"用默认值"（120 秒），不受上限约束。
	data.Archive.Flush.IntervalSeconds = 0
	if err := data.Normalize(); err != nil {
		t.Errorf("0（用默认值）应放行: %v", err)
	}
}
