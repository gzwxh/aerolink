# 环境变量

鸢联 AeroLink 默认支持一些环境变量，来改变一些配置项的默认值。

注意：**改名前的 `KITE_*` 变量名已不再被读取**（改为 `AEROLINK_*` 时是硬切，没有兼容兜底）。
已有部署请把清单 / Secret / env 文件里的变量名全部换掉，否则相关配置会当作未设置。

- **AEROLINK_CONFIG_FILE**：配置文件路径。该功能仅适用于鸢联 AeroLink `v0.10.0` 及以上版本。设置后，鸢联 AeroLink 从该文件加载集群、OAuth、LDAP、RBAC 和超级用户设置。详见[配置文件](../config/config-file.md)。
- **AEROLINK_USERNAME**：兼容旧配置的超级用户名环境变量。仅在未设置 `AEROLINK_CONFIG_FILE` 时，用于环境变量到数据库配置的迁移。
- **AEROLINK_PASSWORD**：兼容旧配置的超级用户密码环境变量。仅在未设置 `AEROLINK_CONFIG_FILE` 时，用于环境变量到数据库配置的迁移。
- **KUBECONFIG**：兼容旧配置的 kubeconfig 环境变量。仅在未设置 `AEROLINK_CONFIG_FILE` 时读取并导入集群配置。
- **ANONYMOUS_USER_ENABLED**：启用匿名用户访问，默认值为 `false`，当启用后所有访问将不再需要身份验证，并且默认拥有最高权限。

- **JWT_SECRET**：用于签名和验证 JWT 的密钥。未设置时首次启动会自动生成随机密钥并保存到数据库；设置时长度不得少于 32 字节。
- **AEROLINK_ENCRYPT_KEY**：用于加密敏感数据的密钥, 例如用户密码，OAuth 的 clientSecret ，kubeconfig 等。**必填**：未设置时服务拒绝启动（除非 `AEROLINK_ALLOW_INSECURE_SECRETS=true`）。更换该密钥会导致已保存的凭据无法解密，轮换后需重新保存全部凭据。
- **AEROLINK_REQUIRE_ENCRYPT_KEY**：设置为 `true` 时，即使开启 `AEROLINK_ALLOW_INSECURE_SECRETS` 也必须设置 `AEROLINK_ENCRYPT_KEY`。
- **AEROLINK_ALLOW_INSECURE_SECRETS**：仅限本地开发的逃生开关（`true`/`false`），允许使用内置默认密钥和较短的 JWT 密钥，生产环境禁止开启。

## 凭据传输加密

口令、动态码、改密/重置口令、kubeconfig 与 Secret 内容这类字段在**浏览器侧**先用服务端公钥加密，
再随请求体上行，服务端用私钥解开。目的是让明文凭据不出现在访问日志、抓包和代理日志里——**它不能
替代 HTTPS**（中间人仍可重放合法密文、篡改响应），HTTPS 仍是部署侧必做项。

- **AEROLINK_TRANSPORT_KEY_PATH**：传输密钥（RSA 私钥，PEM）的路径，默认 `data/transport-key.pem`
  （相对进程工作目录，官方镜像为 `/home/aerolink/data/transport-key.pem`）。文件不存在时自动生成
  （权限 `0600`）。**多副本必须让所有副本读到同一份私钥**（共享卷，或改用下面的变量从 Secret 注入），
  否则请求落到别的副本会解不开，表现为随机出现的 `400 credential_decrypt_failed`。
- **AEROLINK_TRANSPORT_PRIVATE_KEY**：直接以 PEM 文本注入私钥，便于从 Secret 挂载，优先于
  `AEROLINK_TRANSPORT_KEY_PATH`。
- **AEROLINK_REQUIRE_ENCRYPTED_CREDENTIALS**：设为 `true` 后**只接受密文凭据**：上述字段若以明文提交，
  一律返回 `400`，响应体 `code` 为 `encrypted_credential_required`。默认 `false`（明文、密文都接受），
  以兼容旧页面与自建脚本。

开启前的确认项：浏览器里没有还开着上一版页面（前端产物随二进制发布，但标签页可能是旧的），自建脚本
已改用密文。滚动升级期间开启会让旧页面登录失败。开启后若仍看到 `encrypted_credential_required`，
先查客户端有没有成功取到 `/api/v1/transport-key`（多副本私钥是否一致、反向代理是否拦截），不要先去
关开关。

- **HOST**: 用户 OAuth 2.0 授权回调地址生成，默认会从请求头获取，如果您发现结果不及预期可以手动配置此环境变量。

- **TRUSTED_PROXIES**：以逗号分隔的反向代理、Ingress 或负载均衡器 IP/CIDR 列表；只有这些直连鸢联 AeroLink 的上一跳才会被信任，鸢联 AeroLink 才会读取其转发的 `X-Forwarded-For` / `X-Real-IP` 来判断客户端 IP。默认信任本地和常见私网网段（`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`::1`、`fc00::/7`），方便常见 Ingress 部署拿到真实用户 IP。生产环境建议配置为更窄的范围，例如 `TRUSTED_PROXIES=10.42.0.0/16,192.168.1.10`；如需忽略所有客户端转发头，可设置 `TRUSTED_PROXIES=none`。

- **KUBECTL_TERMINAL_IMAGE**: 用于 kubectl 终端的 Docker 镜像。

- **NODE_TERMINAL_IMAGE**: 用于生成 Node Terminal Agent 的 Docker 镜像。终端 Pod 直接绑在目标节点上，所以**节点是 arm64 时会自动改用带 `-arm64` 后缀的同名 tag**（如 `busybox:latest` → `busybox:latest-arm64`）；不带 tag 的镜像名、`@sha256:` digest 引用、以及已经带 `-arm64` 后缀的值都不会被改写，amd64 节点一律保持原值。

- **CLUSTER_AGENT_IMAGE**: 为 Cluster Agent 类型集群生成 Cluster Agent 部署清单时使用的 Docker 镜像。

- **PORT**：鸢联 AeroLink 运行的端口，默认值为 `8080`。

## 数据库

- **DB_TYPE**：数据库类型：`sqlite`（默认）、`mysql` 或 `postgres`。
- **DB_DSN**：数据库 DSN，SQLite 默认为 `dev.db`。
- **AEROLINK_DB_MAX_OPEN_CONNS**：最大打开连接数，默认 `100`。
- **AEROLINK_DB_MAX_IDLE_CONNS**：最大空闲连接数，默认 `10`。
- **AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES**：连接最大存活时间（分钟），默认 `10`。
- **AEROLINK_DB_MIGRATE**：设为 `off` 时跳过自动迁移与结构回填，库结构改由外部流程维护（`checkSchema` 仍会核对），适用于应用账号没有 DDL 权限的场景。
- **AEROLINK_DB_MIGRATE_STRICT**：设为 `true` 时迁移出错即 panic，仅用于开发与 CI。

建库、连接池容量与库结构变更口径见[数据库准备](./database.md)。

## 审计与归档

审计日志的落地方式是**五选一互斥**的，在**启动时**决定、管理页面只读（改存储方式需要重启）。

- **AEROLINK_AUDIT_SINK**：审计记录的落地方式，取值：

  | 取值 | 说明 | 前置条件（不满足则拒绝启动） |
  | --- | --- | --- |
  | `database`（默认，不设即此值） | 只写数据库，行为与未配置时一致 | — |
  | `parquet` | 只落本地 parquet 文件，可叠加 S3 远端副本 | 必须有归档目录（`AEROLINK_AUDIT_ARCHIVE_DIR` 或配置文件里的 `auditArchive.localDir`） |
  | `elasticsearch` | 只写 Elasticsearch | 必须先有节点地址（页面「审计设置 → Elasticsearch」或配置文件的 `auditArchive.elasticsearch.urls`） |
  | `victorialogs` | 只写 VictoriaLogs（**不是** VictoriaMetrics：后者是时序库，存不下审计字段明细） | 必须先有节点地址（`auditArchive.victorialogs.urls`） |
  | `openobserve` | 只写 OpenObserve | 必须先有节点地址（`auditArchive.openobserve.urls`） |

  取值非法会**直接启动失败**（不会静默回落成 `database`）。也可以写在配置文件的 `auditSink`
  字段里（配置文件优先），两种方式都只认启动时的值。

  ```bash
  # 只写数据库（默认，不设即此值）
  # 不设置 AEROLINK_AUDIT_SINK 即可

  # 本地 parquet 文件（需同时给归档目录）
  AEROLINK_AUDIT_SINK=parquet
  AEROLINK_AUDIT_ARCHIVE_DIR=/home/aerolink/data/archive   # 官方镜像默认值

  # Elasticsearch（需先在页面或配置文件里填好地址）
  AEROLINK_AUDIT_SINK=elasticsearch

  # VictoriaLogs（VictoriaMetrics 体系里的日志存储，默认端口 9428）
  AEROLINK_AUDIT_SINK=victorialogs

  # OpenObserve（默认端口 5080）
  AEROLINK_AUDIT_SINK=openobserve
  ```

  用它们各自的地址、凭据（如 OpenObserve 的用户名/密码、S3 的 Access Key/Secret Key）时，
  请在「审计设置 → 归档」页面里填，或写在配置文件的 `auditArchive` 段里（样例见仓库根目录的
  `config.dev.yaml`）。多副本部署时，每一份副本都要配置同一个 `AEROLINK_AUDIT_SINK`，否则记录会散到
  不同存储里。

  注意：当 sink 是 `victorialogs` / `openobserve` 时，过期数据由**服务端**负责（VictoriaLogs 的
  `-retentionPeriod`、OpenObserve 的 stream `data_retention`），「审计设置」里的保留天数对它们不生效。

- **AEROLINK_AUDIT_ARCHIVE_DIR**：审计/访问日志的本地归档目录（`AEROLINK_AUDIT_SINK=parquet` 且没在页面上
  配 `localDir` 时的启动兜底）。多副本部署（`replicaCount > 1`）时必须把它指向**共享卷**
  （RWX PVC / NFS 等）：每个副本只写自己产生的记录、检索读的又是本地目录，目录不共享就查不全。
- **AEROLINK_DUCKDB_EXTENSION_DIR**：DuckDB（parquet 检索）安装扩展的目录。留空时用进程可写的临时
  目录（系统临时目录下的 `aerolink-duckdb-extensions`）：DuckDB 默认装到 `~/.duckdb`，`HOME` 不可写
  时 `INSTALL httpfs` 会直接失败，导致查 S3 上的归档（早于本地保留期的记录）不可用——本地 parquet
  检索不受影响。官方镜像以 `aerolink` 用户在其家目录（`/home/aerolink`，即工作目录）下运行，
  `HOME` 可写；离线部署可在镜像里预置 `httpfs` 扩展，并把本项指向该目录。
- **AEROLINK_LOG_FILE**：klog（系统日志）落盘路径。设置后系统日志只写文件、不再写 stderr，便于日志
  采集工具收集；等价于命令行 `-log_file <path> -logtostderr=false`（命令行优先）。官方镜像的默认值是
  `/home/aerolink/data/aerolink.log`（运行用户家目录下）；置空则输出到 stderr，`kubectl logs` 可直接
  看到系统日志。目录不存在时程序会尝试创建，实在写不进去只告警并回落到 stderr，不会拒绝启动。

## 运行与运维

- **AEROLINK_BASE**：鸢联 AeroLink 部署在子路径下时的基础路径（如 `/aerolink`）。
- **CORS_ALLOWED_ORIGINS**：允许跨域的来源列表（逗号分隔），仅建议开发环境使用。
- **DISABLE_GZIP**：设为 `true` 关闭 gzip 响应压缩（默认已关闭）。
- **NAMESPACE**：终端 / kubectl Agent Pod 创建所在的 Kubernetes 命名空间，默认 `kube-system`。
- **AEROLINK_METRICS_TOKEN**：访问 `/metrics` 所需的 Bearer Token；未设置时该端点无需认证。
- **AEROLINK_ENABLE_PPROF**：设为 `true` 时在 `localhost:6060` 开放 pprof（堆转储可能包含敏感信息，默认关闭）。
- **AEROLINK_DISABLE_CSP**：设为 `true` 关闭 Content-Security-Policy 响应头（仅限开发）。
- **AEROLINK_ALLOW_PRIVATE_REGISTRIES**：设为 `true` 允许镜像标签查询访问内网 / 回环地址的镜像仓库。
- **AEROLINK_POD_METRICS_INTERVAL**：Pod 列表页实时推送里「用量（CPU / 内存数字）」的刷新间隔，
  单位秒，默认 `15`。实时连接（SSE）只在用量**发生变化**时推一条 `event: metrics`，所以调大它
  只会让数字刷新变慢、并不会减少连接本身的开销；设为非正数或非法值会回退到默认值。
- **AEROLINK_MAX_WATCH_PER_USER**：单个用户在每个集群上允许并发持有的资源 watch（SSE）连接数，
  默认 `8`。超限的新连接返回 `429`（响应体里的 `code` 为 `watch_limit_exceeded`），前端收到后自动
  降级为轮询、并定期尝试把实时连接抢回来。多个标签页 / 多个详情页会各占一条连接，上限给得太紧会
  让用户频繁落在轮询模式；设为 `0` 或负数表示不限制（仅建议临时排查用）。计数是**每副本**的，
  多副本部署时同一个人实际能达到的总连接数约为「上限 × 副本数」，限流的精确度只在这个量级上。
