# 长期跑 PostgreSQL 12：现在要定的事，与将来升级的无缝路径

- 状态：**应用侧结论为「无需改动」**（已跨版本实测）；运维侧列出 6 项要现在定，1 份升级路径
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
| 应用日志无 W/E（除未设 `KITE_METRICS_TOKEN`） | ✅ | ✅ | ✅ | ✅ |

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
| 现在要做 | 至少升到 **12.22**（minor 升级只需换镜像重启，不用 dump/restore）；并把镜像 tag 写死成 `12.22`（别用 `postgres:12`，否则哪天拉到别的 minor 会带来意外） |

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

- 应用侧 `KITE_DB_MAX_OPEN_CONNS` 默认 100。**多副本时**：`副本数 × 100` 会直接打满
  `max_connections`，必须先在数据库侧上调，或把应用侧调小。
- 要用的参数（`max_connections`、`shared_buffers`、`work_mem` 等）**放到挂载的配置文件里**，
  不要只靠 `docker run -e` 或改容器内文件：`pg_upgrade` 不会迁移 `postgresql.conf`，
  换实例时要靠这份文件重建。

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

现状是干净的（已 grep 确认）。**但 CI 不覆盖 PostgreSQL**（`.github/workflows/ci.yml` 只跑
SQLite），所以这条守则目前没有自动守卫——按需可以加一个「扫生成的建表 SQL 里是否出现高危
关键词」的测试。

## 5. 与版本无关、但已知的两项

1. `LIKE` 区分大小写：用户搜索、审计日志检索在 PG 上大小写敏感（SQLite/MySQL 默认不敏感）。
2. 并发登录会在 PG 服务端留下 ERROR 级日志：`user_sessions` 的会话序号用「先 INSERT、撞唯一键
   再重试 UPDATE」实现，8 个并发登录会产生 7 条
   `duplicate key value violates unique constraint "user_sessions_pkey"`。设计使然，但如果有
   对 PG 错误日志的告警会被误报。
