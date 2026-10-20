# 部署与运维

本页是安装之后的运维面：部署形态怎么选、裸进程怎么跑、升级与回滚怎么做、备份什么、怎么换库。首次安装见[安装指南](./installation.md)；数据库的建库与容量清单见[数据库准备](../config/database.md)。

## 部署形态

仓库里备了五种形态，按「谁来管生命周期」挑一种即可，不要混用：

| 形态 | 产物 | 适合 |
| --- | --- | --- |
| Helm Chart | `charts/aerolink` | 常规 K8s 部署，需要持久化与配置模板化 |
| K8s 原生清单 | `deploy/install.yaml`（SQLite）、`deploy/install-mysql.yaml`、`deploy/install-postgres.yaml` | 不能用 Helm 的集群；直接 `kubectl apply` 起飞 |
| Docker Compose（生产） | `deploy/docker-compose.yaml` | 单机容器部署 |
| Docker Compose（联调） | `deploy/docker-compose.local.yaml` + `deploy/config.yaml` | 本机试跑，含 bundled Postgres / rustfs |
| 裸进程 + systemd | `deploy/aerolink@.service` + `deploy/aerolink.env.example` + `deploy/nginx-aerolink.conf` | **现网形态**：宿主机直跑二进制，多副本靠模板单元 |

三个原生清单的共同点：绑定 `cluster-admin` 的 ClusterRoleBinding（控制台要管全集群，内网使用）、`livenessProbe` 与 `readinessProbe` 都探 `/healthz`、资源 requests `100m/128Mi`、limits `1000m/512Mi`、镜像默认指向内网 SWR。差异在命名空间与数据库：

| 清单 | 命名空间 | 数据库 |
| --- | --- | --- |
| `install.yaml` | `kube-system` | SQLite（不设 `DB_TYPE` / `DB_DSN`，用默认值） |
| `install-mysql.yaml` | `aerolink` | 显式给 `DB_TYPE` / `DB_DSN`，并写了滚动更新策略 |
| `install-postgres.yaml` | `aerolink` | 同上，面向 PostgreSQL |

三个清单里的卷都**默认注释掉**：`emptyDir` 只在 Pod 生命周期内保留，审计归档与日志要跨重建保留就必须换成 PVC。容器镜像默认是 distroless（uid `65532`），里面没有 `curl`/`wget`，所以 compose 里没有 healthcheck——需要的话用 Dockerfile 的 `RUNTIME_IMAGE` 参数换成带工具的基座再加。

## 裸进程（systemd）

现网是在宿主机上直接跑二进制，多副本用 systemd 模板单元，**实例号就是端口**：

```bash
sudo install -m 600 deploy/aerolink.env.example /etc/aerolink/aerolink.env
sudo vi /etc/aerolink/aerolink.env                  # 按 REPLACE-ME 逐项改
sudo cp deploy/aerolink@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aerolink@8081           # 要几个副本就起几个实例：8081、8082…
```

配置集中在 `/etc/aerolink/aerolink.env`（权限 600），所有副本读同一份，只有 `PORT` 由实例号给出。样例里已经写好 PostgreSQL 版的 `DB_TYPE` / `DB_DSN` / 连接池 / 两个密钥 / `TRUSTED_PROXIES`，四类值必须自己定：

| 项 | 为什么必须改 |
| --- | --- |
| `DB_DSN` 里的 `TimeZone` | 漏写不报错，界面与审计日志的时间整体偏移 |
| `AEROLINK_DB_MAX_OPEN_CONNS` | 上限是**每个副本**的，要按[容量公式](../config/database.md#连接池与容量)核对 `max_connections` |
| `AEROLINK_ENCRYPT_KEY` / `JWT_SECRET` | 必须与既有数据库配套，且所有副本一致 |
| `TRUSTED_PROXIES` | 入口是宿主机 nginx，必须写清网段；不写时服务端会信任所有 `X-Forwarded-For`，**审计日志里的来源 IP 可被伪造** |

两条容易忽略的：单元文件已经 `After=docker.service`（数据库跑在容器里时）；连不上数据库进程会退出，靠 `Restart=always` 兜住重试——所以「服务起不来」先看 env 里的 DSN，而不是先怀疑单元文件。反向代理配置参考 `deploy/nginx-aerolink.conf`。

## 运行参数与探测端点

| 项 | 值 |
| --- | --- |
| 监听地址 | `:PORT`，默认 `8080`。注意 `HOST` 变量**不参与监听**，它只用于生成 OAuth 回调地址 |
| HTTP 超时 | 请求头读取 10 秒、空闲 120 秒；收到 SIGTERM 后最多等 5 秒让在途请求收尾 |
| 上传上限 | 512 MiB（Pod 文件上传经 `MaxBytesReader` 限制） |
| 健康检查 | `GET /healthz` → `200 {"status":"ok"}`，不进访问日志与指标 |
| 版本 | `GET /api/v1/version` |
| 指标 | `GET /metrics`；设置 `AEROLINK_METRICS_TOKEN` 后需要 Bearer Token，未设置则**无认证暴露**并打告警 |
| 性能剖析 | `AEROLINK_ENABLE_PPROF=true` 时在 `localhost:6060` 开 pprof（堆转储可能含敏感信息，默认关闭） |

没有 `/readyz` 或 `/livez`，探针就用 `/healthz`。

日志有两处：`AEROLINK_LOG_FILE` 设置后系统日志（klog）只写文件，**stderr 只剩 ERROR 及以上**——排障时别只看 `journalctl`，业务日志在文件里；审计日志与访问日志是另一套（见[审计与合规](../features/audit-and-compliance.md)）。

## 启动顺序与失败行为

知道哪些失败会拒绝启动，能省掉大量排障时间：

| 阶段 | 失败后的行为 |
| --- | --- |
| 读密钥：缺 `AEROLINK_ENCRYPT_KEY`，或 `JWT_SECRET` 短于 32 字节 | **拒绝启动**（除非开发用的 `AEROLINK_ALLOW_INSECURE_SECRETS=true`） |
| 连接数据库、执行迁移 | 连库失败直接 panic |
| 校验 JWT 密钥是否仍是内置默认值 | **拒绝启动** |
| 应用配置文件（`AEROLINK_CONFIG_FILE`） | 文件读取失败 **拒绝启动**；各段落应用失败**仅告警继续** |
| 校验审计 sink 与归档目录 | 非法取值或前置条件不满足 **拒绝启动**（fail-closed，不静默回落） |
| 建超管、导入集群、通知模板、RBAC 同步、配置监听 | 失败仅告警，服务继续启动 |
| 监听端口 | 端口被占用则退出 |

**配置文件里的 `clusters` 段会覆盖库里的集群列表**（应用时先清空再插入），所以别把一次性的引导配置长期留在 `AEROLINK_CONFIG_FILE` 指向的文件里。另外设置了 `AEROLINK_CONFIG_FILE` 之后程序**不再走环境变量路径**：`KUBECONFIG` 自动导入与用 `AEROLINK_USERNAME`/`AEROLINK_PASSWORD` 建超管都失效，超管要写进配置文件的 `superUser` 段。三条语义详见[配置文件](../config/config-file.md)。

## 多副本

多副本不是「多起几个进程」那么简单，四条硬约束：

- **必须共享同一个数据库**：SQLite 是单文件、单写入者，多副本必须换 MySQL 或 PostgreSQL。会话、登录失败计数、选主租约（周期性全局任务同时只由一个副本执行）都在库里。
- **`AEROLINK_AUDIT_SINK` 每份配置必须同值**：它在启动时决定、运行期不改；只改库里的值会被忽略并告警。
- **入口不要做会话粘性假设**：会话状态最长滞后约 60 秒，被顶下线、单设备登录这类判定会有这个量级的延迟。
- **设置变更最长 30 秒传播到全部副本**：安全策略、审计设置这类改动保存后立刻刷新本副本，其它副本按周期重载。改完策略立刻验证时，要留意这一点。

`AEROLINK_ENCRYPT_KEY` 与 `JWT_SECRET` 在所有副本上必须一致：前者不一致会让凭据解密结果随副本不同，后者不一致会让请求被判定为未登录并在副本间来回跳。

## 升级

二进制与镜像是整体替换，数据库结构变更要单独执行。完整顺序：

1. **备份**：数据库 dump + 两个密钥 + 归档目录（见下一节）。这一步不要跳过——库结构变更没有自动回退。
2. **读发布说明里的升级 SQL**：`pkg/model/` 有改动时，发布说明会单列一节给出升级前要执行的 SQL（三种数据库的等价写法）。**先执行 SQL，再换二进制**。
3. **替换产物**：裸进程换二进制；K8s 改 image tag（Helm 用 `helm upgrade`，用清单的改 `Deployment` 的镜像）。
4. **重启**：裸进程 `systemctl restart aerolink@8081 ...`；K8s 必须**显式滚动重启**——`envFrom` 只在 Pod 重建时重新读取 Secret：

   ```bash
   kubectl -n aerolink edit secret aerolink-secret      # 改了密钥/DSN 才需要
   kubectl -n aerolink rollout restart deploy/aerolink
   kubectl -n aerolink rollout status deploy/aerolink
   ```

5. **核对**：日志里找 `checkSchema` 的结论（`库结构与模型一致` 表示结构齐了；有差异记录说明某条 SQL 漏了），再看 `GET /api/v1/version` 确认版本，最后抽查登录与一个集群的资源拉取。

PostgreSQL 自身的大版本升级（12 → 14/16/18 等）是另一件事，见[数据库准备](../config/database.md#postgresql-大版本升级)。

## 回滚

回滚分两层，能不能回退取决于「库结构变更是否可逆」：

| 场景 | 动作 |
| --- | --- |
| 只是换了二进制 / 镜像 | 换回上一个 tag 或二进制，重启 |
| 换了数据库（DSN 指向新库） | **把 `DB_DSN` 指回旧库** + 旧二进制，重启即可。所以旧库在验证通过前不要删 |
| Helm 部署 | `helm rollback <release> <revision>` |
| systemd 多副本 | 停掉新起的实例（`systemctl disable --now aerolink@8082`），留一个旧版本实例 |
| 库结构变更后想回退 | 没有自动回退：升级 SQL 不是双向的。真要退，只能从升级前的 dump 恢复，**切换窗口之后的新数据会丢** |

因此换库或结构变更的窗口要短：切流到验证通过之间，同事在新库上的写入，回滚时会消失。验证清单见[换库](#更换数据库)。

## 备份与恢复

### 备份什么

| 内容 | 位置 / 说明 |
| --- | --- |
| 数据库 | PostgreSQL 用 `pg_dump`；SQLite 用 `.backup`；MySQL 用 `mysqldump` 或 XtraBackup（按你们的 DBA 口径） |
| `AEROLINK_ENCRYPT_KEY` | 库里的 kubeconfig、LDAP / OAuth / SMTP 口令、AI Key、MFA 密钥全靠它解密。**丢了等于全部凭据作废** |
| `JWT_SECRET` | 丢了等于所有人被登出（但可重新签发） |
| 归档与日志目录 | `AEROLINK_AUDIT_ARCHIVE_DIR` 的 parquet 归档、`/home/aerolink/data` 下的 klog 日志——审计检索要用 |
| 配置文件 | `/etc/aerolink/aerolink.env` 与 `AEROLINK_CONFIG_FILE` 指向的文件 |

数据库和两个密钥必须**同一批次备份**：只恢复库、密钥用旧值，会出现「库里的密文解不开」；只备份密钥、库回退到更早的时间点，则更早的凭据能用、之后新增的用不了。

### 命令

```bash
# PostgreSQL：逻辑备份（体积小、跨版本可恢复）
pg_dump -h 127.0.0.1 -p 5433 -U aerolink -d aerolink -Fc -f /data/backup/aerolink-$(date +%F-%H%M).dump

# SQLite：在线备份（不会拿到写了一半的文件，不要直接 cp 正在使用的库）
sqlite3 /home/aerolink/db/aerolink.db ".backup /data/backup/aerolink.db.$(date +%F-%H%M)"
```

恢复用 `pg_restore`（对 `-Fc` 格式）或换回 SQLite 文件，然后按现有密钥启动。仓库里**没有自带的备份脚本或定时任务**，把上面的命令挂到 cron / systemd timer 上，并定期真的恢复一次——没有验证过的备份等于没有备份。

时间段选择上，`pg_dump` 会占一条数据库连接、并在库上产生读负载，别和批量运维高峰撞在一起；连接池余量不足时它会直接失败。

## 更换数据库

从 SQLite（或 MySQL）换到 PostgreSQL 用仓库自带的 `tools/dbmigrate`——一次性拷贝器，独立 `package main`，**不进发布二进制**。整体顺序：

1. **备份源库**，并确认两个密钥的值（用与源库一致的 `AEROLINK_ENCRYPT_KEY`）。
2. **在目标库建好库与账号**（见[数据库准备](../config/database.md#建库与账号)），确认排序规则与编码符合要求。
3. **干跑**：只读源库、打印逐表行数对照，不动目标库。

   ```bash
   cd /wxh/aerolink
   DB_TYPE=sqlite DB_DSN=dev.db \
     go run ./tools/dbmigrate -dry-run -target-type postgres -target-dsn '<目标 DSN>'
   ```

4. **真搬**：

   ```bash
   set -a; . /root/aerolink-secrets.env; set +a      # 带上与源库一致的 AEROLINK_ENCRYPT_KEY
   DB_TYPE=sqlite DB_DSN=dev.db \
     go run ./tools/dbmigrate -target-type postgres -target-dsn '<目标 DSN>'
   ```

   方向不限：`sqlite` / `mysql` / `postgres` 任意组合都能搬，源库用 `-source-type` / `-source-dsn` 显式指定；`-batch-size` 默认 100。**密钥不对会在动目标库之前就解密失败并中止**，这是刻意的保护。
5. **停旧进程、改 DSN、切流**（`kill -TERM` 或 `systemctl stop`，改 env 里的 `DB_TYPE` / `DB_DSN`，再启动）。搬数据期间不要让源库继续被写入：容器形态先 `docker stop` 掉源库容器，避免边搬边写。
6. **校验**，见下表。
7. **确认或回滚**：验证通过前保留旧库（含旧 SQLite 文件），回滚就是把 DSN 指回去。

### 校验清单

| 检查项 | 期望 |
| --- | --- |
| 各表行数 | 与源一致（拷贝器会打印对照表） |
| 登录 | 能登录，登录日志多出一条 |
| 权限 | 角色 / 权限绑定组条目数与源一致 |
| 集群 | 全部集群都能连上并**能拉取资源**（同时验证 kubeconfig 解密成功） |
| MFA | 一个开了动态码的账号能正常验码（验证 `mfa_secret` 解密成功） |
| 通知 | SMTP 与通知设置页不报解密错误 |
| 新建数据 | 建一个角色或收藏，确认主键不冲突（验证序列已修好） |
| 时间 | 界面与审计日志的时间是本地时间（验证 DSN 里的 `TimeZone` 生效） |

启动日志里不该有 `AutoMigrate` 报错、不该有解密报错，也不该有 `DB_DSN does not set TimeZone` 这条 warning。

### 已知的坑

| 现象 | 原因与处理 |
| --- | --- |
| 新建对象主键冲突 | PostgreSQL 的 `bigserial` 在显式插入 ID 时不推进序列。`tools/dbmigrate` 会逐表 `setval` 到 `max(id)`，自己写脚本搬数据时必须补这一步；MySQL / SQLite 没这个问题，从 MySQL 换过来时最容易忽略 |
| 时间偏移 | DSN 漏写 `TimeZone` / `loc` |
| 同一个关键词搜出来的结果变了 | PostgreSQL 的 `LIKE` 区分大小写，SQLite / MySQL 默认不区分 |
| 启动日志出现 `duplicate key ... user_sessions_pkey` | 并发登录时会话 UPSERT 的竞态，属设计使然，不是数据损坏 |
| 源库读取报缺列 | 源库必须**被当前版本的 AeroLink 启动过**（即迁移跑过），否则拷贝器读不到新列 |
| 目标库里多出测试数据 | 干跑只看行数不动库；真搬前确认目标库是空的或可覆盖的 |

## 排障速查

| 症状 | 先看哪里 |
| --- | --- |
| 服务起不来 | `/etc/aerolink/aerolink.env` 里的密钥与 DSN；密钥缺失/JWT 哨兵/审计 sink 非法都会直接拒绝启动 |
| 界面时间不对（差 8 小时） | DSN 的 `TimeZone`；MySQL 还有 `loc` |
| 端口被占用 | `PORT` 与 systemd 实例号冲突（实例号即端口） |
| 日志里只有 ERROR | `AEROLINK_LOG_FILE` 已生效：完整日志在文件里，stderr 只留 ERROR 及以上 |
| 资源页偶发连接失败 | 连接池与 `max_connections` 的容量公式；空闲连接也占坑 |
| 多副本行为不一致 | 各副本的 `AEROLINK_AUDIT_SINK`、两个密钥是否一致；设置变更是否已过 30 秒 |
| 审计日志里的来源 IP 是代理地址或可被伪造 | `TRUSTED_PROXIES` 未覆盖反代网段 |
| 用户被自动登出 | 会话策略（空闲 600 分钟、最长 24 小时、关闭浏览器失效），见[安全策略](../config/security-policy.md) |

镜像怎么构建与推送见[构建并推送镜像](./build-and-push-image.md)；环境变量全集见[环境变量](../config/env.md)；Chart 的 values 见 [Chart 配置](../config/chart-values.md)。