package model

import (
	"github.com/zxh326/kite/pkg/common"
	"gorm.io/gorm/clause"
)

// 这个文件集中放「跨库行为必须一致」的 SQL 片段构造器：集中一处，免得各调用点自己拼字符串
// 时漏掉某个方言。规则与踩过的坑见 docs/dev/cross-database-compatibility.md。

// caseInsensitiveLike 给出「不区分大小写」的包含匹配运算符。
//
// PostgreSQL 的 LIKE 区分大小写，而 MySQL（默认 *_ci 排序规则）与 SQLite 的 LIKE 不区分——
// 同一份数据在 PG 上会因为大小写不同搜不到。审计归档检索（pkg/audit/archive_condition.go
// 的 opContains）本来就用 ILIKE，这里让数据库路径与归档路径保持一致，否则「同一份审计记录
// 查得到还是查不到」会取决于它落在库里还是 parquet/ES 里。
func caseInsensitiveLike() string {
	if common.DBType == "postgres" {
		return "ILIKE"
	}
	return "LIKE"
}

// PatternLikeSQL 返回「列名 + 不区分大小写包含匹配」的 SQL 片段，配合 ? 占位符使用。
//
// column 必须是代码里写死的列名（含 users. 这类限定前缀），不能来自外部输入；需要按方言
// 给列名加引号时用 PatternLike。
func PatternLikeSQL(column string) string {
	return column + " " + caseInsensitiveLike() + " ?"
}

// PatternLike 与 PatternLikeSQL 等价，但返回 clause 表达式：列名会按方言加引号，
// 因此列名是保留字（例如历史库上 users 的组列叫 groups）或来自运行时探测时用它。
func PatternLike(column clause.Column, pattern string) clause.Expression {
	if common.DBType != "postgres" {
		return clause.Like{Column: column, Value: pattern}
	}
	return clause.Expr{
		SQL:                "? ILIKE ?",
		Vars:               []interface{}{column, pattern},
		WithoutParentheses: true,
	}
}

// supportsRowLock 报告当前方言是否支持 SELECT ... FOR UPDATE。
//
// SQLite 不支持该子句，但它也没有并发写——整库写锁本身已保证串行，需要互斥的
// 读改写（如公告的启用路径与启动归一化）在 SQLite 上按方言跳过锁定子句即可。
func supportsRowLock() bool {
	return common.DBType != "sqlite"
}
