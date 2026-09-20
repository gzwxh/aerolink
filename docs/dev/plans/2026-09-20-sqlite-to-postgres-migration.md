# 方案：从 SQLite 切到 PostgreSQL（多副本前置条件）

- 状态：**拷贝工具已实现并实测**（sqlite → sqlite / PostgreSQL 各跑一遍，29 张表行数全部一致）；切流本身尚未执行
- 相关：`docs/dev/plans/2026-09-20-multi-replica-shared-state.md`（§0 前置条件就是这件事）
- 触发：单节点卡顿，要扩到多副本；SQLite 是单文件单写入者，两个进程同时写会互相锁死。

## 1. 现状（2026-09-20 实测，不是推测）

线上进程就在这台机器上（`10.100.117.8`）：

| 项 | 值 |
| --- | --- |
| 进程 | `./kite`，cwd `/wxh/kite`，监听 `*:8080`（pid 会随重启变，别照抄旧值，用 `pgrep -af '/kite'` 查） |
| 数据库 | `DB_TYPE` **未设置** → SQLite；`DB_DSN=dev.db` → `/wxh/kite/dev.db` |
| 数据量 | 27 张业务表 / users=142、clusters=3、roles=12、role_assignments=4、binding_groups=10、group_members=378、local_groups=25、login_records=114、notifications=764、resource_histories=170、password_histories=30、password_change_logs=25、binding_group_members=37、notification_templates=14、resource_templates=11，各设置表 1 行 |
| 空表 | `helm_repositories`、`o_auth_providers`、`notification_subscriptions`、`pending_sessions`、`scheduled_tasks`、`passkey_credentials` |

本机已有的候选目标（都是之前尝试留下的）：

| 容器 | 内容 | 结论 |
| --- | --- | --- |
| `kite-postgres`（postgres:18，bind `/data/postgresql`，`0.0.0.0:5432`） | `kite` 库 26 张表，但只有 users=1 / clusters=1 / login_records=1 / roles=4 / templates 若干 | **不是**线上数据，是一次试跑的残留；表结构可用 |
| `kubea-mysql`（mysql:8.4.11，`0.0.0.0:3306`） | `kite` 库 26 张表、**0 行** | 建过库但没用起来 |
| `test-mysql-target`（mysql:8.4.11，`0.0.0.0:3307`） | 另一个实验库 | 与本任务无关 |
| `kite-pg` 容器 | `./kite` + `DB_TYPE=postgres` + `PORT=8090`，Sep 18 启动，**未发布任何端口** | 上次尝试的孤儿（2026-09-20 复查已不在运行），占着 pg 连接 |

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

## 4. 搬数据：`tools/dbmigrate`（已实现、已实测）

`AutoMigrate` 只建表，不搬数据；本机 **没有 mysql/psql 客户端**，容器运行时是 distroless（连 shell 都没有），所以不能靠 `mysqldump` 那套。为此写了独立的一次性拷贝器：独立 `package main`（不进发布二进制，`make build` 只构建仓库根包）。

```sh
# 源库默认从环境变量 DB_TYPE / DB_DSN 取，也可用 -source-type / -source-dsn 显式指定；
# 目标库必须显式给出。
cd /wxh/kite
set -a; . /root/kite-secrets.env; set +a
DB_TYPE=sqlite DB_DSN=dev.db \
  go run ./tools/dbmigrate \
    -target-type postgres \
    -target-dsn 'host=127.0.0.1 user=kite password=<口令> dbname=kite port=5432 sslmode=disable TimeZone=Asia/Shanghai'
```

`-dry-run` 只读源库并打印行数对照，不建表也不写数据；`-batch-size` 默认 100。

**方向不限**：`sqlite` / `mysql` / `postgres` 之间任意组合都能搬（所以 MySQL → PostgreSQL 同样一条命令，只是换个 `-source-type` / `-source-dsn`）。工具只负责**建表 + 搬数据**，库和账号要事先建好；源库必须已经被当前版本的应用启动过（否则源库缺列，读取会直接报错）。

工具里那几条不是可选项（每条都有具体原因）：

1. **按 GORM 模型读写**，不用 `select *` + `insert map`。`pkg/model/model.go` 的 `Models()` 是唯一的表清单与顺序来源（`InitDB` 与工具共用），顺序即外键依赖顺序：父表在前插入、倒序清空。SQLite 里时间列存的是带 9 位小数和时区偏移的字符串（实测 `2026-09-15 12:34:16.465113793+08:00`），直接搬进 MySQL `datetime` 会报错或截断；走模型让 GORM 负责解析。
2. **写入时 `Session(&gorm.Session{SkipHooks: true})`。** `LoginRecord.AfterCreate` / `ResourceHistory.AfterCreate` 会往外部审计系统转发（`pkg/model/audit_forward.go`），搬历史数据不该触发它们。
3. **SecretString 列往返加解密。** 读时解密、写时重新加密（AES-GCM 随机 nonce，密文与源不同但同 key 可解）。密钥不对会**立刻解密失败**并中止，而且中止发生在**动目标库之前**（源库是先整表读进内存再写的），不会留下半成品目标库。因此拷贝器必须用与源相同的 `KITE_ENCRYPT_KEY` 运行。
4. **保持主键 ID 不变。**
5. **PostgreSQL 要补序列。** GORM 建的是 `bigserial`，显式插入 ID 不会推进序列；逐表 `setval` 到 `max(id)`，否则新建对象时主键冲突。MySQL 的 `AUTO_INCREMENT` 与 SQLite 的 rowid 会自己取 `max+1`，无需处理。
6. **每张表先清空目标表再插入**，整体幂等、可重复执行；目标 pg 库里那 1 个用户（id=1）不会和源库撞主键，不必依赖人工先建一张空库。
7. **拒绝「源库 == 目标库」。** 搬运会清空目标表，指错了就是把源数据删掉，因此在连接任何数据库之前就按 DSN 拦下（sqlite 按绝对路径比较，避免同一文件的不同写法被当成两个库）。
8. **不搬模型清单以外的表**（如历史残留的 `passkey_credentials`），但会在结束时显式告警列出。
9. **日志里的 DSN 会抹掉口令**，避免终端记录 / 截图留痕。

实测（2026-09-20）：`dev.db` → sqlite 临时库、→ PostgreSQL 18 各一遍，29 张表行数全部一致；时间列同一时刻（PG 精度截到微秒）、密文确实被重新加密、序列修正后不带 id 插入得到 `max+1`、审计钩子零触发。进 `go test` 的回归测试见 `tools/dbmigrate/main_test.go`。

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
# 1) 若孤儿容器 kite-pg 又起来了（docker ps | grep kite-pg），先停掉：它连着这张库跑 8090，会边搬边写
docker stop kite-pg 2>/dev/null || true

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
KITE_PID=$(pgrep -f '/kite$')
tr '\0' '\n' < /proc/$KITE_PID/environ | grep -E '^(KITE_ENCRYPT_KEY|JWT_SECRET)=' > /root/kite-secrets.env
chmod 600 /root/kite-secrets.env
```

把这两个值与要写进新启动环境的值逐字比对。**`KITE_ENCRYPT_KEY` 不一致时不要继续**——所有集群 kubeconfig、LDAP/OAuth/SMTP 密码、用户 MFA 密钥都解不开，而且新版代码在启动时会因为读不出 `JWTSecret` 直接拒绝启动（这是 `2026-09-18` 那轮修的 fail-closed 行为）。

### 5.4 搬数据

```sh
# kite 角色的原口令只存在于已停用的 kite-pg 容器的 DB_DSN 里，取不到了；
# 直接给它设一个新口令，下面 DSN 与切流后的 dev.env 都用这一个：
docker exec kite-postgres psql -U postgres -c "ALTER ROLE kite WITH PASSWORD '<新口令>'"
```

```sh
cd /wxh/kite
set -a; . /root/kite-secrets.env; . ./dev.env; set +a
DB_TYPE=sqlite DB_DSN=dev.db \
  go run ./tools/dbmigrate \
    -target-type postgres \
    -target-dsn 'host=127.0.0.1 user=kite password=<新口令> dbname=kite port=5432 sslmode=disable TimeZone=Asia/Shanghai'
```

想先不动库、只看会搬什么，加 `-dry-run`（只读源库 + 打印行数对照）。

拷贝器行为：连不上就退出；先对目标 `AutoMigrate`（建全表，含新加的 `user_sessions` / `login_attempts` / `mfa_pending_tickets`）→ 按表顺序搬 → 修序列 → 打印每张表源/目标行数对照。

### 5.5 切流

```sh
# 停旧进程（先确认 pgrep 出来的就是监听 8080 的那个）
kill -TERM $(pgrep -f '/kite$')

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

1. **`deploy/install-mysql.yaml` 里提交了真实凭据**：`JWT_SECRET` / `KITE_ENCRYPT_KEY` 是真实值（不是占位符），MySQL 用的是 `root` 直连 `10.100.117.8:3306` 且口令写在明文 DSN 里。
   —— **2026-09-20 已确认不处理**：仓库只在公司内网、且有权限管控，其他员工看不到，不按对外分发的口径要求。
2. **实验残留容器**：现在在跑的是 `kite-postgres`（5432）、`kubea-mysql`（空库，3306）、`gcloud-redis`（6379），另有两个已退出的匿名容器；先前记录的 `kite-pg`（8090）、`test-mysql-target`、`victoria-metrics` 2026-09-20 复查时已不在运行，只剩一个 kite 进程（8080）。搬库前建议 `docker ps` 对一遍，别照着旧记录去停一个不存在的容器/进程。
3. **线上是 `make run` 直接跑二进制**：没有进程守护（挂了不会自动拉起）、没有资源限制、日志只在终端。扩副本之前建议先把部署方式换成容器/K8s。
