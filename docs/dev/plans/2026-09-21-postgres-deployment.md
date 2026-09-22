# 用 PostgreSQL 部署 Kite（清单 / Helm / 裸进程三条路）

- 状态：**现网即此形态**（PostgreSQL 12.12，宿主端口 5433；应用侧无需为 PG 做任何改动）
- 触发：现网数据库选型是 PostgreSQL（不是 MySQL），需要一份与
  `deploy/install-mysql.yaml` 对等的部署说明：库怎么建、DSN 怎么写、K8s 怎么部、
  怎么校验、出问题怎么退。
- 相关：
  - `docs/dev/plans/2026-09-20-sqlite-to-postgres-migration.md`（首次从 SQLite 切库 + `tools/dbmigrate`）
  - `docs/dev/plans/2026-09-20-pg12-now-and-upgrade-path.md`（PG 12 的参数、排序规则、升级路径；本文 §2 的取值都来自它）
  - `docs/dev/plans/2026-09-20-multi-replica-deployment.md`（多副本部署产物）
  - `deploy/install-postgres.yaml`（K8s 清单）、`deploy/aerolink.env.example`（裸进程/多副本的环境文件）

## 1. 三条路，先选一条

| 部署方式 | 用在哪 | 产物 |
| --- | --- | --- |
| **K8s 清单** | 已经有 K8s 集群、想让 Kite 跑在集群里 | `deploy/install-postgres.yaml`（本文 §4.1） |
| **Helm Chart** | 同上，但要参数化 / 可升级 / 多环境 | `charts/kite` 的 `db.*`（本文 §4.2） |
| **裸进程 / systemd** | 直接跑在宿主机上（**现网就是这条**） | `deploy/aerolink@.service` + `/etc/aerolink/aerolink.env`（本文 §4.3） |

三条路只有「怎么把 `DB_TYPE` / `DB_DSN` 送进进程」不同，数据库侧的准备工作完全一样。

## 2. 先把数据库定下来

这五项都很难事后补，建库前必须定。

| 项 | 取值 | 为什么 |
| --- | --- | --- |
| 版本 | **PostgreSQL 12 及以上** | 12.12 / 12.22 / 13.23 / 18.6 已用同一二进制实测跑通（建表、登录、序列、并发会话、密文往返、重启都不掉）；代码只用到 PG 9.5 就有的语法。仓库根有 `pg_version_floor_test.go` 挡着不让后来者抬高下限。 |
| 编码 | `UTF8` | 改不了，只能重建库。 |
| 排序规则 | `en_US.utf8`（现网实测值） | 由 glibc 提供，排序结果随 glibc 版本变化。**把实际值记进运维文档**：将来升级 glibc 后可能要 `ALTER DATABASE kite REFRESH COLLATION VERSION;` 并 `REINDEX`（PG 13 起才记录排序规则版本，12 没有这一列）。 |
| 时区 | DSN 里显式写 `TimeZone=Asia/Shanghai` | 容器默认 `Etc/UTC`。漏写**不会报错**，只让界面与审计日志的时间整体偏移 8 小时；应用启动时会打 warning（`pkg/common/common.go` 的 `postgresDSNTimeZoneWarning`）。 |
| 连接数 | `max_connections` 与「副本数 × 连接池」配套 | 默认 `100` 很小，而应用侧 `AEROLINK_DB_MAX_OPEN_CONNS` 默认也是 `100`。硬约束见下。 |

连接数的硬约束（**这是最容易踩的一条**）：

```text
副本数 × AEROLINK_DB_MAX_OPEN_CONNS + 20（管理 / 备份 / 监控余量） ≤ max_connections
```

连接池里的连接**空闲时也占着坑位**，不会还回去。按 300 人、最多 3 副本算：

| 部署形态 | 应用侧占用 | 至少 | 建议 `max_connections` |
| --- | --- | --- | --- |
| 1 副本 | 100 | 120 | 200 |
| 2 副本 | 200 | 220 | 300 |
| 3 副本 | 300 | 320 | **400** |

现网取 `max_connections=400`（起库命令见 `2026-09-20-pg12-now-and-upgrade-path.md` §6.1，
`docker run -c` 传参，重建容器不会自动继承，**要有一份外部记录**）。

**备份从切库那天就要有**：`pg_dump` 逻辑备份（体积小、跨版本可恢复，天然是升级的退路）。

### 建库与建角色

用超级用户执行，Kite 自己不建库：

```sql
CREATE DATABASE kite ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'
  TEMPLATE template0;
CREATE ROLE aerolink LOGIN PASSWORD '你的密码';
ALTER DATABASE kite OWNER TO aerolink;
```

- **不给** `aerolink` 角色 `CREATEDB` / `CREATEROLE`：应用不需要，给了只是扩大影响面。
- **已投产的库改角色名不必搬数据**（秒级完成）：用超级用户 `ALTER DATABASE kite OWNER TO aerolink;`，
  再连到 `kite` 库 `REASSIGN OWNED BY kite TO aerolink;`，最后把 DSN 的 `user=` 改掉并重启应用。
  想做到零停机就在重启前给旧角色补一句权限（表与序列的 `GRANT ALL`），旧实例就不会因为换主人而报权限错。
- 数据表由 Kite 首次启动时 `AutoMigrate` 自动创建，不用手工建表。
- 口令可以现在就按 SCRAM 存（PG 10+ 都支持，PG 14 起是默认值）：

  ```sql
  ALTER SYSTEM SET password_encryption = 'scram-sha-256';
  SELECT pg_reload_conf();
  ALTER ROLE aerolink PASSWORD '同一个口令';   -- 重设才会用新算法重新哈希
  ```

  改之前确认所有连接方都支持 SCRAM（本项目用的 pgx 支持，`psql` 10+ 支持）。

## 3. DSN 怎么写

`DB_DSN` 由 pgx 解析，两种写法都行：

```bash
# ① key=value（文档里用得最多）
DB_DSN="host=10.100.117.8 port=5433 user=aerolink password=<口令> dbname=kite sslmode=disable TimeZone=Asia/Shanghai"

# ② URL（口令含特殊字符时更省事，按 URL 规则百分号编码）
DB_DSN="postgres://aerolink:%40pwd@10.100.117.8:5433/kite?sslmode=disable&TimeZone=Asia%2FShanghai"
```

- `TimeZone` **必须写**（两种写法都认，大小写不敏感；也认 `options=-c timezone=...`）。
- `sslmode`：集群外、未开 TLS 时用 `disable`；开了 TLS 就换 `require` / `verify-full`。
- key=value 写法里，口令含空格或引号要用单引号包住并转义；含 `@ : /` 不需要转义。
- **不要把口令直接写在命令行上**（shell 历史、`ps` 都留痕）：用 Secret、环境文件
  （600 权限）或 K8s env。`tools/dbmigrate` 打日志时会抹掉 DSN 里的口令，但应用进程
  自身不保证——它当普通环境变量处理。

## 4. 三条部署路径

### 4.1 K8s 清单：`deploy/install-postgres.yaml`

这是 `deploy/install-mysql.yaml` 的 PostgreSQL 版，**两份互斥**：Namespace /
ServiceAccount / Secret / Deployment 名字完全一样（都叫 `aerolink`），同一个集群里同时
apply 会互相覆盖，选一条路走。逐项对照：

| 项 | MySQL 版 | PostgreSQL 版 |
| --- | --- | --- |
| `DB_TYPE` | `mysql` | `postgres` |
| Secret 里的 DSN 键 | `MYSQL_DSN` | `POSTGRES_DSN` |
| ClusterRoleBinding 名 | `aerolink-mysql` | `aerolink-postgres` |
| DSN 形式 | go-sql-driver：`user:pw@tcp(host:3306)/kite?...` | pgx：`host=... user=... dbname=... TimeZone=...` 或 `postgres://` |
| 额外字段 | `charset=utf8mb4`、`loc`（须与服务器 `time_zone` 一致） | `sslmode`、`TimeZone`（**必写**） |
| 建库 | `CREATE DATABASE kite CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` | `CREATE DATABASE kite ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' ...;` |
| 搬数据后的额外一步 | 无（`AUTO_INCREMENT` 自己取 max+1） | **要修序列**（`setval`），`tools/dbmigrate` 已自动做 |

用之前搜 `REPLACE-ME` 改三处：`JWT_SECRET`、`AEROLINK_ENCRYPT_KEY`、`POSTGRES_DSN`。

```bash
# 生成两个密钥（各一次，AEROLINK_ENCRYPT_KEY 生成后必须备份）
openssl rand -base64 32

kubectl apply -f deploy/install-postgres.yaml
kubectl -n aerolink rollout status deploy/aerolink

# 访问：http://<节点IP>:27862（NodePort 固定 27862，冲突就改）
kubectl -n aerolink get svc aerolink
```

`AEROLINK_ENCRYPT_KEY` 用于加密存库的敏感数据（集群 kubeconfig、LDAP/SMTP/OAuth 密码、
AI Key、MFA 密钥）：**一旦投入使用不可更换**，否则这些凭据全部解不开；未设置时服务
直接拒绝启动。丢了等于所有集群要重新接入。

### 4.2 Helm Chart

`charts/kite` 把 `db.type` / `db.dsn` 原样写进 Secret 的 `DB_TYPE` / `DB_DSN`，所以只要：

```yaml
# values-postgres.yaml
db:
  type: postgres
  dsn: "host=10.100.117.8 port=5433 user=aerolink password=<口令> dbname=kite sslmode=disable TimeZone=Asia/Shanghai"

# 密钥：留空时 chart 会随机生成 AEROLINK_ENCRYPT_KEY，并在升级时从既有 Secret 里复用；
# 只有在自管密钥（外部密钥存储）时才显式写。
# encryptKey: ""
```

```bash
helm install kite charts/kite -n kite-system --create-namespace -f values-postgres.yaml
```

要复用已有的 Secret（比如从清单版迁过来）就设 `secret.create: false` +
`secret.existingSecret: <名称>`，它必须包含 `JWT_SECRET`、`AEROLINK_ENCRYPT_KEY`、`DB_TYPE`、
`DB_DSN` 四个键，此时 `db.type` / `db.dsn` 被忽略。多副本用 chart 的 `replicaCount`，
并按 §2 重算 `max_connections` / 连接池。

### 4.3 裸进程 / systemd（现网形态）

现网是在宿主机上直接跑二进制，多副本用 systemd 模板单元 `deploy/aerolink@.service`：
实例号即端口（`aerolink@8081`、`8082`…），共享配置放 `/etc/aerolink/aerolink.env`（600）。
按 `deploy/aerolink.env.example` 抄一份，里面已经写好 PostgreSQL 版的 `DB_TYPE` / `DB_DSN` /
连接池 / 两个密钥 / `TRUSTED_PROXIES`。

```bash
sudo install -m 600 deploy/aerolink.env.example /etc/aerolink/aerolink.env
sudo vi /etc/aerolink/aerolink.env                 # 按 REPLACE-ME 改
sudo cp deploy/aerolink@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aerolink@8081      # 需要几个副本就起几个实例
```

- 数据库在容器里时单元文件已经 `After=docker.service`；连不上库进程会退出，
  `Restart=always` 会兜住重试。
- 反向代理（nginx）的网段必须写进 `TRUSTED_PROXIES`，否则服务端会信任所有
  `X-Forwarded-For`，审计日志里的来源 IP 可被伪造。

## 5. 首次部署与搬数据

`AutoMigrate` 只建表、不搬数据。搬历史数据用 `tools/dbmigrate`（独立的一次性拷贝器，
不进发布二进制）：

```bash
# 干跑：只读源库、打印行数对照，不动目标库
cd /wxh/aerolink
DB_TYPE=sqlite DB_DSN=dev.db \
  go run ./tools/dbmigrate -dry-run -target-type postgres -target-dsn '<目标 DSN>'

# 真搬
cd /wxh/aerolink
set -a; . /root/kite-secrets.env; set +a      # 带上与源库一致的 AEROLINK_ENCRYPT_KEY
DB_TYPE=sqlite DB_DSN=dev.db \
  go run ./tools/dbmigrate -target-type postgres -target-dsn '<目标 DSN>'
```

方向不限：`sqlite` / `mysql` / `postgres` 之间任意组合都能搬（`-source-type` /
`-source-dsn` 显式指定源）。**必须用与源库一致的 `AEROLINK_ENCRYPT_KEY`**：密钥不对会在
动目标库之前就解密失败并中止。

PostgreSQL 专属的一条：GORM 建的是 `bigserial`，显式插入 ID 不会推进序列，工具会逐表
`setval` 到 `max(id)`；漏了的话新建对象时主键会冲突（MySQL / SQLite 没这个问题，
所以从 MySQL 换过来时容易忽略）。

## 6. 校验清单（逐项对，不要只看能不能打开）

| 检查项 | 期望 |
| --- | --- |
| 各表行数 | 与源一致（拷贝器会打印对照表） |
| 登录 | 能登录，登录日志多出一条 |
| 权限 | 角色 / 权限绑定组条目数与源一致 |
| 集群 | 全部集群都能连上并**能拉取资源**（这一步同时验证 kubeconfig 解密成功） |
| MFA | 一个开了动态码的账号能正常验码（验证 `mfa_secret` 解密成功） |
| 通知 | SMTP / 通知设置页不报解密错误 |
| 新建数据 | 建一个角色或收藏，确认主键不冲突（验证序列已修好） |
| 时间 | 界面与审计日志的时间是本地时间（验证 DSN 里的 `TimeZone` 生效） |

启动日志里不该有 `AutoMigrate` 报错、解密报错，也不该有 `DB_DSN does not set TimeZone`
这条 warning。

## 7. 回滚

换库当天的回滚只有一个动作：把 `DB_DSN` 指回旧库、重启。所以**旧库在验证通过前不要删**。
切流到验证通过之间的新写入会留在新库里丢失，这个窗口要短，先别让同事用。

K8s 清单形态（改完 Secret 要重滚一次：`envFrom` 只在 Pod 重建时重新读取）：

```bash
kubectl -n aerolink edit secret aerolink-secret      # 改 POSTGRES_DSN
kubectl -n aerolink rollout restart deploy/aerolink
kubectl -n aerolink rollout status deploy/aerolink
```

## 8. PostgreSQL 特有的坑（遇到过或已知）

1. **`TimeZone` 漏写不报错**，只让时间整体偏移（见 §2）。
2. **`LIKE` 区分大小写**：用户搜索、审计日志检索在 PG 上是大小写敏感的（SQLite / MySQL
   默认不敏感），同一个关键词在换库前后结果可能不一样。
3. **并发登录会在 PG 服务端留下 ERROR 日志**：`user_sessions` 的会话序号用「先 INSERT、
   撞唯一键再重试 UPDATE」实现，8 个并发登录会产生 7 条
   `duplicate key value violates unique constraint "user_sessions_pkey"`。设计使然，
   但如果有基于 PG 错误日志的告警，这里是误报源。
4. **连接数**：见 §2 的公式，多副本时最容易打满 `max_connections`。
5. **排序规则随 glibc 漂移**：升级基础镜像/宿主机后按 §2 的两步处理。
6. **`pg_dump` / `psql` 也要占连接**，别把 `max_connections` 的余量吃到 0。

## 9. 为什么是 PostgreSQL（而不是 MySQL）

1. **不需要为旧版本做改动**：现网长期停在 PG 12，代码只用 PG 9.5 就有的语法，且有
   `pg_version_floor_test.go` 挡着不让新增写法抬高下限。
2. **没有时区二次换算的坑**：时间列上游刻意避开了 MySQL 的 `timestamp`（2038 上限 +
   会话时区换算）；MySQL 还要求驱动 `loc` 与服务器 `time_zone` 一致，不一致会出现
   「写进去一个时间、查出来另一个时间」。
3. **升级路径清晰**：12 系列内部换 minor 只换镜像 tag，不用 dump/restore；跨大版本用
   `tools/dbmigrate` 搬一遍即可（已实测 12.12 → 18.6）。

代价是多一条 §5 的「修序列」，且 `LIKE` 大小写敏感（§8.2）——两者都已明确、可处理。
