# 环境变量

Kite 默认支持一些环境变量，来改变一些配置项的默认值。

- **KITE_CONFIG_FILE**：配置文件路径。该功能仅适用于 Kite `v0.10.0` 及以上版本。设置后，Kite 从该文件加载集群、OAuth、LDAP、RBAC 和超级用户设置。详见[配置文件](../config/config-file.md)。
- **KITE_USERNAME**：兼容旧配置的超级用户名环境变量。仅在未设置 `KITE_CONFIG_FILE` 时，用于环境变量到数据库配置的迁移。
- **KITE_PASSWORD**：兼容旧配置的超级用户密码环境变量。仅在未设置 `KITE_CONFIG_FILE` 时，用于环境变量到数据库配置的迁移。
- **KUBECONFIG**：兼容旧配置的 kubeconfig 环境变量。仅在未设置 `KITE_CONFIG_FILE` 时读取并导入集群配置。
- **ANONYMOUS_USER_ENABLED**：启用匿名用户访问，默认值为 `false`，当启用后所有访问将不再需要身份验证，并且默认拥有最高权限。

- **JWT_SECRET**：用于签名和验证 JWT 的密钥。未设置时首次启动会自动生成随机密钥并保存到数据库；设置时长度不得少于 32 字节。
- **KITE_ENCRYPT_KEY**：用于加密敏感数据的密钥, 例如用户密码，OAuth 的 clientSecret ，kubeconfig 等。**必填**：未设置时服务拒绝启动（除非 `KITE_ALLOW_INSECURE_SECRETS=true`）。更换该密钥会导致已保存的凭据无法解密，轮换后需重新保存全部凭据。
- **KITE_REQUIRE_ENCRYPT_KEY**：设置为 `true` 时，即使开启 `KITE_ALLOW_INSECURE_SECRETS` 也必须设置 `KITE_ENCRYPT_KEY`。
- **KITE_ALLOW_INSECURE_SECRETS**：仅限本地开发的逃生开关（`true`/`false`），允许使用内置默认密钥和较短的 JWT 密钥，生产环境禁止开启。

- **HOST**: 用户 OAuth 2.0 授权回调地址生成，默认会从请求头获取，如果您发现结果不及预期可以手动配置此环境变量。

- **TRUSTED_PROXIES**：以逗号分隔的反向代理、Ingress 或负载均衡器 IP/CIDR 列表；只有这些直连 Kite 的上一跳才会被信任，Kite 才会读取其转发的 `X-Forwarded-For` / `X-Real-IP` 来判断客户端 IP。默认信任本地和常见私网网段（`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`::1`、`fc00::/7`），方便常见 Ingress 部署拿到真实用户 IP。生产环境建议配置为更窄的范围，例如 `TRUSTED_PROXIES=10.42.0.0/16,192.168.1.10`；如需忽略所有客户端转发头，可设置 `TRUSTED_PROXIES=none`。

- **KUBECTL_TERMINAL_IMAGE**: 用于 kubectl 终端的 Docker 镜像。

- **NODE_TERMINAL_IMAGE**: 用于生成 Node Terminal Agent 的 Docker 镜像。

- **CLUSTER_AGENT_IMAGE**: 为 Cluster Agent 类型集群生成 Cluster Agent 部署清单时使用的 Docker 镜像。

- **ENABLE_ANALYTICS**：是否注入数据统计脚本，默认值为 `false`。该开关一旦由环境变量显式指定，就优先于界面上的同名设置。注意：服务端下发的 CSP 不放行统计脚本与上报网关，因此即使开启也不会真的发出上报。
- **DISABLE_VERSION_CHECK**：是否访问 `api.github.com` 查询上游新版本。本分支默认关闭；显式设置 `true`/`false` 后优先于界面上的同名设置。

- **PORT**：Kite 运行的端口，默认值为 `8080`。

## 数据库

- **DB_TYPE**：数据库类型：`sqlite`（默认）、`mysql` 或 `postgres`。
- **DB_DSN**：数据库 DSN，SQLite 默认为 `dev.db`。
- **KITE_DB_MAX_OPEN_CONNS**：最大打开连接数，默认 `100`。
- **KITE_DB_MAX_IDLE_CONNS**：最大空闲连接数，默认 `10`。
- **KITE_DB_CONN_MAX_LIFETIME_MINUTES**：连接最大存活时间（分钟），默认 `10`。

## 运行与运维

- **KITE_BASE**：Kite 部署在子路径下时的基础路径（如 `/kite`）。
- **CORS_ALLOWED_ORIGINS**：允许跨域的来源列表（逗号分隔），仅建议开发环境使用。
- **DISABLE_GZIP**：设为 `true` 关闭 gzip 响应压缩（默认已关闭）。
- **DISABLE_VERSION_CHECK**：设为 `true` 关闭版本更新检查。
- **NAMESPACE**：终端 / kubectl Agent Pod 创建所在的 Kubernetes 命名空间，默认 `kube-system`。
- **KITE_METRICS_TOKEN**：访问 `/metrics` 所需的 Bearer Token；未设置时该端点无需认证。
- **KITE_ENABLE_PPROF**：设为 `true` 时在 `localhost:6060` 开放 pprof（堆转储可能包含敏感信息，默认关闭）。
- **KITE_DISABLE_CSP**：设为 `true` 关闭 Content-Security-Policy 响应头（仅限开发）。
- **KITE_ALLOW_PRIVATE_REGISTRIES**：设为 `true` 允许镜像标签查询访问内网 / 回环地址的镜像仓库。
