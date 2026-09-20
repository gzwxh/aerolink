package common

import (
	"strings"
	"testing"
)

// 只覆盖 TimeZone 这一项：它漏了不报错，只让时间静默偏移，所以必须由启动日志提醒。
func TestPostgresDSNTimeZoneWarning(t *testing.T) {
	cases := []struct {
		name   string
		dbType string
		dsn    string
		want   bool // 是否应当告警
	}{
		{
			name:   "关键字式没写 TimeZone",
			dbType: "postgres",
			dsn:    "host=127.0.0.1 user=kite password=pw dbname=kite port=5432 sslmode=disable",
			want:   true,
		},
		{
			name:   "关键字式写了 TimeZone",
			dbType: "postgres",
			dsn:    "host=127.0.0.1 user=kite password=pw dbname=kite port=5432 sslmode=disable TimeZone=Asia/Shanghai",
		},
		{
			name:   "关键字式大小写不敏感",
			dbType: "postgres",
			dsn:    "host=127.0.0.1 user=kite dbname=kite timezone=asia/shanghai",
		},
		{
			name:   "URL 式没写",
			dbType: "postgres",
			dsn:    "postgres://kite:pw@10.0.0.5:5432/kite?sslmode=disable",
			want:   true,
		},
		{
			name:   "URL 式写了 TimeZone",
			dbType: "postgres",
			dsn:    "postgres://kite:pw@10.0.0.5:5432/kite?sslmode=disable&TimeZone=Asia%2FShanghai",
		},
		{
			name:   "URL 式走 options",
			dbType: "postgres",
			dsn:    "postgres://kite:pw@10.0.0.5:5432/kite?sslmode=disable&options=-c%20timezone%3DAsia%2FShanghai",
		},
		{
			name:   "空 DSN",
			dbType: "postgres",
			dsn:    "",
			want:   true,
		},
		{
			name:   "密码里出现 timezone= 不算数",
			dbType: "postgres",
			dsn:    "host=127.0.0.1 user=kite password=timezone=xxx dbname=kite",
			want:   true,
		},
		{
			name:   "sqlite 不检查",
			dbType: "sqlite",
			dsn:    "dev.db",
		},
		{
			name:   "mysql 不检查",
			dbType: "mysql",
			dsn:    "kite:pw@tcp(10.0.0.5:3306)/kite",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := postgresDSNTimeZoneWarning(c.dbType, c.dsn)
			if c.want && got == "" {
				t.Fatalf("期望给出告警，实际没有：dbType=%q dsn=%q", c.dbType, c.dsn)
			}
			if !c.want && got != "" {
				t.Fatalf("不该告警却给了：%q（dbType=%q dsn=%q）", got, c.dbType, c.dsn)
			}
			if c.want && !strings.Contains(got, "TimeZone") {
				t.Fatalf("告警文案里要写清缺的是 TimeZone，实际：%q", got)
			}
		})
	}
}
