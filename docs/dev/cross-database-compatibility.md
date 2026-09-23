# 跨数据库兼容性规则（SQLite / MySQL / PostgreSQL）

鸢联 AeroLink 同一份代码要跑在 SQLite（默认）、MySQL（5.7 / 8.x）、PostgreSQL（12+）上。
三种库的 SQL 方言与**语义**都有差异，其中一部分差异在开发机上（默认 SQLite）永远暴露不出来，
只会在换成 MySQL 或 PG 之后以「某个接口 500」或「搜不到数据」的形式出现。

这份文档是踩坑后的固化规则，改 `pkg/model`、`pkg/audit`、`pkg/*/handler.go` 里任何带 SQL 的
代码前请先过一遍。

## 三条军规

### 1. 列名、表名不要直接拼进 SQL 字符串

不同库的保留字集合不同，而且**同一种库的不同版本也不同**：`key`、`read` 在 MySQL 5.7 与 8.0
都是保留字；`groups` 只在 MySQL **8.0** 才是保留字（5.7 不是）；`GROUPS` 在 PostgreSQL 18 之前
也不是。

裸写列名的后果是 `Error 1064 (42000) ... near 'key = ?'`——**PostgreSQL 与 SQLite 照常通过**，
所以只有 MySQL 环境能发现。

写法（GORM 会按方言加引号，MySQL 是反引号、PG/SQLite 是双引号）：

```go
// 等值条件
DB.Where(map[string]interface{}{"key": key})                    // 最省事
DB.Where(clause.Eq{Column: "read", Value: false})               // 等价写法
// IN / LIKE / 排序
DB.Where(clause.IN{Column: clause.Column{Name: "key"}, Values: vals})
DB.Where(clause.Like{Column: clause.Column{Name: "key"}, Value: "%x%"})
// 选列（含别名）
tx.Clauses(clause.Select{Expression: clause.Expr{
    SQL: "id, ? AS ?", WithoutParentheses: true,
    Vars: []interface{}{clause.Column{Name: column}, clause.Column{Name: "group_list"}},
}})
```

踩过的坑：

- 带表别名的限定名（`g.global`、`t.key`）在 MySQL 下是合法的，裸列名才报错——做静态扫描时
  不要误报这类。
- **`Select()` 不能传 `clause.Expression`**：GORM v1.31 的 `Select` 只接受 `string` / `[]string`，
  传 `clause.Expr` 会直接返回 `unsupported select args`。要用 `Clauses(clause.Select{...})`，
  并且 `clause.Expr` 要设 `WithoutParentheses: true`，否则生成的是 `(col) AS (alias)`。
- 别名同样不能撞保留字：`AS groups` 在 MySQL 8 上就是 1064，改成 `group_list` 之类。

### 2. 不要往库里写 `time.Time` 的零值

Go 的零值时间会被 go-sql-driver 渲染成 `'0000-00-00 00:00:00'`。MySQL 严格模式（5.7 / 8.0
默认带 `NO_ZERO_DATE` + `STRICT_TRANS_TABLES`）直接报：

```
Error 1292 (22007): Incorrect datetime value: '0000-00-00' for column 'created_at' at row 1
```

PostgreSQL（会存成 `0001-01-01`）与 SQLite 照收。两种典型踩法：

- **按主键 Save 整行**：`DB.Save(&SecuritySetting{Model: Model{ID: 1}})` 会把 `created_at` 一起
  写回零值。已在 `Model.BeforeSave`（`pkg/model/model.go`）统一处理：ID 非零且 `CreatedAt`
  为零值时 `Omit("created_at")`。新增这类「构造一个只有主键的对象再 Save」的代码不用再操心，
  但**不要**覆盖掉这个 hook。
- **新建行时留零值的时间列**：例如 `LoginAttempt`（未封锁时 `blocked_until`、刚建行时
  `window_started_at`）。这类列用**明确的哨兵值**代替零值，见 `pkg/model/login_attempt.go`
  的 `noBlock`（`time.Unix(0, 0)`：三家库都合法，且与零值在 `now.Before(x)`、`x > now`、
  `x <= now` 三种比较下结果完全一致）。

语义上「可空」的时间列一律用 `*time.Time`（项目里的惯例，如 `Announcement.StartAt`、
`ScheduledTask.NextRunAt`），不要用零值表达 NULL。

### 3. 不只是「不报错」，结果也要一致

同一份 SQL 在三种库上「都能跑」不等于「结果一样」：

- **`LIKE` 的大小写**：PostgreSQL 区分大小写，MySQL（默认 `*_ci` 排序规则）与 SQLite 不区分。
  包含匹配统一走 `pkg/model/dialect.go` 的 `PatternLikeSQL(column)` / `PatternLike(column, pattern)`，
  PG 下会生成 `ILIKE`。这条同时让数据库路径与审计归档路径（`pkg/audit/archive_condition.go`
  的 `opContains` 本来就用 ILIKE）保持一致，否则「同一份审计记录查得到还是查不到」取决于它落在
  库里还是 parquet / ES 里。
- **可空列的 NULL 排序**：`ORDER BY col DESC` 时 PG 把 NULL 当最大值排在最前，MySQL / SQLite
  排在最后。要固定顺序就显式写 `ORDER BY col IS NULL, col DESC`（见 `ListAutoDisabledUsers`）。
- **唯一性与大小写**：MySQL 的 `*_ci` 排序规则下 `Admin` 与 `admin` 视为重复，PG 视为两个。
  涉及唯一索引时按「精确匹配」使用，不要依赖两库口径一致。

## 验证方式（三层，改完 SQL 请至少跑到第 2 层）

1. **单元测试（SQLite 维度）**：`go test ./pkg/model/ ./pkg/audit/ ./pkg/users/ ./pkg/settings/ -count=1`。
2. **直连目标库跑真实函数**：写个几十行的临时 main（放 `tools/` 下、验证完删掉）调
   `model.InitDB()` + 受影响的函数，分别用 MySQL 5.7 / MySQL 8（**务必挑严格模式的实例**）/
   PostgreSQL 的 DSN 各跑一次。注意 MySQL 5.7 的实例如果 `sql_mode` 没开严格模式，
   零值时间只会告警不报错，会给出「修复前也通过」的假象——先 `SELECT @@sql_mode` 确认。
3. **全套接口冒烟**：`tools/apismoke`（`-log-file` 扫服务端日志里的数据库错误），
   对三种库各跑一遍 61 项只读检查：

   ```bash
   /tmp/apismoke -base-url http://127.0.0.1:8080 -username admin -password '...' \
     -log-file /home/aerolink/data/aerolink.log -smtp -ai
   ```

## 已修复的问题清单（供回溯）

| 症状 | 根因 | 位置 |
| --- | --- | --- |
| 未读站内信接口 500、锁定 IP 列表返回 `items:null`（前端崩） | 裸列名 `read` / `key` 撞 MySQL 保留字 | `pkg/model/notification.go`、`pkg/model/login_attempt.go`、`pkg/resources/helmrelease_handler.go` |
| 保存安全策略 / 审计设置报 `Error 1292` | `Save` 把零值 `created_at` 写回 | `pkg/model/model.go` 的 `Model.BeforeSave` |
| 登录失败计数、自动锁定、手动拉黑在 MySQL 上静默失效 | 建行时 `blocked_until` / `window_started_at` 是零值 | `pkg/model/login_attempt.go` 的 `noBlock` |
| 重命名 / 删除本地组在 MySQL 8 上 1064 | 别名 `AS groups` 撞 MySQL 8 保留字 | `pkg/model/group.go` |
| PG 上用户 / 审计检索对大小写敏感 | `LIKE` 在 PG 区分大小写 | `pkg/model/dialect.go` + 各调用点 |

## 附：MySQL 5.7 的老版本风险

MySQL **5.7.7 之前**（或 `innodb_large_prefix=OFF`、`ROW_FORMAT=COMPACT`）时，utf8mb4 的索引
前缀上限是 767 字节，下面这些会建表失败（`Error 1071`）：

- `scheduled_tasks` 的 `(cluster_name(100) + type(100) + key(255))` 组合唯一索引 ≈ 1820 字节
- `role_assignments` 的 `(subject(255) + subject_type(20))` ≈ 1100 字节
- `login_attempts.key` 主键 ≈ 1020 字节

5.7.7 起默认开启大前缀（3072 字节），官方镜像最新的 5.7.44 没问题。真要在很老的 5.7 上部署，
先确认 `SHOW VARIABLES LIKE 'innodb_large_prefix'` 为 ON。
