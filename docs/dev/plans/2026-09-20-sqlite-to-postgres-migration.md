# 方案：从 SQLite 切到 PostgreSQL（多副本前置条件）

- 状态：**待评审**（已实测现状与目标库；拷贝工具与切流尚未执行）
- 相关：`docs/dev/plans/2026-09-20-multi-replica-shared-state.md`（§0 前置条件就是这件事）
- 触发：单节点卡顿，要扩到多副本；SQLite 是单文件单写入者，两个进程同时写会互相锁死。

## 1. 现状（2026-09-20 实测，不是推测）

线上进程就在这台机器上（`10.100.117.8`）：

| 项 | 值 |
| --- | --- |
| 进程 | `./kite`，pid `2342155`，cwd `/wxh/kite`，监听 `*:8080` |
| 数据库 | `DB_TYPE` **未设置** → SQLite；`DB_DSN=dev.db` → `/wxh/kite/dev.db` |
| 数据量 | 27 张业务表 / users=142、clusters=3、roles=12、role_assignments=4、binding_groups=10、group_members=378、local_groups=25、login_records=114、notifications=764、resource_histories=170、password_histories=30、password_change_logs=25、binding_group_members=37、notification_templates=14、resource_templates=11，各设置表 1 行 |
| 空表 | `helm_repositories`、`o_auth_providers`、`notification_subscriptions`、`pending_sessions`、`scheduled_tasks`、`passkey_credentials` |

本机已有的候选目标（都是之前尝试留下的）：

| 容器 | 内容 | 结论 |
| --- | --- | --- |
| `kite-postgres`（postgres:18，bind `/data/postgresql`，`0.0.0.0:5432`） | `kite` 库 26 张表，但只有 users=1 / clusters=1 / login_records=1 / roles=4 / templates 若干 | **不是**线上数据，是一次试跑的残留；表结构可用 |
| `kubea-mysql`（mysql:8.4.11，`0.0.0.0:3306`） | `kite` 库 26 张表、**0 行** | 建过库但没用起来 |
| `test-mysql-target`（mysql:8.4.11，`0.0.0.0:3307`） | 另一个实验库 | 与本任务无关 |
| `kite-pg` 容器 | `./kite` + `DB_TYPE=postgres` + `PORT=8090`，Sep 18 启动，**未发布任何端口** | 上次尝试的孤儿，占着 pg 连接 |

## 2. 选 PostgreSQL（建议）

理由（按重要性）：

1. 本机已经有可用的 `kite-postgres`（18）和 `kite` 库，账号密码 DSN 现成，**不需要新建数据库**。
2. 表结构已经由 kite 自己 `AutoMigrate` 建过一遍，说明这条路径在本机验证过能起来。
3. MySQL 这条路上有两个额外的坑：驱动 `loc` 必须与服务器 `time_zone` 一致（`pkg/model/model.go` 里 `mysqlDSNDefaults` 的注释专门写了这点，不一致会出现「写进去一个时间、查出来另一个时间」）；而且那个空库已经有 26 张表，得先 drop 重建。
4. 时间列上游也刻意避开了 MySQL 的 `timestamp`（2038 上限 + 会话时区二次换算，见 `pkg/model/user.go` 的注释），说明 pg 更贴合现有写法。

若要选 MySQL，除 §4 的时区项和「先 drop 重建空库」外，步骤与下面完全一样。

## 3. 配置面：不用改代码

切换完全靠环境变量，`pkg/common/common.go` 的 `loadDatabaseEnvs` 已经全部支持：

| 变量 | 目标值（PostgreSQL） | 说明 |
| --- | --- | --- |
| `DB_TYPE` | `postgres` | 不设 = sqlite |
| `DB_DSN` | `host=127.0.0.1 user=kite password=<pwd> dbname=kite port=5432 sslmode=disable TimeZone=Asia/Shanghai` | `TimeZone` 与写入时区必须一致 |
| `KITE_DB_MAX_OPEN_CONNS` | 单副本先留 100；扩副本前按「副本数 × 单副本额度 ≤ pg `max_connections`」重算 | 默认 100 |
| `KITE_DB_MAX_IDLE_CONNS` | 10（默认） | |
| `KITE_DB_CONN_MAX_LIFETIME_MINUTES` | 10（默认） | |
| `KITE_ENCRYPT_KEY` | **必须与线上现在用的完全一致** | 详见 §5.3 |
| `JWT_SECRET` | **必须与线上现在用的完全一致** | 变了等于所有人被登出 |

本机启动方式就是 `dev.env` + `make run`（或直接 `./kite`），所以切换 = 改 `dev.env` 里的 `DB_DSN` / 加 `DB_TYPE`，然后重启进程。

K8s 部署侧现成的两份清单（`deploy/install.yaml` 是 SQLite 版、`deploy/install-mysql.yaml` 是 MySQL 版）与 `charts/kite` 的 `db.type` / `db.dsn` 都已经是参数化的，切过去只需改 values。**本轮本机切库用不到它们。**

## 4. 缺失的一环：谁来搬数据

`AutoMigrate` 只建表，不搬数据。而本机 **没有 mysql/psql 客户端**，容器运行时是 distroless（连 shell 都没有），所以不能靠 `mysqldump` 那套。可选做法：

| 做法 | 评价 |
| --- | --- |
| 装客户端 + sqlite3 dump 转 SQL | 27 张表类型/引号/时间格式都要手改，易错且难复现 |
| **写一次性 Go 拷贝器（建议）** | 复用仓库已 vendored 的 `glebarez/sqlite` + `gorm.io/driver/postgres`/`mysql`，类型转换交给 GORM，可重复执行、可校验 |

建议落点：`tools/dbmigrate/main.go`（独立 `package main`，`go run ./tools/dbmigrate` 运行，不进发布二进制）。

拷贝器必须遵守的几条（每条都有具体原因）：

1. **按 GORM 模型读写，不用 `select *` + `insert map`。** SQLite 里时间列存的是带 9 位小数和时区偏移的字符串（实测 `2026-09-15 12:34:16.465113793+08:00`），直接搬进 MySQL `datetime` 会报错或截断；走模型让 GORM 负责解析。
2. **写入时 `Session(&gorm.Session{SkipHooks: true})`。** `LoginRecord.AfterCreate` / `ResourceHistory.AfterCreate` 会往外部审计系统转发（`pkg/model/audit_forward.go`），搬历史数据不该触发它们。
3. **SecretString 列往返加解密。** 读时用 `common.KiteEncryptKey` 解密、写时重新加密（AES-GCM 随机 nonce，密文与源不同但同 key 可解）。副作用是密钥不对会**立刻解密失败报错**，属于 fail-closed，比静默搬一堆解不开的密文好。因此拷贝器必须用与源相同的 `KITE_ENCRYPT_KEY` 运行。
4. **保持主键 ID 不变**，并按外键顺序插入（users → roles → role_assignments → binding_groups → …）。
5. **PostgreSQL 要补序列。** GORM 建的是 `bigserial`，显式插入 ID 不会推进序列；逐表 `SELECT setval(pg_get_serial_sequence('<table>','id'), max(id))`，否则新建对象时主键冲突。MySQL 的 `AUTO_INCREMENT` 会自动取 `max+1`，无需处理。
6. **跳过 `passkey_credentials`。** 源库里有这张空表，但模型列表里没有对应类型（`pkg/model/model.go` 的 `models` 切片），代码里也没有引用 —— 是历史残留，不迁。
7. **每张表先清空目标表再插入，整体幂等、可重复执行。** 目标 pg 库里那 1 个用户（id=1）会和源库的 id=1 撞主键，重跑时也会撞；工具自己负责 `DELETE FROM`，就不必依赖人工先建一张空库。

## 5. 步骤

### 5.1 备份

```sh
cd /wxh/kite
mkdir -p /data/backup
sqlite3 dev.db ".backup /data/backup/dev.db.$(date +%F-%H%M)"
```

`.backup` 是在线备份，不会因为进程正在写而拿到半截文件。**切流验证通过前不要删原文件。**
（`/data` 剩 689G，两个备份加起来不到 2MB，不用先清空间。）

### 5.2 准备目标库

本机复用 `kite-postgres` 里那张只有试跑数据的 `kite` 库，三件事：

```sh
# 1) 停掉孤儿容器 kite-pg：它正连着这张库跑 8090，不停掉会边搬边写
docker stop kite-pg

# 2) 先把这张试跑库导出来留底（万一里面那 1 个用户/4 个角色是手工配的）
docker exec kite-postgres pg_dump -U kite -d kite > /data/backup/pg-kite-before.$(date +%F-%H%M).sql
```

超级用户是 `postgres`（实测：`kite` 这个账号 `rolsuper/rolcreatedb/rolcreaterole` 全是 `f`，**建不了库**，
口令在容器环境变量 `POSTGRES_PASSWORD` 里）。要整库重建就用它：

```sh
PGPW=$(docker inspect kite-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
docker exec -e PGPASSWORD="$PGPW" kite-postgres psql -U postgres -d postgres \
  -c 'DROP DATABASE kite;' -c 'CREATE DATABASE kite;' -c 'ALTER DATABASE kite OWNER TO kite;'
```

（可选。§4 第 7 条已经让拷贝器自己清空目标表，所以不做这步也能搬；做它的好处是
连带清掉可能的结构漂移，代价是那 26 张表由 AutoMigrate 重建。）

### 5.3 确认两个密钥

```sh
tr '\0' '\n' < /proc/2342155/environ | grep -E '^(KITE_ENCRYPT_KEY|JWT_SECRET)=' > /root/kite-secrets.env
chmod 600 /root/kite-secrets.env
```

把这两个值与要写进新启动环境的值逐字比对。**`KITE_ENCRYPT_KEY` 不一致时不要继续**——所有集群 kubeconfig、LDAP/OAuth/SMTP 密码、用户 MFA 密钥都解不开，而且新版代码在启动时会因为读不出 `JWTSecret` 直接拒绝启动（这是 `2026-09-18` 那轮修的 fail-closed 行为）。

### 5.4 搬数据

```sh
PG_DSN=$(docker inspect kite-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DB_DSN=//p')
echo "$PG_DSN"   # 链接串里的 password= 就是 kite 账号口令（kite-postgres 与 kite-pg 用的是同一份）
```

```sh
cd /wxh/kite
set -a; . /root/kite-secrets.env; . ./dev.env; set +a
DB_TYPE=sqlite DB_DSN=dev.db \
  go run ./tools/dbmigrate \
    -target-type postgres \
    -target-dsn 'host=127.0.0.1 user=kite password=<上面的口令> dbname=kite port=5432 sslmode=disable TimeZone=Asia/Shanghai'
```

拷贝器行为：连不上就退出；先对目标 `AutoMigrate`（建全表，含新加的 `user_sessions` / `login_attempts` / `mfa_pending_tickets`）→ 按表顺序搬 → 修序列 → 打印每张表源/目标行数对照。

### 5.5 切流

```sh
# 停旧进程（先确认 pid 还是那个）
kill -TERM 2342155

# 改 dev.env：DB_TYPE=postgres、DB_DSN=<上面的 DSN>
# 启动新进程，观察日志里没有 AutoMigrate / 解密相关报错
make run
```

### 5.6 校验（逐项对，不要只看能打开）

```sh
sqlite3 dev.db "select count(*) from users;"     # 142
docker exec kite-postgres psql -U kite -d kite -c "select count(*) from users;"
```

| 检查项 | 期望 |
| --- | --- |
| 各表行数 | 与源一致（拷贝器会打印对照表） |
| 登录 | 能登录，登录日志多出一条 |
| 权限 | 角色 / 权限绑定组页面的条目数与源一致（roles=12、binding_groups=10） |
| 集群 | 3 个集群都能连上，**能拉取资源**（这一步验证 kubeconfig 解密成功，即密钥对了） |
| MFA | 一个开了动态码的账号能正常验码（验证 `mfa_secret` 解密成功） |
| 通知 | SMTP / 通知设置页不报解密错误 |
| 新建数据 | 建一个角色或收藏，确认主键不冲突（验证序列已修好） |

### 5.7 回滚

一句话：把 `dev.env` 改回 `DB_DSN=dev.db`、去掉 `DB_TYPE`，重启即可 —— 因为**旧库一直没动过**。切流后到验证通过前的所有新写入会留在 pg 里丢失，所以这个窗口要短，并且切流后先别让同事用。

## 6. 之后才谈扩副本

切到 pg 之后，多副本的三个共享状态（会话序号、登录失败计数、安全设置缓存）在 `2026-09-20-multi-replica-shared-state.md` 里已经处理完并入库。扩副本时还要注意：

- **连接池总量** = 副本数 × `KITE_DB_MAX_OPEN_CONNS`，别超过 pg 的 `max_connections`。
- **每个副本各持一份 K8s informer 缓存**，监听 apiserver 的流量按副本数放大——这本来就是「卡顿」的怀疑来源之一，扩容前后建议对比一次。
- 静态前端资源由 Go 二进制内嵌，多副本不需要共享文件系统；本机这种「直接跑二进制」的部署要扩副本，得先换成 K8s 或至少 docker compose。

## 7. 顺带发现，建议单独处理

1. **`deploy/install-mysql.yaml` 里提交了真实凭据**：`JWT_SECRET` / `KITE_ENCRYPT_KEY` 是真实值（不是占位符），MySQL 用的是 `root` 直连 `10.100.117.8:3306` 且口令写在明文 DSN 里。这个文件一旦离开内网就是完整凭据泄露（含数据库 root）。建议：改成占位符 + `existingSecret`（chart 已经支持这个字段），并给 kite 建专用库账号而不是 root。换 `KITE_ENCRYPT_KEY` 需要重新保存所有凭据，要单独排期，不要混在这次切库里做。
2. **实验残留容器**：`kite-pg`（孤儿，8090 上跑旧版）、`kubea-mysql`（空库）、`test-mysql-target`、`victoria-metrics`、`gcloud-redis` 都在占端口/内存。本机同时跑着两个 kite 进程（另一个在 8090），排查线上问题时容易连错，建议清理或至少明确标注。
3. **线上是 `make run` 直接跑二进制**：没有进程守护（挂了不会自动拉起）、没有资源限制、日志只在终端。扩副本之前建议先把部署方式换成容器/K8s。
