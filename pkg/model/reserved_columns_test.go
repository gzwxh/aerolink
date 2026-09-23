package model

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// sqlCollector 只记录执行过的 SQL，供「生成的语句有没有给保留字列名加引号」的断言使用。
type sqlCollector struct {
	queries []string
}

func (c *sqlCollector) LogMode(logger.LogLevel) logger.Interface     { return c }
func (c *sqlCollector) Info(context.Context, string, ...interface{}) {}
func (c *sqlCollector) Warn(context.Context, string, ...interface{}) {}
func (c *sqlCollector) Error(context.Context, string, ...interface{}) {
}
func (c *sqlCollector) Trace(_ context.Context, _ time.Time, fc func() (string, int64), _ error) {
	sql, _ := fc()
	c.queries = append(c.queries, sql)
}

func (c *sqlCollector) reset() { c.queries = nil }

func (c *sqlCollector) last() string {
	if len(c.queries) == 0 {
		return ""
	}
	return c.queries[len(c.queries)-1]
}

// quoted 匹配「列名被引号包裹」：本项目用的 sqlite driver 与 MySQL 一样用反引号，
// PostgreSQL 用双引号，所以断言不写死某一种引号字符。
func quoted(column string) *regexp.Regexp {
	return regexp.MustCompile("[`\"]" + column + "[`\"]")
}

// key 与 read 都是 MySQL 的保留字：在原始 SQL 条件里裸写它们，MySQL 8 直接 1064 语法错误，
// 而 SQLite / PostgreSQL 把它们当普通标识符、照常通过——所以这类缺陷在本地（PG/SQLite）
// 联调时看不见，线上表现为「未读站内信接口 500」「锁定 IP 列表返回 items=null 把前端打崩」。
// 用例断言的是生成语句里列名被引号包裹（见 login_attempt.go / notification.go 的类型注释）。
func TestReservedColumnNamesAreQuotedInQueries(t *testing.T) {
	collector := &sqlCollector{}
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: collector,
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&Notification{}, &LoginAttempt{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	previous := DB
	DB = db
	t.Cleanup(func() { DB = previous })

	t.Run("notifications.read", func(t *testing.T) {
		collector.reset()
		if _, err := CountUnreadNotifications(1); err != nil {
			t.Fatalf("CountUnreadNotifications() error = %v", err)
		}
		if sql := collector.last(); !quoted("read").MatchString(sql) {
			t.Fatalf("生成的语句没有给保留字列 read 加引号（MySQL 下会 1064）：%s", sql)
		}
	})

	t.Run("login_attempts.key", func(t *testing.T) {
		collector.reset()
		if _, err := ListLoginAttempts("ip:", time.Now()); err != nil {
			t.Fatalf("ListLoginAttempts() error = %v", err)
		}
		if sql := collector.last(); !quoted("key").MatchString(sql) {
			t.Fatalf("生成的语句没有给保留字列 key 加引号（MySQL 下会 1064）：%s", sql)
		}
	})
}
