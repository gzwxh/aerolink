package model

import (
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"k8s.io/klog/v2"
)

var (
	DB *gorm.DB

	once sync.Once
)

type Model struct {
	ID        uint      `json:"id" gorm:"primarykey"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// BeforeSave 在「按主键更新」且 CreatedAt 仍为零值时，把 created_at 从更新列里排除。
//
// 为什么需要它：Save 会更新全部字段（GORM 会把 Statement.Selects 置为 "*"），零值时间被
// go-sql-driver 渲染成 '0000-00-00 00:00:00'；MySQL 严格模式（5.7/8.0 默认带 NO_ZERO_DATE +
// STRICT_TRANS_TABLES）直接报 Error 1292，而 SQLite / PostgreSQL 照单全收——所以这类写法
// 只在 MySQL 上炸。单行设置类模型（security_settings / audit_settings）用
// `SecuritySetting{Model: Model{ID: 1}}` + Save 写回整行，正好踩在这里。
//
// 首次插入（ID 为零）不受影响：GORM 照常把 CreatedAt 填成当前时间。
func (m *Model) BeforeSave(tx *gorm.DB) error {
	if m.ID != 0 && m.CreatedAt.IsZero() {
		tx.Statement.Omit("created_at")
	}
	return nil
}

// InitDB 建表并迁移到最新结构。
//
// sqlite / mysql / postgres 共用这一份模型，写 SQL 前先看
// docs/dev/cross-database-compatibility.md：列名不拼字符串、不写零值时间、
// 「都能跑」也不等于「结果一样」（LIKE 大小写、NULL 排序）。
func InitDB() {
	dsn := common.DBDSN
	level := logger.Silent
	if klog.V(10).Enabled() {
		level = logger.Info
	}
	newLogger := logger.New(
		log.New(os.Stdout, "\r\n", log.LstdFlags), // io writer
		logger.Config{
			SlowThreshold: time.Second,
			LogLevel:      level,
			Colorful:      false,
		},
	)

	var err error
	once.Do(func() {
		cfg := &gorm.Config{
			Logger: newLogger,
		}
		if common.DBType == "sqlite" {
			DB, err = gorm.Open(sqlite.Open(dsn), cfg)
			if err != nil {
				panic("failed to connect database: " + err.Error())
			}
		}

		if common.DBType == "mysql" {
			DB, err = gorm.Open(mysql.Open(MySQLDSN(dsn)), cfg)
			if err != nil {
				panic("failed to connect database: " + err.Error())
			}
		}

		if common.DBType == "postgres" {
			DB, err = gorm.Open(postgres.Open(dsn), cfg)
			if err != nil {
				panic("failed to connect database: " + err.Error())
			}
		}
	})

	if DB == nil {
		panic("database connection is nil, check your DB_TYPE and DB_DSN settings")
	}

	// SQLite 必须显式开启外键约束。
	// SQLite 在表结构里定义了外键约束，但除非在连接上设置
	// PRAGMA foreign_keys = ON，否则不会真正生效。
	if common.DBType == "sqlite" {
		if err := DB.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
			panic("failed to enable sqlite foreign keys: " + err.Error())
		}
	}
	// 公告的 Scroll 列要在主循环之前补：加列与「判断这列是不是刚加的」必须紧邻，
	// 主循环跑完就分不清了（见 MigrateAnnouncementScrollBackfill 的注释）。
	// 下面几步都可能碰到需要 DDL 权限的变更（AutoMigrate 加列/改列、DropColumn）。
	// 失败只告警、不中断启动：生产库的表多由 DBA 创建，应用账号往往只有 DML 权限，
	// 不该因为一次「加列被拒」让整个控制台起不来（见 runMigration 的说明）。
	// 结构完全交给 DBA 托管时可设 DB_MIGRATE=off：应用不再尝试任何 DDL，
	// 也不会每次启动都刷一条「加列失败」，代价是失去这层自查（见 migrateDisabled）。
	if migrateDisabled() {
		klog.Info("DB_MIGRATE=off：跳过自动迁移与回填，库结构按外部流程维护")
	}
	runMigration("公告 scroll 列回填", MigrateAnnouncementScrollBackfill)
	// ScrollMode 同理，且**必须排在 Scroll 之后**：它的回填要读已经补好的 scroll 列。
	runMigration("公告 scrollMode 列回填", MigrateAnnouncementScrollModeBackfill)
	for _, model := range Models() {
		current := model
		runMigration("表结构自动迁移", func() error { return DB.AutoMigrate(current) })
	}
	runMigration("绑定组成员命名空间索引", MigrateBindingGroupMemberNamespace)
	runMigration("清理 users.wechat 旧列", MigrateDropUserWechatColumn)

	// 不论是否跳过迁移，都用只读方式确认关键列在不在（不需要 DDL 权限）。
	// 这样设了 DB_MIGRATE=off 也不会漏掉「忘了执行 DBA 的 SQL」。
	checkSchema()
	sqldb, err := DB.DB()
	if err == nil {
		sqldb.SetMaxOpenConns(common.DBMaxOpenConns)
		sqldb.SetMaxIdleConns(common.DBMaxIdleConns)
		sqldb.SetConnMaxLifetime(common.DBConnMaxLifetime)
	}
}

// runMigration 执行一步数据库变更，失败只告警、不阻断启动。
//
// 为什么不 fail-fast：生产环境的库通常由 DBA 建表，应用的数据库账号只有 DML 权限，
// 而 AutoMigrate 加列/改列需要 DDL 权限（PostgreSQL 还要求是**表 owner**，否则报
// 42501 must be owner of table）。一次「加列被拒」就把整个控制台拖垮，比
// 「结构未就绪、少数接口报错」严重得多。错误文案里会带上该步需要执行的 SQL，
// 运维据此交给 DBA 补齐即可。
//
// 需要「迁移失败即启动失败」时（本地开发、CI）设 DB_MIGRATE_STRICT=true。
func runMigration(name string, fn func() error) {
	if migrateDisabled() {
		return
	}
	if err := fn(); err != nil {
		if dbMigrateStrict() {
			panic("failed to migrate database (" + name + "): " + err.Error())
		}
		klog.Errorf("数据库变更未完成（%s）：%v", name, err)
		klog.Errorf("  该步骤需要 DDL 权限（表 owner）。请让 DBA 用 owner 账号执行上面的变更后重启；" +
			"补齐之前，依赖该结构的接口可能报错，其余功能不受影响。")
	}
}

// dbMigrateStrict 报告是否要求「迁移失败即启动失败」，默认否。
func dbMigrateStrict() bool {
	return strings.EqualFold(strings.TrimSpace(common.Getenv("DB_MIGRATE_STRICT")), "true")
}

// migrateDisabled 报告是否完全跳过自动迁移（DB_MIGRATE=off）。
//
// 库结构由 DBA 统一维护时用它：应用账号只有 DML 权限，AutoMigrate 每次启动都会因为
// 「不是表 owner」失败并留下一条错误日志，跳过更干净。代价是失去这层自查——漏执行
// 结构变更时不再有日志提醒，需要靠 checkSchema 兜住（所以默认不跳过）。
func migrateDisabled() bool {
	return strings.EqualFold(strings.TrimSpace(common.Getenv("DB_MIGRATE")), "off")
}

// checkSchema 用**只读**方式把「模型定义」与库里的实际结构比一遍，缺表/缺列逐条打印。
//
// 为什么需要它：结构由 DBA 托管（DB_MIGRATE=off，或应用账号没有 DDL 权限）时，
// 漏执行一次结构变更的后果是「某个功能报 500」，日志里只剩一个数据库错误码，
// 得从接口反推表结构才知道缺什么（实际踩过：clusters.confirm_create 缺失）。
// 启动时一次性列清楚，运维照着补 SQL 就行。
//
// 全部走只读查询（information_schema 一类），不需要 DDL 权限，所以 DB_MIGRATE=off 时照跑。
func checkSchema() {
	missing := 0
	for _, model := range Models() {
		stmt := &gorm.Statement{DB: DB}
		if err := stmt.Parse(model); err != nil || stmt.Schema == nil {
			continue
		}
		if !DB.Migrator().HasTable(model) {
			klog.Errorf("库结构缺少表 %s：相关功能会报错，请让 DBA 建表", stmt.Schema.Table)
			missing++
			continue
		}
		columns, err := DB.Migrator().ColumnTypes(model)
		if err != nil {
			continue
		}
		existing := make(map[string]struct{}, len(columns))
		for _, column := range columns {
			existing[column.Name()] = struct{}{}
		}
		for _, field := range stmt.Schema.Fields {
			if field.DBName == "" {
				continue
			}
			if _, ok := existing[field.DBName]; ok {
				continue
			}
			klog.Errorf("库表 %s 缺少列 %s：依赖它的接口会报错，请让 DBA 补上",
				stmt.Schema.Table, field.DBName)
			missing++
		}
	}
	if missing == 0 {
		klog.Info("库结构与模型一致")
		return
	}
	klog.Errorf("共发现 %d 处库结构差异（见上方清单）——补齐后重启即可；服务当前仍可启动", missing)
}

// Models 是全部需要建表与迁移的模型。顺序满足外键依赖：被引用的表在前
// （roles 在 role_assignments 之前、binding_groups 在它的两个子表之前），
// 因此也可以直接当作整库搬运的插入顺序；搬运工具按相反顺序清表。
func Models() []interface{} {
	return []interface{}{
		User{},
		// 头像字节单独成表（见 user_avatar.go）：users 行是高频整行读取，不能混进 blob。
		UserAvatar{},
		Cluster{},
		// 集群徽章图标的字节同样单独成表（见 cluster_badge_icon.go）。
		ClusterBadgeIcon{},
		GeneralSetting{},
		SecuritySetting{},
		AuditSetting{},
		PasswordHistory{},
		PasswordChangeLog{},
		LDAPSetting{},
		OAuthProvider{},
		Role{},
		RoleAssignment{},
		BindingGroup{},
		BindingGroupNamespace{},
		BindingGroupMember{},
		LocalGroup{},
		GroupMember{},
		ResourceHistory{},
		ResourceTemplate{},
		PendingSession{},
		MFAPendingTicket{},
		UserSession{},
		LoginAttempt{},
		HelmRepository{},
		ScheduledTask{},
		NotificationSetting{},
		NotificationTemplate{},
		NotificationSubscription{},
		Notification{},
		LoginRecord{},
		// 顶栏通知栏公告（管理员发布，见 plans/2026-09-21-顶部通知栏.md）。
		Announcement{},
		// 周期性全局任务的执行权租约（多副本选主，见 leader.go）。
		LeaderLease{},
	}
}

// mysqlDSNDefaults 是必须显式钉住的驱动参数：驱动默认 loc=UTC，而应用写入的是本地
// 时间（time.Now()），不钉住就会出现「写进去一个时间、查出来另一个时间」。
//
// loc 要与 MySQL 会话的 time_zone 是同一个值（服务端 time_zone 保持与本机时区一致，
// 或统一为 UTC）；两者不一致时 TIMESTAMP 列会被二次换算。另外，改动 loc 会改变
// DATETIME 列的读写口径，已有数据需要一并处理，不能上线后再改。
//
// 不设置 readTimeout / writeTimeout：它们是单条语句的超时，首次建表加索引、大表
// 迁移都可能超过 30s，一刀切会把这些正常语句掐断。
var mysqlDSNDefaults = [][2]string{
	{"charset", "utf8mb4"},
	{"parseTime", "true"},
	{"loc", "Local"},
	{"timeout", "5s"},
}

// MySQLDSN 把 MySQL DSN 规整成驱动需要的形式（去掉 scheme 前缀并补齐
// mysqlDSNDefaults）。整库搬运工具也用它，避免两处口径不一致导致时间列读错。
func MySQLDSN(dsn string) string {
	return withMySQLDSNDefaults(strings.TrimPrefix(dsn, "mysql://"))
}

// withMySQLDSNDefaults 给 DSN 里缺失的驱动参数补上默认值，操作者自己写明的同名
// 参数优先。参数段从最后一个 '/' 之后的第一个 '?' 开始，与驱动自身的解析口径一致，
// 这样密码里出现 '?' 也不会被当成参数分隔符。
func withMySQLDSNDefaults(dsn string) string {
	head, query := dsn, ""
	if slash := strings.LastIndex(dsn, "/"); slash >= 0 {
		if q := strings.Index(dsn[slash+1:], "?"); q >= 0 {
			head, query = dsn[:slash+1+q], dsn[slash+1+q+1:]
		}
	}

	present := make(map[string]bool)
	for _, part := range strings.Split(query, "&") {
		if key, _, ok := strings.Cut(part, "="); ok {
			present[key] = true
		}
	}
	added := make([]string, 0, len(mysqlDSNDefaults))
	for _, kv := range mysqlDSNDefaults {
		if !present[kv[0]] {
			added = append(added, kv[0]+"="+kv[1])
		}
	}
	if len(added) == 0 {
		return dsn
	}
	if query == "" {
		return head + "?" + strings.Join(added, "&")
	}
	return head + "?" + query + "&" + strings.Join(added, "&")
}
