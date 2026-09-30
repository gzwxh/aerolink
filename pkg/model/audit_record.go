package model

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
)

// —— 审计日志的落地方式（sink）——
//
// 五种方式**互斥**，由配置文件在启动时指定（管理页面只读、仅可查看）：
//
//	database      → 只写数据库（默认，行为与改造前完全一致）
//	parquet       → 不写数据库，直接落 parquet 文件（可叠加 S3 远端副本）
//	elasticsearch → 不写数据库，直接写 Elasticsearch
//	victorialogs  → 不写数据库，直接写 VictoriaLogs
//	openobserve   → 不写数据库，直接写 OpenObserve
//
// 为什么互斥而不是共存：允许共存就会出现「库里有、parquet 有、ES 也有一份」——三处都不全，
// 而哪一份是权威取决于看的人，审计场景里这正是要避免的。
//
// 为什么"不落库"是可选而不是默认：写库 + 归档本质是两份存储，量大的部署希望只留一份。
// 代价要提前说清——parquet/ES/VL/OO 都没有"自增主键"与"实时可查"这两件事，所以：
//   - 记录标识改由本进程合成（见 nextSyntheticAuditID）；
//   - 查询实时性下降，parquet 尤其明显（攒批落盘），因此强制延迟上限
//     MaxParquetQueryDelaySeconds = 5 分钟，界面也会明示。
const (
	// AuditSinkDatabase 只写数据库。
	AuditSinkDatabase = "database"
	// AuditSinkParquet 只写本地 parquet（S3 是它的可选远端副本）。
	AuditSinkParquet = "parquet"
	// AuditSinkElasticsearch 只写 Elasticsearch。
	AuditSinkElasticsearch = "elasticsearch"
	// AuditSinkVictoriaLogs 只写 VictoriaLogs（VictoriaMetrics 体系里的日志存储，**不是**
	// VictoriaMetrics 本身：后者是时序库，存不下审计记录的字段明细，见 plans/2026-09-21-新增审计落地方式.md §2）。
	AuditSinkVictoriaLogs = "victorialogs"
	// AuditSinkOpenObserve 只写 OpenObserve。
	AuditSinkOpenObserve = "openobserve"
)

// MaxParquetQueryDelaySeconds 是 parquet 模式下审计查询容忍的最大延迟（秒）。
//
// parquet 是攒批落盘的，检索只能看到"已经落盘"的数据，这个间隔就是「刚发生的操作查不到」
// 的窗口。上限 5 分钟是产品约束：再长的话审计的排查价值会被显著削弱。
const MaxParquetQueryDelaySeconds = 300

// ErrInvalidAuditSink 是 sink 取值非法时的错误。
var ErrInvalidAuditSink = errors.New("audit sink must be one of database, parquet, elasticsearch, victorialogs, openobserve")

// AuditSink 是当前生效的落地方式。启动时由配置文件设置，运行期不变。
//
// 空值与未知值都按 database 处理：那不改变任何既有行为，是最安全的默认（存量部署升级后
// 行为零变化）。配置文件里写错值时由 NormalizeAuditSink 直接报错，不会被静默兜住。
var AuditSink = AuditSinkDatabase

// NormalizeAuditSink 校验并归一 sink 取值。
//
// 刻意**不做静默回落**：配错了（比如写成 minio、parquet2）必须让部署者立刻知道，
// 而不是悄悄按 database 跑起来——那会让人以为配置生效了。
func NormalizeAuditSink(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", AuditSinkDatabase:
		return AuditSinkDatabase, nil
	case AuditSinkParquet:
		return AuditSinkParquet, nil
	case AuditSinkElasticsearch:
		return AuditSinkElasticsearch, nil
	case AuditSinkVictoriaLogs:
		return AuditSinkVictoriaLogs, nil
	case AuditSinkOpenObserve:
		return AuditSinkOpenObserve, nil
	default:
		return "", ErrInvalidAuditSink
	}
}

// AuditSinkUsesDatabase 报告审计记录是否需要落库。
func AuditSinkUsesDatabase() bool {
	return AuditSink == "" || AuditSink == AuditSinkDatabase
}

// AuditSinkUsesParquet 报告当前 sink 是否把记录落在本地 parquet 文件（可叠加 S3 远端副本）。
func AuditSinkUsesParquet() bool {
	return AuditSink == AuditSinkParquet
}

// AuditSinkUsesElasticsearch 报告当前 sink 是否把记录落在 Elasticsearch。
func AuditSinkUsesElasticsearch() bool {
	return AuditSink == AuditSinkElasticsearch
}

// AuditSinkUsesVictoriaLogs 报告当前 sink 是否把记录落在 VictoriaLogs。
func AuditSinkUsesVictoriaLogs() bool {
	return AuditSink == AuditSinkVictoriaLogs
}

// AuditSinkUsesOpenObserve 报告当前 sink 是否把记录落在 OpenObserve。
func AuditSinkUsesOpenObserve() bool {
	return AuditSink == AuditSinkOpenObserve
}

// AuditSinkUsesExternalLogs 报告当前 sink 是否「不落库、写外部日志存储」
// （ES / VictoriaLogs / OpenObserve 三者共用同一套写入与检索链路）。
func AuditSinkUsesExternalLogs() bool {
	return AuditSinkUsesElasticsearch() || AuditSinkUsesVictoriaLogs() || AuditSinkUsesOpenObserve()
}

// AuditSinkRetentionIsServerSide 报告当前 sink 的过期清理是否由**存储端**负责。
//
// VictoriaLogs 与 OpenObserve 都没有「删除过期数据」的客户端接口：保留由服务端配置决定
// （VL 的 -retentionPeriod、OO 的 stream data_retention）。也就是说
// audit_settings.retentionDays 对这两个 sink **不生效**——这个事实必须能传到界面，
// 否则又是一个「配了没生效」的静默失效（见 plans/2026-09-21-新增审计落地方式.md §3.4）。
func AuditSinkRetentionIsServerSide() bool {
	return AuditSinkUsesVictoriaLogs() || AuditSinkUsesOpenObserve()
}

// —— 合成记录标识的位布局 ——
//
//	[41 位毫秒时间戳][10 位实例标识][6 位毫秒内序号]
//
// 时间戳仍在最高位，与旧的「毫秒 << 16 | 毫秒内自增」同一量级：单进程内 id 单调递增，
// 按 id 排序等价于按时间排序，新旧归档文件能放在一起比较。改的只是低 16 位的用法。
//
// 低 16 位为什么再切一刀：只用「毫秒 + 毫秒内自增」时，多副本部署的每个副本都是独立进程、
// 序号都从 1 开始，同一毫秒里写出的记录会**直接撞号**——撞号意味着 ES 文档互相覆盖、
// parquet 里出现重复主键。先切出 10 位放实例标识，两边才互不干扰。
const (
	// auditIDSeqBits 是毫秒内序号的位数：1 毫秒 64 条。审计记录是人工操作触发的，到不了
	// 这个量级；真到了就等到下一毫秒再分配（见 nextSyntheticAuditID），不会回绕撞号。
	auditIDSeqBits = 6
	// auditIDTagBits 是实例标识的位数：1023 个取值（不是 2 的幂，0 不用）。
	auditIDTagBits = 10
	// auditIDMsShift 是毫秒时间戳在 id 里的起始位：低 16 位留给实例标识与序号。
	auditIDMsShift = auditIDSeqBits + auditIDTagBits
	auditIDSeqMask = 1<<auditIDSeqBits - 1
	auditIDTagMask = 1<<auditIDTagBits - 1
)

// auditInstanceTag 是本进程在 id 里的实例标识：同一进程恒定，不同进程极大概率不同。
//
// 用「主机名 + 进程号」散列而来，而不是某个需要协调的实例编号：取号一旦依赖数据库或 K8s API，
// 就等于在审计写入路径上新增一个失败点——宁可留下一个极小概率的撞号，也不能因为取不到号
// 而写不出审计记录。
//
// 取值落在 [1, 1023]：不用 0，旧布局下低 6 位是毫秒内序号，滚动升级期间新旧副本可能同时在跑，
// 错开这一段能让混跑时的撞号概率再低一个量级。
var auditInstanceTag = auditInstanceTagFor(hostnameForAuditID(), os.Getpid())

// auditInstanceTagFor 由实例身份（主机名 + 进程号）算出实例标识。抽成纯函数便于直接验证。
func auditInstanceTagFor(host string, pid int) uint {
	sum := fnv.New32a()
	_, _ = fmt.Fprintf(sum, "%s:%d", host, pid)
	// 取模而不是位与：1023 不是 2 的幂，位与会把取值空间砍掉一半。
	return uint(sum.Sum32())%auditIDTagMask + 1
}

// hostnameForAuditID 取主机名；取不到时回落一个固定值（同机多进程仍靠进程号区分）。
func hostnameForAuditID() string {
	if host, err := os.Hostname(); err == nil && host != "" {
		return host
	}
	return "unknown"
}

// syntheticAuditID 按位布局拼装一个合成标识（抽出来便于直接验证布局本身）。
func syntheticAuditID(ms uint, tag, seq uint) uint {
	return ms<<auditIDMsShift | (tag&auditIDTagMask)<<auditIDSeqBits | seq&auditIDSeqMask
}

var (
	// auditIDMu 保护下面两个字段：合成标识只在写审计记录时调用（每条记录一次），
	// 锁开销相对于写库/写文件可以忽略，但能保证「同一毫秒内不重复」的推理是简单的。
	auditIDMu   sync.Mutex
	auditIDLast uint // 最近一次分配用的毫秒时间戳
	auditIDSeq  uint // 该毫秒内已分配的序号（0 表示还没分配）
)

// nextSyntheticAuditID 为「不落库」的审计记录合成一个数值标识。
//
// 为什么仍是数值而不是 UUID：parquet 的 id 列与 ES 的文档标识都按 uint64 设计，改成字符串是
// **破坏性 schema 变更**——新旧文件在同一查询里 id 列类型不一致会直接报错。
//
// 保证：单进程内单调递增且不重复；不同进程靠实例标识区分（见 auditInstanceTag），
// 同一毫秒内撞号需要两个副本的实例标识相同（约 1/1023）。
func nextSyntheticAuditID() uint {
	auditIDMu.Lock()
	defer auditIDMu.Unlock()

	// 时钟回拨时沿用上一毫秒：宁可 id 上记的时间略微偏前，也不能因为回拨而让两条记录撞号。
	if now := uint(time.Now().UnixMilli()); now > auditIDLast {
		auditIDLast = now
		auditIDSeq = 0
	}

	if auditIDSeq == auditIDSeqMask {
		// 本毫秒内的序号用尽（见 auditIDSeqBits）：等下一毫秒，而不是回绕——回绕会让两条记录
		// 拿到同一个 id，正是这里要避免的事。
		for auditIDSeq == auditIDSeqMask {
			time.Sleep(50 * time.Microsecond)
			if now := uint(time.Now().UnixMilli()); now > auditIDLast {
				auditIDLast = now
				auditIDSeq = 0
			}
		}
	}

	auditIDSeq++
	return syntheticAuditID(auditIDLast, auditInstanceTag, auditIDSeq)
}

// dbWithContext 返回带请求上下文的会话（ctx 为空时用默认会话）。
//
// 带上下文不是为了事务，而是为了让 GORM 钩子能从 Statement.Context 里取到 request_id，
// 把这条审计记录与同一次请求的访问日志、报错日志串起来。
func dbWithContext(ctx context.Context) *gorm.DB {
	if ctx == nil {
		return DB
	}
	return DB.WithContext(ctx)
}

// RecordAudit 是操作审计记录的统一写入口：按当前 sink 决定落库还是直接外发/归档。
//
// 所有产生审计记录的地方都应该走它而不是直接 `DB.Create`——直接 Create 会绕过 sink 选择，
// 在 sink=parquet/es 时把记录写进了本该被跳过的数据库。
//
// sink=database：正常写库，GORM 的 AfterCreate 钩子随后把它交给外发/归档通道（等价改造前）。
// 其它 sink：**不写库**，直接构造消息分发；记录标识与创建时间在这里补齐（数据库不会再填）。
func RecordAudit(ctx context.Context, record *ResourceHistory) error {
	if AuditSinkUsesDatabase() {
		return dbWithContext(ctx).Create(record).Error
	}

	record.CreatedAt = createdAtOrNow(record.CreatedAt)
	if record.ID == 0 {
		record.ID = nextSyntheticAuditID()
	}
	message := operationAuditMessage(record)
	message.RequestID = requestIDFromContext(ctx)
	forwardAuditMessage(message)
	return nil
}

// saveLoginRecord 按当前 sink 落地一条登录记录（成功与失败都走这里）。
func saveLoginRecord(ctx context.Context, record *LoginRecord) error {
	if AuditSinkUsesDatabase() {
		return dbWithContext(ctx).Create(record).Error
	}

	record.CreatedAt = createdAtOrNow(record.CreatedAt)
	if record.ID == 0 {
		record.ID = nextSyntheticAuditID()
	}
	message := loginAuditMessage(record)
	message.RequestID = requestIDFromContext(ctx)
	forwardAuditMessage(message)
	return nil
}

// savePasswordChangeRecord 按当前 sink 落地一条改密记录。
func savePasswordChangeRecord(ctx context.Context, record *PasswordChangeLog) error {
	if AuditSinkUsesDatabase() {
		return dbWithContext(ctx).Create(record).Error
	}

	record.CreatedAt = createdAtOrNow(record.CreatedAt)
	if record.ID == 0 {
		record.ID = nextSyntheticAuditID()
	}
	message := passwordChangeAuditMessage(record)
	message.RequestID = requestIDFromContext(ctx)
	forwardAuditMessage(message)
	return nil
}

// requestIDFromContext 取请求关联 ID，容忍 nil 上下文。
//
// 非请求路径上也会产生审计记录（启动期的清理留痕、后台任务），它们没有请求上下文；
// 那里传 nil 比传 context.Background() 更能表达"确实没有"。
func requestIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	return RequestIDFromContext(ctx)
}

// createdAtOrNow 在创建时间缺失时补上当前时间。
//
// 落库时 GORM 会自己填 CreatedAt，但"不落库"这条路径没有 GORM 参与，不补齐的话
// parquet 里的 created_at / ts 会是 0（1970 年），检索按时间排序会全部乱掉。
func createdAtOrNow(value time.Time) time.Time {
	if value.IsZero() {
		return time.Now()
	}
	return value
}
