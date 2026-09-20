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
			mysqlDSN := withMySQLDSNDefaults(strings.TrimPrefix(dsn, "mysql://"))
			DB, err = gorm.Open(mysql.Open(mysqlDSN), cfg)
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
	models := []interface{}{
		User{},
		Cluster{},
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
	}
	for _, model := range models {
		err = DB.AutoMigrate(model)
		if err != nil {
			panic("failed to migrate database: " + err.Error())
		}
	}
	if err := MigrateBindingGroupMemberNamespace(); err != nil {
		panic("failed to migrate binding group member index: " + err.Error())
	}
	if err := MigrateDropUserWechatColumn(); err != nil {
		panic("failed to drop the legacy user wechat column: " + err.Error())
	}
	sqldb, err := DB.DB()
	if err == nil {
		sqldb.SetMaxOpenConns(common.DBMaxOpenConns)
		sqldb.SetMaxIdleConns(common.DBMaxIdleConns)
		sqldb.SetConnMaxLifetime(common.DBConnMaxLifetime)
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
