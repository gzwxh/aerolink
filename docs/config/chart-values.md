# Chart Values

本文档描述了鸢联 AeroLink Helm Chart 的所有可用配置选项。

## 基础配置

| 参数               | 描述                                               | 默认值                  |
| ------------------ | -------------------------------------------------- | ----------------------- |
| `replicaCount`     | 副本数量                                           | `1`                     |
| `image.repository` | 容器镜像仓库                                       | `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink` |
| `image.pullPolicy` | 镜像拉取策略                                       | `IfNotPresent`          |
| `image.tag`        | 镜像标签。如果设置，将覆盖 chart 的 `appVersion`。 | `""`                    |
| `imagePullSecrets` | 私有镜像仓库的拉取密钥                             | `[]`                    |
| `nameOverride`     | 覆盖 chart 名称                                    | `""`                    |
| `fullnameOverride` | 覆盖完整名称                                       | `""`                    |
| `debug`            | 启用调试模式                                       | `false`                 |
| `basePath`         | 应用的基础路径，详见安装文档中的说明。             | `""`                    |

## 认证与安全

| 参数                   | 描述                                                       | 默认值                                               |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `anonymousUserEnabled` | 启用匿名用户访问，拥有完全管理员权限。生产环境请谨慎使用。 | `false`                                              |
| `requireEncryptedCredentials` | 只接受密文凭据（登录口令、动态码、改密/重置口令）：明文提交返回 `400`，`code` 为 `encrypted_credential_required`。只在确认所有客户端都是当前版本后开启，滚动升级期间开启会让旧页面登录失败。 | `false`                                              |
| `jwtSecret`            | 用于签名 JWT 令牌的密钥。为空时首次启动自动生成。         | `""`                                                 |
| `encryptKey`           | 用于加密敏感数据的密钥。为空时首次安装自动生成随机值（升级时自动复用已有密钥）；仅在自行管理密钥时才需显式设置。 | `""`                                                 |
| `host`                 | 应用程序的主机名                                           | `""`                                                 |

传输加密用的私钥（`data/transport-key.pem`）不由 chart 管理：多副本（`replicaCount > 1`）时必须让所有
副本读到同一份，否则请求落到别的副本会解不开。做法是 `extraEnvs` 注入 `AEROLINK_TRANSPORT_PRIVATE_KEY`
（值来自 Secret）或把共享卷挂到该路径，详见[环境变量](./env.md)的「凭据传输加密」。

## 数据库配置

| 参数      | 描述                                                             | 默认值   |
| --------- | ---------------------------------------------------------------- | -------- |
| `db.type` | 数据库类型：`sqlite`、`postgres`、`mysql`                        | `sqlite` |
| `db.dsn`  | MySQL/Postgres 的完整 DSN 字符串。当类型为 mysql/postgres 时必需 | `""`     |

### SQLite 配置

| 参数                                      | 描述                                  | 默认值              |
| ----------------------------------------- | ------------------------------------- | ------------------- |
| `db.sqlite.persistence.pvc.enabled`       | 是否创建 PVC 来存储 sqlite 数据库文件 | `false`             |
| `db.sqlite.persistence.pvc.existingClaim` | 使用现有的 PVC                        | `""`                |
| `db.sqlite.persistence.pvc.storageClass`  | PVC 的 StorageClass（可选）           | `""`                |
| `db.sqlite.persistence.pvc.accessModes`   | PVC 的访问模式                        | `["ReadWriteOnce"]` |
| `db.sqlite.persistence.pvc.size`          | PVC 请求的存储大小                    | `1Gi`               |
| `db.sqlite.persistence.hostPath.enabled`  | 是否使用 hostPath 存储                | `false`             |
| `db.sqlite.persistence.hostPath.path`     | hostPath 路径                         | `/path/to/host/dir` |
| `db.sqlite.persistence.hostPath.type`     | hostPath 类型                         | `DirectoryOrCreate` |
| `db.sqlite.persistence.mountPath`         | 容器内的挂载路径                      | `/home/aerolink/db` |
| `db.sqlite.persistence.filename`          | 挂载路径内的 sqlite 文件名            | `aerolink.db`       |
| `db.sqlite.options`                       | 追加到 SQLite DSN 的连接选项，只支持纯 Go 驱动的 `_pragma=...` 形式（mattn 风格的 `_journal_mode=...` 会被静默忽略） | `""` |

## 环境变量

| 参数        | 描述               | 默认值 |
| ----------- | ------------------ | ------ |
| `extraEnvs` | 额外的环境变量列表 | `[]`   |

## 外部请求

鸢联 AeroLink 不向外发任何请求：没有更新检查，也没有数据上报。实例只访问所在集群的 API Server（以及你在界面上添加的其它集群）与配置的数据库；`/api/v1/version` 返回的也只是本地构建信息。

## 运行与运维

以下参数注入对应的环境变量，语义与[环境变量](./env.md)一致。

| 参数                    | 描述                                                                                                                                                                                     | 默认值                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `logFile`               | klog（系统日志）落盘路径。设置后系统日志只写文件、不再写 stderr，便于采集工具收集；置空则输出到 stderr（`kubectl logs` 能直接看到）。目录不存在时会尝试创建，写不进去只告警并回落 stderr。 | `/home/aerolink/data/aerolink.log`     |
| `podMetricsInterval`    | Pod 列表页实时推送里「用量（CPU / 内存数字）」的刷新间隔（秒）。留空为默认 `15`。                                                                                                         | `""`                                   |
| `maxWatchPerUser`       | 单个用户在每个集群上允许并发持有的资源 watch（SSE）连接数。留空为默认 `8`；超限的新连接返回 `429`，前端自动降级为轮询。`0` 表示不限制（仅建议临时排查用）。                                 | `""`                                   |
| `clusterProbeInterval`  | 主动探活各集群 API server 的间隔（秒）。留空为默认 `15`；`0` 关闭探活。                                                                                                                   | `""`                                   |
| `clusterStaleAfter`     | 判定「集群数据可能已过期」的阈值（秒）。留空为默认 `45`（探活间隔的 3 倍）；`0` 只保留「从未连上过」与 watch 报错两种判据。                                                                 | `""`                                   |

## 审计与归档

审计日志的**落地方式**（`database` 默认、`parquet`、`elasticsearch`、`victorialogs`、`openobserve`，五选一互斥）由**启动时**决定——写 `config.yaml` 的 `auditSink` 或环境变量 `AEROLINK_AUDIT_SINK`，管理页面只读；多副本部署时每份副本都要写同一个值，否则记录会散到不同存储里。

| 参数                                                              | 描述                                                                                                                                                                                                                                                                                                 | 默认值                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `auditArchiveDir`                                                 | 本地归档目录（注入 `AEROLINK_AUDIT_ARCHIVE_DIR`）。只作启动兜底：生效值在「日志审计 → 审计设置 → 归档」里配置，**数据库里保存的本地目录优先于本项**。`auditSink: parquet` 时它是唯一落点；`replicaCount > 1` 且 parquet 时必须是共享卷（RWX PVC / NFS），否则每份副本只写自己产生的记录、检索读不全。 | `/home/aerolink/data/archive` |
| `duckdbExtensionDir`                                              | DuckDB（parquet 检索）安装扩展的目录（注入 `AEROLINK_DUCKDB_EXTENSION_DIR`）。留空时用进程可写的临时目录：DuckDB 默认装到 `~/.duckdb`，`HOME` 不可写时 `INSTALL httpfs` 会失败，导致查 S3 上的归档不可用（本地 parquet 检索不受影响）。离线环境可预置 httpfs 扩展并把本项指向它。               | `""`                          |
| `auditPersistence.enabled`                                        | 为归档 parquet 与 klog 日志挂持久化卷（不挂则 Pod 重建即丢，生产建议开启）。                                                                                                                                                                                                                          | `false`                       |
| `auditPersistence.mountPath`                                      | 持久化卷的挂载点。不要挂到 `/home/aerolink` 本身，否则会盖掉家目录里的二进制。                                                                                                                                                                                                                        | `/home/aerolink/data`         |
| `auditPersistence.pvc.enabled` / `auditPersistence.pvc.existingClaim` | 新建 / 使用已有的 PVC（留空回退到 `hostPath`，再回退到 `emptyDir`）。多副本必须用 RWX 共享卷，不能用 `hostPath` / `emptyDir`。                                                                                                                                                                        | `false` / `""`                |
| `auditPersistence.hostPath.enabled` / `.path` / `.type`           | 使用 hostPath 落盘（仅适合单副本）。                                                                                                                                                                                                                                                                  | `false` / `/home/aerolink/data` / `DirectoryOrCreate` |

`auditSink` 的取值与各自的前置条件（不满足会拒绝启动）见[配置文件](./config-file.md)与[环境变量](./env.md)。

## 应用配置

鸢联 AeroLink 支持从 YAML 配置文件加载集群、OAuth/LDAP 与 RBAC 配置。启用后，对应的受管配置区块在界面上将变为只读。

该功能适用于鸢联 AeroLink `v0.10.0` 及以上版本。

完整的配置文件格式、使用示例与字段说明请参见[配置文件](./config-file.md)。

| 参数                      | 描述                                                          | 默认值  |
| ------------------------- | ------------------------------------------------------------- | ------- |
| `config.enabled`          | 是否启用配置文件模式                                          | `false` |
| `config.existingSecret`   | 已存在的 Secret 名称（其中包含 `config.yaml` 键），推荐使用此方式 | `""`    |
| `config.superUser`        | 内联超级用户配置（仅首次启动时创建）                           | `{}`    |
| `config.clusters`         | 内联集群配置（未使用 `existingSecret` 时）                     | `[]`    |
| `config.oauth`            | 内联 OAuth 提供商配置                                         | `[]`    |
| `config.ldap`             | 内联 LDAP 配置                                                | `{}`    |
| `config.rbac.roles`       | 内联 RBAC 角色定义                                            | `[]`    |
| `config.rbac.roleMapping` | 内联 RBAC 角色映射                                            | `[]`    |

`config.ldap` 支持 `enabled`、`serverUrl`、`useStartTLS`、`bindDn`、`bindPassword`、`userBaseDn`、`userFilter`、`usernameAttribute`、`displayNameAttribute`、`groupBaseDn`、`groupFilter`、`groupNameAttribute`、`autoSync`、`syncIntervalMinutes`。其中 `autoSync`/`syncIntervalMinutes`（默认 `true` / `10` 分钟）控制目录用户的定期同步，字段说明见[配置文件](./config-file.md)。

## 服务账户配置

| 参数                         | 描述                        | 默认值 |
| ---------------------------- | --------------------------- | ------ |
| `serviceAccount.create`      | 是否创建服务账户            | `true` |
| `serviceAccount.automount`   | 自动挂载服务账户的 API 凭据 | `true` |
| `serviceAccount.annotations` | 服务账户的注解              | `{}`   |
| `serviceAccount.name`        | 使用的服务账户名称          | `""`   |

## RBAC 配置

| 参数          | 描述               | 默认值     |
| ------------- | ------------------ | ---------- |
| `rbac.create` | 是否创建 RBAC 资源 | `true`     |
| `rbac.rules`  | RBAC 规则列表      | 见下方示例 |

### RBAC 规则示例

```yaml
rbac:
  rules:
    - apiGroups: ["*"]
      resources: ["*"]
      verbs: ["*"]
    - nonResourceURLs: ["*"]
      verbs: ["*"]
```

## Pod 配置

| 参数                 | 描述                   | 默认值 |
| -------------------- | ---------------------- | ------ |
| `podAnnotations`     | Pod 的 Kubernetes 注解 | `{}`   |
| `podLabels`          | Pod 的 Kubernetes 标签 | `{}`   |
| `podSecurityContext` | Pod 安全上下文         | `{}`   |
| `securityContext`    | 容器安全上下文         | `{}`   |

## 服务配置

| 参数           | 描述     | 默认值      |
| -------------- | -------- | ----------- |
| `service.type` | 服务类型 | `ClusterIP` |
| `service.port` | 服务端口 | `8080`      |

## Ingress 配置

| 参数                  | 描述             | 默认值     |
| --------------------- | ---------------- | ---------- |
| `ingress.enabled`     | 是否启用 Ingress | `false`    |
| `ingress.className`   | Ingress 类名     | `"nginx"`  |
| `ingress.annotations` | Ingress 注解     | `{}`       |
| `ingress.hosts`       | Ingress 主机配置 | 见下方示例 |
| `ingress.tls`         | TLS 配置         | `[]`       |

### Ingress 主机配置示例

```yaml
ingress:
  hosts:
    - host: aerolink.gogdev.cn
      paths:
        - path: /
          pathType: ImplementationSpecific
```

## Gateway API

用 Gateway / HTTPRoute 代替 Ingress 对外暴露（两者可并存，按需选一种）。集群需已安装 Gateway API CRD。

| 参数                 | 描述                                                                                              | 默认值                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `gateway.enabled`    | 是否创建 Gateway API 资源                                                                         | `false`                                                         |
| `gateway.className`  | GatewayClass 名称，必须已存在于集群中（`istio`、`cilium`、`nginx`、`envoy-gateway` 等）            | `""`                                                            |
| `gateway.create`     | `true` 创建新的 Gateway，`false` 引用已有的 Gateway                                                | `false`                                                         |
| `gateway.name`       | Gateway 名称（创建或引用时都会用到）                                                              | `""`                                                            |
| `gateway.namespace`  | 已有 Gateway 的命名空间，仅在 `create=false` 时使用；不填默认为 release 所在命名空间                | `""`                                                            |
| `gateway.annotations`| Gateway 的注解，仅在 `create=true` 时使用                                                          | `{}`                                                            |
| `gateway.listeners`  | Gateway 的 listener 配置（名称、端口、协议、hostname、TLS 等），仅在 `create=true` 时使用           | 一个 `http` / `80` 的 HTTP listener                             |
| `gateway.httpRoutes` | HTTPRoute 列表，每条含 `name`、`annotations`、`hostnames` 与 `rules`（`matches`、`timeouts` 等）   | 一条匹配 `/` 的 `PathPrefix` 路由，`request` 超时 `120s`         |

示例（引用已有 Gateway，并按主机名加一条路由）：

```yaml
gateway:
  enabled: true
  create: false
  name: shared-gateway
  className: nginx
  httpRoutes:
    - name: aerolink
      hostnames:
        - aerolink.gogdev.cn
      rules:
        - matches:
            - path:
                type: PathPrefix
                value: /
          timeouts:
            request: "120s"
```

## 资源限制

| 参数        | 描述               | 默认值 |
| ----------- | ------------------ | ------ |
| `resources` | 容器资源限制和请求 | `{}`   |

### 资源限制示例

```yaml
resources:
  limits:
    cpu: 100m
    memory: 128Mi
  requests:
    cpu: 100m
    memory: 128Mi
```

## 健康检查

| 参数             | 描述         | 默认值     |
| ---------------- | ------------ | ---------- |
| `livenessProbe`  | 存活探针配置 | 见下方示例 |
| `readinessProbe` | 就绪探针配置 | 见下方示例 |

### 健康检查示例

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: http
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /healthz
    port: http
  initialDelaySeconds: 10
  periodSeconds: 10
```

## 存储配置

| 参数           | 描述             | 默认值 |
| -------------- | ---------------- | ------ |
| `volumes`      | 额外的卷配置     | `[]`   |
| `volumeMounts` | 额外的卷挂载配置 | `[]`   |

## 调度配置

| 参数           | 描述       | 默认值 |
| -------------- | ---------- | ------ |
| `nodeSelector` | 节点选择器 | `{}`   |
| `tolerations`  | 容忍度配置 | `[]`   |
| `affinity`     | 亲和性配置 | `{}`   |
