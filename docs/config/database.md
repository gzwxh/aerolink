# 数据库准备

鸢联 AeroLink 默认用 SQLite（一个文件），开箱即用；**生产环境与多副本部署要用 MySQL 或 PostgreSQL**。本页是建库与容量清单——建库 SQL、DSN 必填项、连接池与 `max_connections` 的换算、库结构变更由谁执行、以及 PostgreSQL 大版本升级。安装形态（Chart / 清单 / compose / systemd）见[部署与运维](../guide/operations.md)。

## 选型与版本要求

| 数据库 | 定位 | 版本要求 | 说明 |
| --- | --- | --- | --- |
| SQLite | 默认、单机 | 无（纯 Go 驱动，无 CGO） | 单文件、单写入者。**多副本不可用**——两个进程写同一个文件会互相锁死甚至损坏 |
| MySQL | 生产 / 多副本 | 5.7 / 8.x | 代码按 5.7 的保留字口径写 SQL（`key`/`read`/`groups` 不当标识符裸写），现网跑过 8.4 |
| PostgreSQL | 生产 / 多副本 | **12 及以上** | 同一个二进制实测通过 `12.12` / `12.22` / `13.23` / `18.6` |

版本下限不是随口说的，有两条判据：

- 代码只用 PostgreSQL 9.5 就有的语法，没有任何 `server_version` 判断、也不用 `CREATE EXTENSION`（`gen_random_uuid()` 属于禁止项，PG 12 上它要装 `pgcrypto`）。
- 仓库根目录的 `pg_version_floor_test.go` 会扫描全仓库的字符串字面量，一旦命中 13+ 专属关键字就**直接让测试失败**，用来拦住后来者悄悄抬高下限。

**CI 只跑 SQLite**：流水线里 `go test ./...` 挂的是 SQLite。也就是说，跨数据库的行为差异不会被 CI 拦住，换库或写带 SQL 的改动后必须到真机上核验。写代码前的口径见 `docs/dev/cross-database-compatibility.md`。

## 建库与账号

### PostgreSQL

用超级用户执行（应用自己不需要建库权限）：

```sql
CREATE DATABASE aerolink ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8' TEMPLATE template0;
CREATE ROLE aerolink LOGIN PASSWORD '你的密码';
ALTER DATABASE aerolink OWNER TO aerolink;
```

要点：

- **编码只能是 `UTF8`**，建错了改不了，只能重建库。
- **排序规则 `en_US.utf8`** 由 glibc 提供。宿主机 glibc 升级后要执行一次 `ALTER DATABASE aerolink REFRESH COLLATION VERSION;`；如果文本列上有唯一索引或排序索引，还要 `REINDEX`。
- **不要给应用角色 `CREATEDB` / `CREATEROLE`**：应用不需要，给了只是扩大影响面。实测该角色的 `rolsuper` / `rolcreatedb` / `rolcreaterole` 全为 `f` 也能跑。
- 表由首次启动的 `AutoMigrate` 自动建，所以库的 owner 要是应用角色——否则升级时加列会被 PostgreSQL 拒掉（见[库结构变更](#库结构变更由谁执行)）。

容器版等价三步：进容器 `psql -U postgres` 后依次执行上面三条即可。

### MySQL

```sql
CREATE DATABASE aerolink CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

字符集必须是 `utf8mb4`（`utf8` 三字节版本存不下 emoji 与部分中文外码位）。账号建法与权限按现网 DBA 口径来，应用侧只要求对目标库有正常的读写与 DDL 权限。

## DSN 写法

`DB_TYPE` 取 `sqlite`（默认）| `mysql` | `postgres`，`DB_DSN` 是连接串。取值非法（比如把 `postgresql` 写成 `postgresql` 的常见拼错）时进程**直接退出**，不会回落。

```bash
# SQLite：文件路径
DB_TYPE=sqlite
DB_DSN=/home/aerolink/db/aerolink.db

# PostgreSQL（key=value 形式）
DB_TYPE=postgres
DB_DSN="host=10.100.117.8 port=5433 user=aerolink password=<口令> dbname=aerolink sslmode=disable TimeZone=Asia/Shanghai"

# PostgreSQL（URL 形式，口令里的特殊字符要转义）
DB_TYPE=postgres
DB_DSN="postgres://aerolink:%40pwd@10.100.117.8:5433/aerolink?sslmode=disable&TimeZone=Asia%2FShanghai"

# MySQL
DB_TYPE=mysql
DB_DSN="aerolink:<口令>@tcp(10.100.117.8:3306)/aerolink?charset=utf8mb4&parseTime=true&loc=Asia%2FShanghai"
```

必填项与它们漏掉之后的症状：

| 参数 | 漏掉的后果 |
| --- | --- |
| PostgreSQL `TimeZone` | **不报错**，只让界面与审计日志的时间整体偏移（例如偏 8 小时）。启动时会在系统日志里打一条 warning 提示 |
| MySQL `loc` | 同上，且必须与服务器 `time_zone` 一致 |
| MySQL `charset=utf8mb4` | 中文与 emoji 写入异常 |
| PostgreSQL `sslmode` | 未开 TLS 用 `disable`；开了 TLS 用 `require` 或 `verify-full` |

`TimeZone` 是踩过坑的一项：它属于「不写也启动、写完才对」的参数，换库后的核对清单里必须包含时间。

## 连接池与容量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AEROLINK_DB_MAX_OPEN_CONNS` | 100 | 最大打开连接数（需 > 0） |
| `AEROLINK_DB_MAX_IDLE_CONNS` | 10 | 最大空闲连接数（可 0） |
| `AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES` | 10 | 连接最大存活时间（分钟，需 > 0） |

**容量公式是硬约束**：

```
副本数 × AEROLINK_DB_MAX_OPEN_CONNS + 20（管理 / 备份 / 监控余量） ≤ max_connections
```

- **空闲连接也占坑**：连接池里的连接空闲时不还回去，仍占着服务端的连接位。
- `pg_dump` / `psql` / 监控采集也各占一条连接，别把余量吃到 0。
- 参考取值：按 300 用户、最多 3 副本的设计，PostgreSQL 取 `max_connections=400`；要到 4 副本，要么把它加到 500，要么把应用侧调到 80。

改大连接池之前先算公式，否则表现是「平时正常、高峰随机连接失败」。

## 库结构变更由谁执行

- **首次启动自动建表**：`AutoMigrate` 按模型建表、加列，新增的表会自动补上。
- **生产库的应用账号通常不是表 owner**：这时 PostgreSQL 会拒绝 `AutoMigrate` 的加列（`must be owner of table ...`，SQLSTATE 42501），**只告警、不阻断启动**。所以不能指望「启动时自己长出来」——每次发布的升级说明里会单列一节，写明升级前需执行的 SQL（三种数据库的等价写法）。
- **`AEROLINK_DB_MIGRATE=off`**：完全跳过自动迁移与回填，只打印一条说明，库结构改由外部流程（DBA / 发布脚本）维护。**`checkSchema` 仍然会跑**，用于核对。
- **`AEROLINK_DB_MIGRATE_STRICT=true`**：迁移出错即 panic，仅用于开发与 CI，生产不要开。

启动时 `checkSchema` 会把库结构与模型逐表逐列比对，文案（系统日志原文）：

| 情况 | 文案 |
| --- | --- |
| 缺表 | `库结构缺少表 %s：相关功能会报错，请让 DBA 建表` |
| 缺列 | `库表 %s 缺少列 %s：依赖它的接口会报错，请让 DBA 补上` |
| 一致 | `库结构与模型一致`（Info 级） |
| 有差异 | `共发现 %d 处库结构差异（见上方清单）——补齐后重启即可；服务当前仍可启动`（Error 级） |

升级后核对就是在日志里找这几条：有差异记录说明某个 SQL 没执行，补齐后重启即可。

## 改名与账号调整

PostgreSQL 换库名或角色名不必搬数据，秒级完成：

```sql
-- 1) 断开所有连接后改名
ALTER DATABASE kite RENAME TO aerolink;
-- 2) 连到新库，把旧角色拥有的对象转给新角色
REASSIGN OWNED BY kite TO aerolink;
-- 3) 改 DSN 里的 dbname= / user=，重启
```

要做到零停机，就在重启前先给旧角色补 `GRANT ALL`（表与序列都要），这样切换窗口内两边的连接都能工作。

顺带一提，如果打算启用 SCRAM 口令认证，可以现在就切：

```sql
ALTER SYSTEM SET password_encryption='scram-sha-256';
SELECT pg_reload_conf();
ALTER ROLE aerolink PASSWORD '<同一口令>';   -- 必须重设才会重新哈希
```

切换前确认所有连接方都支持（pgx 与 `psql` 10+ 都支持）。

## PostgreSQL 大版本升级

| 场景 | 做法 |
| --- | --- |
| 小版本（如 12.12 → 12.22） | 换镜像 tag 重启即可，数据目录布局不变，不需要 dump/restore |
| 大版本（12 → 14/15/16/17/18） | ① 新容器 + `pg_dump` / `pg_restore`；② 新容器 + `tools/dbmigrate`；③ `pg_upgrade`（需要旧版本二进制并存）。容器化场景推荐 ①/② |

跨大版本可以一步跳（12 → 18 实测能搬），但建议翻一遍中间版本的 release notes。升级后有三件固定动作：

1. `ALTER DATABASE aerolink REFRESH COLLATION VERSION;`（`datcollate` 变了还要 `REINDEX`）。
2. 核对 `max_connections` 与连接池额度是否仍然匹配上面的公式。
3. 注意 PG 18 起 `PGDATA` 变成 `/var/lib/postgresql/18/docker`，卷要挂到 `/var/lib/postgresql`——照抄旧版的卷路径会让数据「消失」。

逻辑备份（`pg_dump`）体积小、跨版本可恢复，本身就是升级的退路；换库当天的回滚方式与备份清单见[部署与运维](../guide/operations.md#备份与恢复)。

## 相关文档

- [环境变量](./env.md)：连接池、`AEROLINK_DB_MIGRATE` 等全部变量的取值与校验。
- [配置文件](./config-file.md)：`AEROLINK_CONFIG_FILE` 与「配置文件接管、界面只读」的语义。
- [Chart 配置](./chart-values.md)：`db.type` / `db.dsn` / `db.sqlite.options` 与自带 Secret 复用。
- [常见问题](../faq.md)：SQLite 在 `hostPath` 上 `out of memory (14)` 的成因与 `_pragma` 写法。