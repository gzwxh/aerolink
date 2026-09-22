# 长期跑 PostgreSQL 12：现在要定的事，与将来升级的无缝路径

- 状态：**应用侧代码已就绪**（跨版本实测 + 新增版本下限护栏）；运维侧 6 项要现在定，1 份 12.12 起库操作（§6），1 份升级路径
- 触发：现网确定要长期停留在 PG 12，后续才考虑升级。问「现在有哪些地方需要改，同时以后换新版本
  能无缝对接」
- 相关：`docs/dev/plans/2026-09-20-sqlite-to-postgres-migration.md`（切库与搬运工具）

## 1. 应用代码：不需要为 PG 12 做任何改动

这是实测结论，不是推断。同一个二进制（含 `6deccad`）在下列版本上逐项跑通，行为一致：

| 验证项 | 12.12 | 12.22 | 13.23 | 18.6 |
| --- | --- | --- | --- | --- |
| 空库首次启动 `AutoMigrate`（31 张表） | ✅ | ✅ | ✅ | ✅ |
| 超管创建 / 密码登录 | ✅ | ✅ | ✅ | ✅ |
| 自增序列（新建对象主键连续） | ✅ | ✅ | ✅ | ✅ |
| 8 个并发登录：`user_sessions` 序号不重不漏 | ✅ | ✅ | ✅ | ✅ |
| `SecretString` 写入后读回解密（MFA） | ✅ | ✅ | ✅ | ✅ |
| 头像 `ON CONFLICT` upsert | ✅ | ✅ | ✅ | ✅ |
| 同库重启（`AutoMigrate` 幂等 + kubeconfig 解密） | ✅ | ✅ | ✅ | ✅ |
| `-v=10` 抓全量 SQL：无 13+ 语法 | ✅ | ✅ | ✅ | ✅ |
| 应用日志无 W/E（除未设 `AEROLINK_METRICS_TOKEN`） | ✅ | ✅ | ✅ | ✅ |

原因是我们只用到 PG 9.5 就有的一小组语法（`bigserial` / `timestamptz` / `bytea` /
`CREATE INDEX IF NOT EXISTS` / `ON CONFLICT ... DO UPDATE` / `RETURNING`），DDL 全部由
`AutoMigrate` 生成，且：

- 代码里没有任何 `server_version` 之类的版本判断，也没有 `CREATE EXTENSION`；
- 没有 `gen_random_uuid()`、`NULLS NOT DISTINCT`、`MERGE`、`GENERATED ... AS IDENTITY`、
  `datatypes.JSON`（→ jsonb）这类抬高版本下限的写法。

**跨版本搬数据也已实测**：`tools/dbmigrate` 把 PG **12.12** 的库整体搬到 PG **18.6**——
全表行数一致、列数一致（311 = 311）、`setval` 生效（升级后新建角色拿到 id 6 而不是撞 1）、
加密列可解（用 12.12 源库的明文密钥算出的 TOTP，在 18.6 目标库上启用 MFA 成功）。因此
「以后换版本」不需要改应用，只需要搬数据 + 换 DSN。

## 2. 现在就该定的 6 件事

这些是「现在不定、以后很难补」的，因为有些只能靠 dump/restore 重建库才能改。

### 2.1 用哪个 minor，以及镜像标签要固定

| | |
| --- | --- |
| 现状（实测） | `12.12`，官方发布日期 **2022-08-11** |
| 问题 | 12 系列最后一个 minor 是 **12.22（2024-11-21）**，12.12 之后还缺 **10 个 minor（12.13–12.22）**，其中包含安全修复；官方已把 **12 标记为不再支持** |
| 现在要做 | tag 写死到具体 minor（别用 `postgres:12`，否则哪天拉到别的 minor 会带来意外）；12 系列内部只用换镜像重启，不用 dump/restore |
| 本次采用 | 内网镜像源 `swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/postgres:12.12`（已实测），起库命令见 §6 |

`12.12` → `12.22` 是同一种数据目录布局，想升时只改镜像 tag —— 本次先落在已经端到端验证过的
`12.12` 上，不引入没验过的变量。

### 2.2 编码与排序规则（最难事后补，现在必须选对）

| | 实测值 |
| --- | --- |
| 编码 | `UTF8` |
| `datcollate` / `datctype` | `en_US.utf8`（glibc 提供） |
| `datcollversion` | **不存在**——这个列是 PG 13 才引入的，12 里没有 |

- 编码继续用 `UTF8`，别动。
- 排序规则是 `glibc` 提供的：它的排序结果会随 glibc 版本变化。PG 13 起会给数据库记录
  「排序规则版本」，之后只要 glibc 变了，PG 15+ 会告警，需要执行
  `ALTER DATABASE kite REFRESH COLLATION VERSION;`；如果文本列上有唯一索引或排序索引，
  还要 `REINDEX`，否则可能出现「索引与排序规则不一致」导致的查找异常。
- 所以：**把 `datcollate` 记进运维文档**，升级后按上面两步走。若希望彻底不受 glibc 漂移影响，
  PG 15+ 可以改用 ICU 排序规则——但那是升级时重建库的事，现在（12）没有这个选项。

### 2.3 时区

容器默认 `TimeZone = Etc/UTC`，而应用 DSN 里显式写了 `TimeZone=Asia/Shanghai`，实测时间戳
（`+08:00`）正确。**保持 DSN 里显式写**，不要依赖容器时区——各级 PG 行为一致，但换了基础镜像
或宿主机时区就说不准了。

### 2.4 口令加密方式：现在就可以切到 SCRAM

| | 实测值 |
| --- | --- |
| `password_encryption` | `md5`（PG 12 的默认值） |
| `kite` 角色的口令哈希 | `md5915d1f02492…`，确实是 md5 |

PG **14 起默认值改为 `scram-sha-256`**。已存在的 md5 哈希在新版本上仍然能用，所以升级不会
断——但这是「现在花 1 分钟、以后省一次折腾」的事：

```sql
-- 在 12 上就能做（PG 10+ 支持 SCRAM）
ALTER SYSTEM SET password_encryption = 'scram-sha-256';
SELECT pg_reload_conf();
ALTER ROLE kite PASSWORD '<同一个口令>';   -- 重设才会用新算法重新哈希
```

注意：改完以后所有连接方都要支持 SCRAM——本项目用的 pgx 支持，`psql` 10+ 支持；如果你们还有
别的老客户端（旧 libpq、老监控 agent），先确认再切。

### 2.5 连接数与内存参数：要外置，且要按副本数算总账

| | 实测值（容器默认） |
| --- | --- |
| `max_connections` | `100` |
| `shared_buffers` | `128MB`（16MB 单位下显示 16384） |
| `wal_level` | `replica` |

- 应用侧 `AEROLINK_DB_MAX_OPEN_CONNS` 默认 100。**多副本时**：`副本数 × 100` 会直接打满
  `max_connections`，必须先在数据库侧上调，或把应用侧调小。
- 要用的参数的**落地方式**：现网用 `docker run ... -c key=value` 传参（与既有的 18 容器一致，
  `docker inspect` 随时可查回全套参数），完整清单固化在 §6.1 那条命令里。之所以强调「要有
  一份外部记录」：`pg_upgrade` 不会迁移 `postgresql.conf`，重建实例时不能靠容器内的文件。

#### 按 300 个用户算出来的值

要数的不是「300 个人」，而是「同一瞬间有几个连接占着数据库」。两个口径：

- 应用侧：**每个副本**的进程池上限是 `AEROLINK_DB_MAX_OPEN_CONNS`（默认 100）。池子里的连接
  **空闲时也占着坑位**，不会因为没人用就还回去。
- 数据库侧：`max_connections` 是全部客户端加起来的总坑位，还要留几个给管理员 `psql`、备份
  `pg_dump` 和监控（`superuser_reserved_connections` 默认 3，实际只够一个人用）。

所以硬约束是：

```
副本数 × AEROLINK_DB_MAX_OPEN_CONNS + 20（管理/备份/监控余量） ≤ max_connections
```

| 部署形态 | 应用侧占用 | 至少要 | 建议值 |
| --- | --- | --- | --- |
| 1 副本（现状） | 100 | 120 | 200（现有值就够） |
| 2 副本 | 200 | 220 | 300 |
| 3 副本 | 300 | 320 | **400** |

**结论：按 300 人、最多 3 副本，取 `max_connections=400`。** 再扩到 4 副本时，要么加到 500，
要么把应用侧调成 `AEROLINK_DB_MAX_OPEN_CONNS=80`（4 × 80 = 320）。

不要无脑往大调：每个坑位在数据库进程里都要占内存（基线几 MB，遇到排序/联表再按 `work_mem`
涨），本机 30G 内存下 400 个坑位最坏按每连接 10MB 估也就 4G 左右，其余内存参数沿用现网
`kite-postgres` 那一套即可（见 §6.1）。真到「400 都不够」的规模，该上的是连接池中间件
（PgBouncer），不是继续加坑位。

### 2.6 备份

从切库那天起就要有：逻辑备份 `pg_dump`（体积小、跨版本可恢复，天然是升级的退路）+ 需要时再
谈物理备份/PITR。切库前的兜底与步骤见 `2026-09-20-sqlite-to-postgres-migration.md` §5。

## 3. 升级路径（现在只要知道，不用现在做）

| 升级类型 | 做法 | 是否需要搬数据 |
| --- | --- | --- |
| minor（12.12 → 12.22） | 换镜像重启，读一遍 release notes | 不需要 |
| major（12 → 14/15/16/17/18） | ① 新容器 + `pg_dump`/`pg_restore`；② 新容器 + `tools/dbmigrate`；③ `pg_upgrade`（需旧版本二进制并存） | 需要 |

- major 可以**一步跳**（12 → 18 直接跳，我们已实测数据能搬）——但按官方建议，跳之前把中间
  各版本的 release notes 过一遍。
- 容器化部署下推荐 ②/①：`pg_upgrade` 要求新旧数据目录同机且旧二进制可用，容器里反而麻烦。
- **升级后固定动作**：
  1. `ALTER DATABASE kite REFRESH COLLATION VERSION;`（若 `datcollate` 没变则通常无副作用；
     若变了，再 `REINDEX`）；
  2. 核对 `max_connections` 与连接池额度；
  3. PG 18 起官方镜像的 `PGDATA` 从 `/var/lib/postgresql/data` 改为
     `/var/lib/postgresql/18/docker`，卷要挂 `/var/lib/postgresql`；
  4. 回滚预案：**旧库在验证通过前不要删**，把 DSN 改回去即可回滚。
- 各版本支持到期的官方日期（2026-09 核对）：14 → 2026-11-12、15 → 2027-11-11、
  16 → 2028-11-09、17 → 2029-11-08、18 → 2030-11-14。**14 只剩一年出头，选型建议 15/16。**

## 4. 代码侧的守则（防止后来者把版本下限抬高）

只要现网还有 PG 12，新增/改动的模型与 SQL 就**不要**引入这些（改一次就可能让 12 起不来）：

- `gen_random_uuid()`（13+ 才有内置；12 需要 `pgcrypto` 扩展）
- `NULLS NOT DISTINCT`（15+）、`MERGE`（15+）、`ANY_VALUE`（16+）、`JSON_TABLE`（17+）
- 多范围类型（multirange，14+）——驱动 pgx 会按 `pgVersion >= 14` 分支，但它只影响类型映射
- `datatypes.JSON`（会建成 `jsonb`；12 有 jsonb，但要注意别顺手用 14+ 的 jsonb 新函数）

现状是干净的（已 grep 确认）。**CI 不覆盖 PostgreSQL**（`.github/workflows/ci.yml` 在
`make build` 之后跑 `go test ./...`，数据库只覆盖 SQLite），所以这条守则由仓库根的
`pg_version_floor_test.go` 兜底：

- 它用 `go/parser` 扫全仓库 Go 源码里的**字符串字面量**（GORM tag 与手写 SQL 都写在字符串里，
  注释与文档不算），命中上表关键词就 `t.Fatalf`，并把「哪个版本才有」一并打出来；
- 覆盖范围是「仓库里出现的 SQL 文本」，不是「运行时真正执行过的 SQL」——所以它是护栏，不是
  替代真机验证；
- 新增写法要放行时，在 `pg13PlusTokens` 的注释里写明它在 PG 12 上为什么可用，而不是直接删条目。

## 5. 与版本无关、但已知的两项

1. `LIKE` 区分大小写：用户搜索、审计日志检索在 PG 上大小写敏感（SQLite/MySQL 默认不敏感）。
2. 并发登录会在 PG 服务端留下 ERROR 级日志：`user_sessions` 的会话序号用「先 INSERT、撞唯一键
   再重试 UPDATE」实现，8 个并发登录会产生 7 条
   `duplicate key value violates unique constraint "user_sessions_pkey"`。设计使然，但如果有
   对 PG 错误日志的告警会被误报。

## 6. 现在就用 12.12 起库：可直接粘贴的操作

前提：本机（`10.100.117.8`）已有一个 `kite-postgres` 容器跑 **18**，数据在 `/data/postgresql`。
**不要停它、也不要让 12 去挂它的数据目录**——12 认不出 18 的数据布局。正确的做法是「另起一个
12、换一个端口并存，验证完再切流」，回滚就是改回 DSN。

### 6.1 起 12.12

```sh
docker pull swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/postgres:12.12

mkdir -p /data/postgresql12
docker run -d --name kite-postgres12 --restart unless-stopped \
  -p 5433:5432 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD='<超管口令>' \
  -v /data/postgresql12:/var/lib/postgresql/data \
  swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/postgres:12.12 \
  -c shared_buffers=1GB -c max_connections=400 -c work_mem=16MB \
  -c maintenance_work_mem=256MB -c effective_cache_size=8GB -c max_wal_size=2GB \
  -c timezone=Asia/Shanghai -c log_timezone=Asia/Shanghai \
  -c log_min_duration_statement=1000
```

- 12 的官方镜像数据目录就是 `/var/lib/postgresql/data`（18 才是 `/var/lib/postgresql/18/docker`），
  所以这里挂载点和 18 那个容器不同，**不能互相复用**。
- 端口用 `5433` 是刻意的：18 还占着 `5432`，并存期间两个都连得上。
- 首次初始化要等（实测 12.12 约 60 秒，比新镜像慢），就绪判断：
  `docker exec kite-postgres12 pg_isready -U postgres`，反复到出现 `accepting connections`。
- `max_connections=400` 的来由见 §2.5；其余参数照抄现网那一套，别另起一组。

### 6.2 建业务角色

```sh
docker exec kite-postgres12 psql -U postgres -c "CREATE DATABASE kite;"
docker exec kite-postgres12 psql -U postgres -c "CREATE ROLE kite LOGIN PASSWORD '<kite 口令>';"
docker exec kite-postgres12 psql -U postgres -c "ALTER DATABASE kite OWNER TO kite;"
```

不给 `kite` 角色 `CREATEDB` / `CREATEROLE`：应用不需要，给了只是扩大影响面。

### 6.3 搬数据

从 SQLite 搬（首次切库，步骤与校验见 `2026-09-20-sqlite-to-postgres-migration.md` §5）：

```sh
cd /wxh/aerolink
set -a; . /root/kite-secrets.env; set +a
DB_TYPE=sqlite DB_DSN=dev.db \
  go run ./tools/dbmigrate -target-type postgres \
    -target-dsn 'host=127.0.0.1 user=kite password=<kite 口令> dbname=kite port=5433 sslmode=disable TimeZone=Asia/Shanghai'
```

从 18 搬到 12（若 18 上已有真实数据）：显式加 `-source-type postgres -source-dsn '<18 的 DSN>'`，
目标 DSN 同上。想先干跑、不动库就加 `-dry-run`。

### 6.4 切流

1. `dev.env` 改 `DB_TYPE=postgres`，`DB_DSN` 指到 `port=5433`，并**带上 `TimeZone=Asia/Shanghai`**；
2. `make backend` 重建二进制后重启（Go 改动要靠这次重启才生效）。本节点实际用的重启命令：

```sh
cd /wxh/aerolink && make backend
set -a; . ./dev.env; set +a
setsid nohup /wxh/aerolink/aerolink >> /data/logs/aerolink.log 2>&1 < /dev/null &
```

日志在 `/data/logs/aerolink.log`。`dev.env` 就是本节点的生效配置——**别用不加载它的方式启动**，
否则会静默回落到 SQLite 的 `dev.db`，看到的是旧数据；
3. 按切库文档 §5.6 的清单逐项校验：各表行数、能登录、3 个集群都能拉资源、MFA 能验码、
   新建一个角色/收藏确认主键不冲突；
4. 验证通过后再退休 18：先 `docker stop kite-postgres`，观察几天再删 `/data/postgresql`。
   在删之前，回滚都只是把 DSN 改回 `5432` 的事。

### 6.5 不要漏的一条

`DB_DSN` 里显式写 `TimeZone=Asia/Shanghai`。12 / 13 / 18 行为一致，但漏写**不会报错**，只会让
界面与审计日志里的时间整体偏移；应用启动时会对这种漏写打一条 warning（本轮新增，见
`pkg/common/common.go` 的 `postgresDSNTimeZoneWarning`）。

### 6.6 本节点的落地状态（2026-09-20 实际执行）

| 项 | 值 |
| --- | --- |
| 数据库容器 | `kite-postgres12`（12.12），宿主端口 **5433**，数据目录 `/data/postgresql12` |
| 业务库 / 角色 | `kite` 库，属主 `kite`（`rolsuper/rolcreatedb/rolcreaterole` 全为 `f`） |
| 口令存放 | `/root/kite-pg12-secrets.env`（600，超管 + `kite` 角色） |
| 应用配置 | `dev.env`：`DB_TYPE=postgres`、`DB_DSN=...port=5433...TimeZone=Asia/Shanghai` |
| 应用日志 | `/data/logs/aerolink.log` |
| 回滚资产 | `/data/backup/`：`dev.db.2026-09-20-1913`（SQLite 快照）、`kite.bin.old-20260920-1750`（旧二进制）、`dev.env.old-20260920-1750`、`pg18-all-2026-09-20-1922.sql`（退役前的 18 全量 dump） |
| 18 容器 | **已退役**（2026-09-20 停用并删除容器、删除 `/data/postgresql`；删前确认无任何客户端连接，并留了上面那份 dump） |

搬运用的是 `tools/dbmigrate`（SQLite → 12.12），逐表行数对照全部一致。两个非致命的工具提示：

- `user_avatars` 主键是 `user_id`、没有自增序列——这张表本来就不需要序列，忽略；
- 源库里有一张历史遗留表 `passkey_credentials`（旧版本的功能，模型里已无对应类型，**0 行**）
  没有搬，工具会把它列出来，属于预期内。

回滚顺序：`dev.env` 改回 `DB_DSN=dev.db`（并去掉 `DB_TYPE`）→ 用 `/data/backup/kite.bin.old-*`
起旧二进制 → 验证。SQLite 库一路没删，回滚窗口不设限（18 已按运维决定退役，见上表）。

### 6.7 以后换到 12.22（或其它 12.x）

12 系列内部是同一种数据目录布局，**换 minor 不需要 dump/restore**，但要先解决一个前提：
**内网镜像命名空间里得先有这个 tag**。2026-09-20 实测该命名空间
（`swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/postgres`）只有
`12.12`、`13.23`、`18`、`18.6`；`12`（浮动 tag）、`12.19`~`12.22` 都没有，而本机
**连不上 `docker.io`**，所以「换 tag」这一步得由维护镜像命名空间的人先推上去。

tag 就绪后，操作只有三步（数据目录、端口、参数都不变）：

```sh
docker stop kite-postgres12 && docker rm kite-postgres12
# 用 §6.1 同一条 docker run，只把镜像换成 :12.22
```

停库前先 `pg_dump` 留底；起来后按 §5.6 的清单校验，并**确认 `max_connections` 等参数仍在**
（参数是 `docker run -c` 传的，重建容器不会自动继承——这正是 §2.5 强调要有一份外部记录的原因）。

## 7. 回归脚本：`tools/apismoke`

换数据库版本（12.22、14+）、或大改动上线前，用一条命令把各功能面的读写路径过一遍，
比手点页面可靠，也能把「接口没报错但 SQL 已经出错」的情况暴露出来——后者在换库时
最容易发生。

```sh
# 只读检查（默认全跑）+ 扫服务端日志里的数据库错误
AEROLINK_SMOKE_USER=super AEROLINK_SMOKE_PASSWORD='<口令>' \
  go run ./tools/apismoke -base-url http://127.0.0.1:8080 \
    -cluster dev -namespace devops -log-file /data/logs/aerolink.log

# 再加上写检查、AI 工具、邮件投递
AEROLINK_SMOKE_USER=super AEROLINK_SMOKE_PASSWORD='<口令>' \
  go run ./tools/apismoke -base-url http://127.0.0.1:8080 \
    -cluster dev -namespace devops -write-namespace devops \
    -log-file /data/logs/aerolink.log -ai -smtp
```

| 组 | 内容 | 什么时候跑 |
| --- | --- | --- |
| 读 | 设置类；审计三类日志的检索与 CSV 导出；用户/角色/绑定组/API Key；通知/模板/Helm 仓库；集群与资源列表、详情/describe/历史/关联、全局搜索；容器文件浏览 | 默认 |
| 写 | ConfigMap/Secret/Deployment/Service/Job/CronJob/StatefulSet/DaemonSet 的建改删、扩缩容与滚动重启、YAML apply、Pod 文件上传下载、PV/StorageClass/Namespace 建删 | `-write-namespace <可破坏的命名空间>` |
| AI | 对话；`apply_resource`/`delete_resource` 的**确认**与**拒绝**两条分支（确认后资源真的建/删，拒绝后确实没建） | `-ai` |
| 邮件 | 把通知配置临时指向内置假 SMTP，发一封测试邮件并确认真的收到（含 Subject 头） | `-smtp` |
| 日志 | 扫描服务端日志中的 `SQLSTATE` / `syntax error` / `does not exist` / 权限不足 / 死锁 | `-log-file <路径>` |

### 7.1 跑之前要有「可随便折腾的实例」

写检查会真改集群，AI/邮件检查会临时改设置，所以**别对着生产实例跑全套**。安全做法是在
换库用的同一个数据库实例上克隆一份数据，另起一个实例：

```sh
# 1) 克隆生产数据到一个临时库（同实例，走 tools/dbmigrate）
docker exec kite-postgres12 psql -U postgres -c "CREATE DATABASE kite_smoke OWNER kite;"
DB_TYPE=postgres DB_DSN='<生产 DSN>' go run ./tools/dbmigrate \
  -target-type postgres -target-dsn '<kite_smoke 的 DSN>'

# 2) 让克隆库里的测试账号有一个已知口令（否则登录都不知用什么）
#    用仓库自己的哈希：写一个临时 _test.go 调 utils.HashPassword，或用界面重置
# 3) 用一个不占用的端口起实例（配置从 dev.env 取，只改库和端口）
DB_TYPE=postgres DB_DSN='<kite_smoke 的 DSN>' PORT=38092 /wxh/aerolink/aerolink &

# 4) 对着它跑；跑完把 kite_smoke 删掉
AEROLINK_SMOKE_USER=... AEROLINK_SMOKE_PASSWORD=... \
  go run ./tools/apismoke -base-url http://127.0.0.1:38092 -cluster dev -namespace devops \
    -write-namespace devops -ai -smtp -log-file /data/logs/aerolink.log
docker exec kite-postgres12 psql -U postgres -c "DROP DATABASE kite_smoke;"
```

多副本看 `2026-09-20-multi-replica-deployment.md`：同一份克隆库上起 2–3 个实例、用
`-log-file a,b,c` 一起扫日志即可。

三条使用注意：

1. **写检查会真的改集群**：`-write-namespace` 请指向一个可以随便破坏的命名空间。所有对象
   都用 `smoke-` 前缀，脚本结束时删除，并回查「没有 smoke- 残留」。
2. `-ai` / `-smtp` 会把通用设置与通知设置临时指向脚本内置的假 LLM / 假 SMTP，跑完复原，
   所以**可以在生产实例上跑**：不会真的调用外部模型，也不会真的发邮件。
3. 任何一项 FAIL 都会让退出码非 0，便于接进脚本。

