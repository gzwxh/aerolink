# 审计/系统日志归档方案（本地 parquet + 外部存储 S3/ES）

日期：2026-09-20
状态：已实现（步骤 1-11 全部落地；S3/ES 端到端联调需真实对象存储与 ES 环境）

## 1. 背景与目标

Kite 日志现状：

- **审计日志**（操作 `resource_histories`、登录 `login_records`、改密
  `password_change_logs`）落库 MySQL/PG/SQLite，已支持 syslog 外发。
- **系统日志**：klog 走 stderr、gin 访问日志走 stdout，由运行时采集。

本方案新增一条**应用内归档通道**：审计日志 + 访问日志落 **parquet**，klog 落**本地
文本文件**，外部存储支持 **S3（协议兼容）** 与 **Elasticsearch**。

**已定决策**：

1. 访问日志**纳入本期** parquet 归档。
2. klog 落盘选**只落文件**（`-logtostderr=false`）。
3. 访问日志本地滚留阈值**单独配置**，默认保留 **3 天**。
4. 存放位置 / 保留时长：配置文件 + 环境变量提供初始值，`audit_settings` 表为真身、
   **管理员页面可改**。
5. S3 配置后默认**本地留几天 + 全量同步 S3**（`deleteLocalAfterUpload=false`，本地保留由
   `retentionDays` 负责）；`deleteLocalAfterUpload=true` 才是「上传即删、本地只作中转」。
   原文为「默认上传即删」，2026-09-21 按需求口径反转，见 §12.13。
6. 外部存储 S3 兼容 **MinIO / RustFS / Ceph RGW / 腾讯 COS / 华为 OBS / 阿里 OSS /
   JuiceFS / SeaweedFS** 等一切 S3 兼容对象存储，**不写厂商专属 driver**。
7. 归档配置 UI 放**阶段 2**（与 S3/ES 同期）；阶段 1 仅环境变量 + charts 配置 +
   `config.yaml` 播种值、界面只读。
8. ES 放**阶段 2**（与 S3 同期），本期不实现。

边界：本地落库保持不变，归档是尽力而为的异介质副本，失败绝不影响 MySQL 落库；不改动、
不引入外部 Agent。

## 2. 需求拆解

| 需求 | 落地方式 |
|---|---|
| 本地写 parquet | 新增 parquet sink，攒批 flush 成不可变文件 |
| 指定存放位置 / 存多久 | 配置 + 环境变量初始值，`audit_settings` 页面可改 |
| 未指定位置用本地 | `LocalDir` 可配，默认本地目录 |
| 本地保留一定量、其余收走半年 | 本地按时间/容量滚动清理；收集工具收 `.parquet` 保留 180 天 |
| 访问日志入归档 + 单独滚留 | `AccessLog` 独立开关 + 独立阈值 |
| klog 只落文件 | `-log_file -logtostderr=false`，零代码 |
| S3（多厂商兼容） | minio-go v7，endpoint/pathStyle/region 适配 |
| ES | go-elasticsearch v8，bulk + 按天索引 |
| 不改 Agent | 应用内直写本地/远端；收集工具仅被动收本地文件 |

## 3. 技术选型

- parquet：`github.com/parquet-go/parquet-go`（社区维护 fork，纯 Go、Apache-2.0）。
  原选型 `segmentio/parquet-go` 已归档，其 `hashprobe/aeshash` 用 `//go:linkname` 引用
  runtime 内部符号 `aeskeysched`，Go 1.26 链接期直接报
  `invalid reference to runtime.aeskeysched`（只能靠 `-tags purego` 绕过，会强迫所有
  构建路径都带 tag）。fork 把该符号改为包内定义，无需任何 build tag 即可构建。
- S3：`minio/minio-go/v7`（自定义 endpoint 最简、天然 pathStyle、Apache-2.0）。
- ES：`elastic/go-elasticsearch/v8`（官方、bulk、重试、basic auth/TLS）。
- klog：沿用自带 `log_file`/`logtostderr` flag。

> **CGO 不设硬约束**：以上选型均为纯 Go、Apache-2.0，但引入带 CGO 的依赖（如 DuckDB）
> 同样允许——构建镜像带 `gcc`、运行时镜像带 `libc` 即可（见 §9.4），不必为规避 CGO 而
> 放弃更顺手的实现方式。

## 4. 总体架构

复用 syslog 外发骨架，新增 parquet sink，再扩展远端 S3/ES：

```
AfterCreate × 3 ─> forwardAuditMessage(msg) ─> forwarder 回调列表
                         ├── forwardToSyslog   (已有；访问日志不进 syslog)
                         └── forwardToParquet  (新增)
                                │
                    ┌───────────┴────────────┐
                    │  消息级双写（互不依赖）   │
                    ▼                        ▼
            parquetWriter 攒批           ES 攒批（2000 条 / 间隔）
                    │ flush 成 .parquet      │ 映射 ESDocument
                    ▼                        ▼
           本地目录(滚动保留 N 天)      Elasticsearch(按天索引, 检索)
                    │ flush hook
                    ▼
      S3/MinIO/RustFS/COS/OBS (上传后按策略删本地)
```

**关键区分（易误读）**：

- **S3 是文件级分支**：parquet 落盘后才由 `s3FlushHook` 把**文件本体**搬上去（object key =
  相对路径）。S3 里存的就是 parquet 文件。
- **ES 是消息级旁路**：同一条 `AuditMessage` 在 `append()` 里**另投一份**给 ES 攒批队列，
  经 `esDocumentFromMessage` 映射成 JSON 文档写入，**全程不读 parquet**。所以 ES 可以单独
  启用，不需要 S3、也不依赖本地文件存在；两者失败互不影响（均为尽力而为）。

`middleware.Logger` 的 `Formatter` 额外调 `audit.RecordAccessLog(param)`，走同一通道，
仅 schema 与滚留阈值独立；同时按 `format` 输出到 stdout 供外部采集（见 §6）。

侵入点：`model.SetAuditForwarder` 单回调改为回调列表；回调签名 `func(string)` 升级为
结构化 `func(AuditMessage)`（syslog sink 内部序列化成 `key=value`）。

## 5. parquet schema

- 操作日志 `audit_history.parquet`：`id, created_at(ms), cluster_name, resource_type,
  resource_name, namespace, operation_type, operation_source, success, error_message,
  client_ip, user_agent, operator_id, operator_name`；`ResourceYAML/PreviousYAML` 默认
  排除（开关默认关）。
- 登录日志 `login_record.parquet`：`id, created_at, user_id, username, provider, ip,
  user_agent, result`。
- 改密日志 `password_change_log.parquet`：`id, created_at, user_id, username,
  operator_id, operator, source`。
- 访问日志 `access_log.parquet`（本期纳入）：`ts, client_ip, method, path, status_code,
  latency_ms, cluster, user`；`path` 排除 `RawQuery`（防 token 入归档），复用 `unlogPath`
  过滤健康检查。

## 6. 系统日志落地

### 6.1 两条链路的分工（现状调查结论）

项目里有**两条互不依赖的日志链路**，职责和安全要求完全不同，容易混淆，先钉死：

| 链路 | 内容 | 落地方式 | 谁负责采集 |
|---|---|---|---|
| **应用内归档通道** | 审计日志（操作 / 登录 / 改密）+ 访问日志 | 应用进程自己落成 **parquet**（本地目录），可选上传 **S3**、写入 **ES** | **应用自己**，不依赖任何外部采集 |
| **标准输出通道** | klog（程序运行日志）、gin 访问日志 | 打到 **stderr / stdout**，`format` 可选 `text` / `json` | **外部日志收集工具**（Filebeat / Fluent Bit / 容器日志驱动等） |

- **审计日志不走采集工具**：它要求不可篡改、长期留存、可检索，落 parquet/S3 是应用自身的
  职责——外部采集挂了也不能丢审计。这也是本方案存在的理由。
- **项目自身日志不做应用内落盘归档**：统一交给日志平台（stdout/stderr 采集是容器场景的
  事实标准），应用只负责按配置输出正确格式，不重复造轮子。
- klog 另有「只落本地文本文件」的可选项（`-log_file -logtostderr=false`），那是给**没有采集
  体系**的部署兜底，与 stdout 采集二选一。

### 6.2 具体落地

- **klog**：默认打 stderr；`-log_file=/var/log/aerolink/aerolink.log -log_file_max_size=512
  -logtostderr=false` 可改为只落文件（零代码）；`/var/log/aerolink` 挂可写卷。
- **访问日志**：`Formatter` 里调 `audit.RecordAccessLog`（进归档）+ 按 `format` 输出到 stdout，
  详见 `docs/dev/plans/2026-09-20-system-log-archive.md` §2。
- **输出格式（已实现）**：klog 用自带 `--logging-format=text|json`（部署侧 flag，零代码）；
  访问日志、审计 syslog 各有 `format: text|json` 配置（默认 `text` 即改造前格式，`json`
  输出结构化字段、字段集同 §5 schema，不另维护一套）。**不做 nginx `log_format` 式任意模板**，
  取舍见 §10.4 决策点 6。

## 7. 本地保留与滚动

文件布局按天分区：`<archive_dir>/<类型>/<年>/<月>/<日>/<类型>-<时间>-<seq>.parquet`。

flush 触发（满足其一）：时间到 / 条数到 / 字节数到；先写 `.tmp` 再原子 rename 成
`.parquet`，收集工具只识别终态文件。

本地滚动保留（**审计与访问日志分开配置**）：

| 项 | 审计默认 | 访问日志默认（单独） |
|---|---|---|
| retentionDays | 7 | 3 |
| maxBytes | 10 GiB | 5 GiB |
| flush 间隔 / 单批条数 | 120s / 10 万 | 120s / 20 万 |

收集工具扫描 `archive_dir` 上传 `.parquet` 后删本地，保证 180 天保留；建议
`retentionDays >= 收集巡检周期`。

## 8. 外部存储

### 8.1 S3（冷归档，多厂商兼容）

flush 成 parquet 后若 S3 启用，上传到 `prefix`（沿用 `<类型>/<年>/<月>/<日>/<文件名>`）。
**默认「本地留几天 + 全量同步 S3」**（`deleteLocalAfterUpload=false`）：本地按
`retentionDays` 滚留、S3 作为长期归档，两边都能查（本地优先、本地没有的日期回落 S3）。
设为 `true` 则是「上传即删、本地只作中转」；无论哪种，上传失败都会保留本地、由补传任务补齐，
不丢数据。

**兼容矩阵**（统一 minio-go v7，仅 endpoint/pathStyle/region 不同，无专属 driver）：

| 存储 | endpoint 示例 | pathStyle | region |
|---|---|---|---|
| MinIO | `http://minio:9000` | true | 任意（如 `us-east-1`） |
| RustFS | `http://rustfs:9000` | true | 任意 |
| Ceph RGW | `http://ceph-rgw:7480` | true | 任意 |
| 腾讯 COS | `https://cos.<region>.myqcloud.com` | false | 必填 |
| 华为 OBS | `https://obs.<region>.myhuaweicloud.com` | false | 可空 |
| 阿里 OSS | `https://oss-<region>.aliyuncs.com` | false | 可空 |
| JuiceFS/SeaweedFS 等 | 各自 endpoint | true | 任意 |

> RustFS（github.com/rustfs/rustfs，Apache-2.0）：Rust 编写的 S3 兼容对象存储，
> 提供标准 S3 API（另含 Swift/SFTP/FTPS/WebDAV），MinIO 磁盘格式兼容，`pathStyle=true`
> 即可接入，无需专属代码。默认 S3 端口 `9000`、console `9001`；本地会部署一套用于
> 测试，部署文档见 `/data/deploy/GITLABWORK/project-docs/数字基座/开发环境/RustFS-FTP-SFTP部署.md`，
> 实现时以实际 endpoint 为准。

> **RustFS 1.0.0 实测（2026-09-20 本地验证）**：`rustfs/rustfs:latest` 即 **1.0.0 正式版**
> （GA 2026-09-16，容器内 `rustfs --version` 确认）；`1.0.1` 在镜像加速器上取不到，用 `latest` 即可。
> 部署要点：
>
> - 端口 `9000`（S3）/ `9001`（console）；容器以**非 root `rustfs(10001)`** 运行，绑宿主机目录
>   必须先 `chown 10001:10001`，否则启动即 permission denied（用 Docker named volume 可规避）。
> - 凭据走环境变量 `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`；不设置则回落到内置默认值并在
>   启动日志告警。内置 console 默认凭据 `rustfsadmin/rustfsadmin`，**生产必须改**。
> - `pathStyle=true` 直连即可，`minio-go` **零适配**；实测空载内存约 **77 MiB**（限 512 MiB），
>   比 MinIO 更轻。
> - 自 `1.0.0-beta.11` 起，指向私有 / 容器网络的 **webhook 出站**默认被拦，需在
>   `RUSTFS_OUTBOUND_ALLOW_ORIGINS` 显式放行精确的 `scheme://host:port`。本方案不使用
>   webhook，不受影响（仅使用 S3 API 上传）。
> - 端到端验证结果见 §12.9。

> **腾讯云 COS 实测（2026-09-21，`devops-1253764832` / `ap-guangzhou`）**：端到端通过——
> parquet 按 `<prefix>/<类型>/<年>/<月>/<日>/<文件名>` 落桶（实测前缀 `wxh-test/aerolink-audit-test/`），
> 回读校验字节一致（`PAR1` 魔数正常）。
>
> 连接参数：`endpoint=https://cos.ap-guangzhou.myqcloud.com`（**不带桶名**，桶名走独立字段）、
> `region=ap-guangzhou`、`useTLS=true`、**`pathStyle=false`（必填）**、bucket=`devops-1253764832`。
>
> ⚠️ **踩坑记录（已修）**：COS **强制 virtual-hosted 寻址**，用 path-style 会被拒：
> `The bucket you are attempting to access must be addressed using COS virtual-styled domain.`。
> 而 `S3Archive.PathStyle` 原先**根本没有传给 minio-go**——配置保存与客户端构造都不报错，
> 只在**首次真实上传时**才暴露。现已修：`NewS3Sink` 显式映射为 `BucketLookupPath`（path-style）
> 或 `BucketLookupDNS`（virtual-hosted，该版本 minio-go 的命名）。
>
> 结论：**COS 必须 `pathStyle=false`**；MinIO / RustFS / Ceph RGW 用 `true`；
> 另外 COS 不支持 `ListBuckets` 之外的 path-style 访问，用 `mc` 直连时需注意寻址方式。

### 8.2 Elasticsearch（检索，非归档，阶段 2）

审计 + 访问日志结构化写入按天索引 `<indexPrefix>-YYYY.MM.DD`，bulk + 重试 + basic
auth / TLS。ES 是检索面，**不替代** S3 归档与本地 MySQL；与 S3 同期在阶段 2 实现。

**保留策略（已实现）**：审计保留策略（`audit_settings.retentionDays`）同时作用于 ES——
每天巡检时把「整天的数据都早于保留截止时间」的按天索引整体删掉。粒度只能到「天」：
四类记录共用同一天的索引，半天过期就删会把还在保留期内的记录一起删掉，所以取
「审计保留天数」与「访问日志保留天数」的**较大值**（多留只占磁盘，早删就是真丢了）。
实现见 `ESSink.DeleteIndicesBefore`（`pkg/audit/es_sink.go`）与 `pruneExpiredESIndices`
（`pkg/audit/retention.go`），决策与验证见 §12.12。

## 9. 配置模型

### 9.1 Go 结构（扩展 `AuditSettingData`）

```go
type ArchiveSetting struct {
    Enabled       bool   `json:"enabled"`
    LocalDir      string `json:"localDir"`      // 空 = 用环境变量默认
    RetentionDays int    `json:"retentionDays"` // 0 = 不清理
    MaxBytes      int64  `json:"maxBytes"`      // 0 = 不清理
    Flush         FlushSetting  `json:"flush"`
    AccessLog     AccessLogArchive `json:"accessLog"` // 单独滚留
    S3            S3Archive   `json:"s3"`
    Elasticsearch ESArchive   `json:"elasticsearch"`
}
type FlushSetting struct {
    IntervalSeconds int   `json:"intervalSeconds"`
    MaxBatchRows    int   `json:"maxBatchRows"`
    MaxBatchBytes   int64 `json:"maxBatchBytes"`
}
type AccessLogArchive struct {
    Enabled       bool         `json:"enabled"`
    RetentionDays int          `json:"retentionDays"`
    MaxBytes      int64        `json:"maxBytes"`
    Flush         FlushSetting `json:"flush"`
}
type S3Archive struct {
    Enabled               bool   `json:"enabled"`
    Endpoint              string `json:"endpoint"`
    Region                string `json:"region"`
    Bucket                string `json:"bucket"`
    AccessKey             string `json:"accessKey"`
    SecretKey             model.SecretString `json:"secretKey"`
    PathStyle             bool   `json:"pathStyle"`
    UseTLS                bool   `json:"useTLS"`
    Prefix                string `json:"prefix"`
    DeleteLocalAfterUpload bool  `json:"deleteLocalAfterUpload"` // 默认 false：本地留几天 + 全量同步 S3
}
type ESArchive struct {
    Enabled               bool     `json:"enabled"`
    URLs                  []string `json:"urls"`
    Username              string   `json:"username"`
    Password              model.SecretString `json:"password"`
    IndexPrefix           string   `json:"indexPrefix"`
    TLSInsecureSkipVerify bool     `json:"tlsInsecureSkipVerify"`
}
```

敏感值（`S3.SecretKey`、`ES.Password`）用 `model.SecretString` 存储，不落日志。

### 9.2 配置来源（三级，后者覆盖前者）

1. **环境变量 / 配置文件**（启动兜底，只读）：`AEROLINK_AUDIT_ARCHIVE_DIR`（本地目录）、
   `AEROLINK_LOG_FILE`（klog 文件路径）。`config.yaml` 增加 `auditArchive` 块作为**初始
   播种值**——DB 无归档配置时写入 `audit_settings`。
2. **`audit_settings` 表（真身）**：管理员在「审计设置」页配置位置、时长、S3/ES 参数；
   该页属阶段 2，阶段 1 界面只读、仅经 `UpdateAuditSetting` 接口或 config 播种写入。
3. 配置改动（接口或页面）经 `UpdateAuditSetting` 触发 `reloadArchiveConfig()` 热生效。

### 9.3 config.dev.yaml 示例

```yaml
auditArchive:
  enabled: false            # 本地开发默认关闭
  localDir: /var/log/aerolink/archive
  retentionDays: 7
  maxBytes: 10737418240
  accessLog:
    enabled: true
    retentionDays: 3
    maxBytes: 5368709120
  s3:
    enabled: false
    endpoint: http://minio:9000
    bucket: aerolink-audit
    accessKey: ${AEROLINK_S3_ACCESS_KEY}
    secretKey: ${AEROLINK_S3_SECRET_KEY}
    pathStyle: true
    deleteLocalAfterUpload: false  # 默认：本地留几天 + 全量同步 S3（true = 上传即删本地）
  elasticsearch:
    enabled: false
    urls: ["http://es:9200"]
    indexPrefix: aerolink-audit
```

### 9.4 charts / 部署

**已实现**：`charts/kite/values.yaml` 增加 `auditArchiveDir`、`logFile`、`auditPersistence`
（`volumeMounts` + `volumes`，支持 existingClaim / hostPath / emptyDir 三选，与
`db.sqlite.persistence` 同一套写法）；`deployment.yaml` 注入 `AEROLINK_AUDIT_ARCHIVE_DIR`、
`AEROLINK_LOG_FILE` 并挂载持久卷。`deploy/docker-compose.yaml`、`deploy/install.yaml`、
`deploy/install-mysql.yaml` 已同步（给出环境变量与卷的示例）。

**sink 的可照抄样例（2026-09-21）**：五种落地方式的选择都给了可直接抄的片段——
`config.dev.yaml`（`auditSink` ①〜⑤ 段样例：database / parquet+S3 / elasticsearch /
VictoriaLogs / OpenObserve，见 §12.14）、`charts/kite/values.yaml`
（`extraEnvs: AEROLINK_AUDIT_SINK` + `auditArchiveDir` 的配对写法）、`dev.env`、
`deploy/docker-compose.yaml` 与 `deploy/install*.yaml`（环境变量示例，带“为什么拒绝启动”的说明）。
样例一律强调前置条件：parquet 必须有归档目录，elasticsearch / victorialogs / openobserve
必须先有地址。

> 环境变量 `AEROLINK_AUDIT_SINK` 可以**单独使用**（不挂 config.yaml）：之前只挂 config 文件的那条路
> 才认它，现已补在 `LoadConfigFromEnv`（见 §12.13）。

> klog 落盘有两条等价路径：环境变量 `AEROLINK_LOG_FILE`（程序据此设置 `-log_file` 并关闭 stderr），
> 或直接传 `-log_file -logtostderr=false` flag（命令行优先）。归档的 S3/ES 参数走
> `config.yaml` 的 `auditArchive` 播种（§9.3），不在 values 里再开一套。

**镜像（Dockerfile）**：当前 `Dockerfile` 用 `CGO_ENABLED=0` + `distroless/static`
运行时（无 libc）。若引入 CGO 依赖（如 DuckDB），改为：构建阶段 `golang` 镜像自带
`gcc`（去掉 `CGO_ENABLED=0`）、运行时换带 `libc` 的基础镜像（如 `debian:bookworm-slim`
或 `buildpack-deps`）；`Dockerfile.binary` 当前 `alpine:3.20`（musl）同样可换
`ubuntu`/`debian` 等 glibc 基础镜像。两个 Dockerfile 都无硬约束，按需换基础镜像即可；
纯 Go 选型则维持现状零改动。

## 10. 实施计划与实现路径

### 10.1 现状盘点（研发快速上手）

动手前先认清四处现状，它们决定了侵入点：

| 现状 | 位置 | 对本方案的影响 |
|---|---|---|
| 审计外发是**单回调** `func(string)`，序列化在 model 层完成 | `pkg/model/audit_forward.go` | parquet 要结构化字段，需把序列化移到 audit 层、回调升级为结构化 |
| 改密日志**不外发**（直写 DB，无 hook） | `pkg/model/password_change_log.go` `RecordPasswordChange` | 归档改密日志需新增 forward 调用 |
| 审计配置是 JSON blob，已有 `DefaultAuditSettingData`/`Normalize`/`GetAuditSetting`/`UpdateAuditSetting` | `pkg/model/audit_setting.go` | 扩 `Archive` 字段复用，不加新表 |
| syslog 已有「启动接线 + 热加载」样板 | `pkg/audit/syslog.go` | parquet archiver 照抄该模式 |

### 10.2 阶段 1 详细路径（本期：本地 parquet + klog 落文件）

**步骤 1：审计消息结构化 + 回调列表（侵入核心）** —— `pkg/model/audit_forward.go`、
`pkg/audit/syslog.go`：定义结构化 `AuditMessage`（§5 字段，`ResourceYAML/PreviousYAML`
默认排除）；`SetAuditForwarder` 改 `AddAuditForwarder`（追加列表）；序列化
`formatResourceHistoryAudit`/`formatLoginRecordAudit` 迁到 `syslog.go`（改名
`formatSyslogLine`），保证 syslog 输出字节级不变（回归断言）；`operator` 字段在 model
层预填（取自 `h.Operator.Username`）；`RecordPasswordChange` 写库后补
`forwardAuditMessage`。

**步骤 2：parquet writer 基础设施** —— `pkg/audit/parquet.go`（新），引入
`segmentio/parquet-go`：

```go
type ParquetWriter struct {
    dir    string          // <archive_dir>/<类型>
    schema *parquet.Schema
    flush  FlushSetting
    buf    chan any        // 攒批缓冲，满丢
}
func NewParquetWriter(dir string, schema *parquet.Schema, flush FlushSetting) *ParquetWriter
func (w *ParquetWriter) Append(row any)            // 仅入 chan，非阻塞
func (w *ParquetWriter) Run(ctx context.Context)   // 后台：时间/条数/字节 触发 Flush
func (w *ParquetWriter) Flush() error              // 写 .tmp → 原子 rename
func (w *ParquetWriter) Close() error
```

先写 `<类型>/<年>/<月>/<日>/<类型>-<时间>-<seq>.parquet.tmp` 再 rename；`seq` 单实例原子
计数。测试：`t.TempDir()` + 三种触发 + 原子切换 + 读回校验。

**步骤 3：配置模型扩展** —— `pkg/model/audit_setting.go`、`pkg/audit/setting.go`：
`AuditSettingData` 增 `Archive ArchiveSetting`；`DefaultAuditSettingData` 补默认；
`Normalize` 增归档校验（`RetentionDays>=0`、`MaxBytes>=0`、目录合法）。阶段 1 配置来源
环境变量 + `config.yaml` 播种 → `audit_settings`（`GetAuditSetting` 首播写入）、界面只读；
`UpdateAuditSetting` 后调 `reloadArchiveConfig()` 热生效（照抄 `reloadSyslogConfig`）。

**步骤 4：本地滚动清理** —— `pkg/audit/archive_cleanup.go`（新）：独立 goroutine 周期
扫描 `archive_dir`，审计/访问日志各自 `RetentionDays`/`MaxBytes` 阈值清理（过期删目录 /
超容量先删最旧）；独立于写协程，写失败退化「丢弃 + 计数 + 告警」。

**步骤 5：访问日志接入** —— `pkg/middleware/logger.go`：`Formatter` 在 `unlogPath` 过滤
之后调 `audit.RecordAccessLog(param)`，复用基础设施、独立 `accessLogWriter` 实例
（schema/阈值独立，见系统日志方案 §2）。

**步骤 6：启动接线 + klog 落文件** —— `pkg/common/common.go`、`app.go`：环境变量
`AEROLINK_AUDIT_ARCHIVE_DIR`、`AEROLINK_LOG_FILE`；`StartParquetArchiver()` 启动各 writer +
清理协程、优雅退出 `Close()`；klog `-log_file -logtostderr=false` 由部署注入、零 Go 代码。

### 10.3 阶段 2 详细路径（后续：S3 + ES + 查询 + UI 同期）

**步骤 7：S3 上传** —— `pkg/audit/s3_archive.go`（minio-go v7）：flush 后上传
`<bucket>/<prefix>/<类型>/<年>/<月>/<日>/<文件名>`，`pathStyle/region/useTLS` 适配；
默认 `DeleteLocalAfterUpload=true` 上传成功删本地、失败保留重试补传。

**步骤 8：ES sink** —— `pkg/audit/es_sink.go`（go-elasticsearch v8）：bulk + 重试 +
basic auth/TLS，按天索引 `<indexPrefix>-YYYY.MM.DD`。

**步骤 9：归档查询接口** —— `pkg/audit/archive_query.go` + handler：3 个
`/api/v1/admin/*-archive` 查询接口（审计历史/登录/访问）。

**步骤 10：归档配置 UI** —— `ui/src/.../audit-setting.tsx` 增归档区块（本地/S3/ES），
文案走 `zh.json`，S3/ES 密钥 `SecretString` 掩码回显、不落日志。

**步骤 11：日志输出格式（text/json 二选一）** —— 访问日志与审计日志各加 `format:
text|json` 配置（默认 `text` 保持现状）：
- 访问日志：`pkg/middleware/logger.go` 的 `Formatter` 按 `format` 分支——`text` 沿用
  现有 `clientIP - ts "METHOD PATH" code latency cluster user`；`json` 输出结构化
  字段（`ts, client_ip, method, path, status_code, latency_ms, cluster, user`，同
  §5 访问日志 schema）。
- 审计日志：`pkg/audit/syslog.go` 的 `formatSyslogMessage` 按 `format` 分支——`text`
  沿用 RFC5424 + `key=value` MSG；`json` 时 MSG 输出结构化字段（同 §5 对应 schema）。
- 配置项随各自 sink 走：审计随 syslog/归档配置（`AuditSettingData`）、访问日志随
  访问日志配置；`reloadArchiveConfig()` 一并热生效。klog 不在此列（部署侧
  `--logging-format=json`，零代码，阶段 1 即可带上）。
- 字段集复用 §5 schema，不另维护；不做 nginx `log_format` 式任意模板。

### 10.4 关键设计决策点（供探讨）

1. **序列化上移到 audit 层**（**已定**）：唯一破坏性改动，接受上移，用 syslog 回归
   测试兜底（改造前后输出字节级一致）。
2. **改密日志补外发**（**已定**）：现状 `RecordPasswordChange` 无 hook，补 forward 后
   syslog 与 parquet **同期外发改密记录**（行为变化已知晓并接受）。
3. **多 sink 的 goroutine 模型**：4 个 writer 各起一个 goroutine（简单）；访问日志独立、
   审计 3 类字段不同、建议各自独立。
4. **阶段 2 查询走 ES 还是直读 parquet**：segmentio/parquet-go 可读但检索体验不如 ES；
   建议查询主走 ES、本地/S3 parquet 仅作下载导出。
5. **归档开关默认值**：`enabled` 默认关（开发环境），生产由 `config.yaml` 播种 + charts
   开启，避免存量部署默认写盘。
6. **日志输出格式（text/json）**：改造前三类日志格式均硬编码、不可配置。要做 nginx
   `log_format` 式的任意模板代价高、内网自用价值低，收敛为「输出格式二选一」：
   klog 直接用自带 `--logging-format=json`（部署侧 flag，零代码）；访问日志与审计日志
   加 `format: text|json` 配置（text 保持现状、json 输出结构化字段，字段集同 parquet
   schema）。
   **已按此落地**（2026-09-20）：klog / 访问日志 / 审计 syslog 三类均支持格式二选一，
   默认 `text` 保持改造前行为；现状与链路分工见 §6，实现见 §12.8 步骤 11。

### 10.5 验收标准

阶段 1：
- [ ] 操作/登录/改密三类审计 + 访问日志各自生成 `.parquet`，schema 与 §5 一致。
- [ ] `.tmp` 原子切换，无半写文件；按天分区正确。
- [ ] 滚动清理按审计 7 天 / 访问日志 3 天生效。
- [ ] syslog 输出与改造前一致（回归）；改密日志与 parquet 同期外发 syslog（已定）。
- [ ] 归档失败不影响 MySQL 落库、不回压请求。
- [ ] `go test ./pkg/audit ./pkg/middleware ./pkg/model` 全绿。

阶段 2：
- [x] 本地 RustFS（`9000`）端到端：上传 ✅、上传后删本地 ✅（2026-09-20 实测，见 §12.9）；
  失败重试由 `runArchiveRetryLoop` 周期补传兜底（单测覆盖，未做断网演练）。
- [x] 腾讯云 COS 端到端：上传 ✅、回读校验 ✅（2026-09-21 实测，见 §8.1）；
  期间修复了 `PathStyle` 配置未传给 minio-go 的缺陷（COS 必须 virtual-hosted）。
- [x] **无 ES 时的归档检索**：DuckDB 直接查 parquet（本地热层 + S3 冷层），检索与导出共用
  同一后端接口（2026-09-21，详见 `2026-09-20-single-node-parquet-search.md` §9）。
- [x] **本地清理安全**：配了对象存储后只删「已确认上传」的文件，未上传的宁可占盘也不删
  （避免删掉唯一副本），并计入指标告警（2026-09-21）。
- [x] ES 按天索引可检索 ✅；3 个归档查询接口可用 ✅（实测 `access-log-archive` 返回 394 条）。
- [x] UI 归档区块可配置、密钥掩码回显（代码 + `tsc` / lint 通过；未做人工点击验收）。
- [x] 访问/审计日志 `format: text|json` 切换生效：text 回归无感（字节级回归测试）、
  json 字段与 §5 schema 一致。
- [x] 归档导出 CSV：3 个 `/export` 接口可用，表头与本地导出对齐，响应头带行数、时间范围与
  内容指纹（2026-09-20 实测，见 §12.9）。

### 10.6 预估工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| 阶段 1 | 结构化回调 + parquet writer + 清理 + 接线（含测试） | 3-5 人日 |
| 阶段 2 | S3 + ES + 查询 + UI + 日志格式（含 RustFS 联调与测试） | 5-8 人日 |

## 11. 风险与注意点

- **许可证**：内网自用不登记；首次对外交付时在 `NOTICE` 登记新增三方组件。
- **CGO 依赖的镜像**：DuckDB 检索的 Go SDK 需要 CGO（构建带 `gcc/g++`、运行镜像要
  `libstdc++` + `libc`，不能用 `distroless/static`），因此**默认构建仍是纯 Go 的 CLI 驱动**
  （`CGO_ENABLED=0` 不变），SDK 走 `-tags duckdb_cgo` 显式开启，见
  `2026-09-20-single-node-parquet-search.md` §9.9。
- **不可变文件**：攒批一次性写 + 原子 rename，不同文件追加。
- **不阻塞请求**：`RecordAccessLog`/`forwardAuditMessage` 仅内存 append，磁盘/网络 IO
  全在后台**任务池**里跑；缓冲满丢弃 + 计数，绝不回压请求（详见 §12.10）。
- **网络 IO 不得占用写入循环**：落盘与上传分成两个独立任务池，队列满时同步兜底（宁可慢
  也不丢），见 §12.10。
- **磁盘写满**：清理任务独立于写入协程，写失败退化「丢弃 + 计数 + 告警」。
- **敏感值**：`ResourceYAML/PreviousYAML` 默认排除；S3/ES 密钥 `SecretString` 且不入日志；
  远端归档前评估 `ErrorMessage` 脱敏（与 syslog 同等级别）。
- **多副本**：合成 ID 已按实例标识区分（§12.12，不再撞号）；归档文件名也带上本进程标识，
  共享目录下两个副本不会互相覆盖（§12.15）；周期性全局任务（保留策略巡检）用数据库租约选主、
  只由一个副本执行（§12.15）。sink=parquet 且多副本时归档目录**必须**是共享卷，否则任一副本
  只能查到它自己写的那部分。
- **S3 上传失败**：保留本地 `.parquet`；补传任务每 5 分钟扫一次本地目录，对「S3 上还没有」的
  文件做**幂等补传**（先问存在、不存在才上传），因此进程重启后照样能补齐（`archive_cleanup.go`）。
- **ES 写入失败**：`bulk` 做 3 次退避重试（300ms → 600ms）；4xx 与文档级拒绝不重试（数据问题，
  重试只会白跑）。

## 12. 协作拆分（并行预案 + 实际落地记录）

> **现状说明**：§12.1–12.7 是**两人并行**开发时的切分预案；本方案实际由**单人**一次实现
> 完成。预案保留下来，作为「以后需要并行开发时怎么切」的参考；真实落地情况见 §12.8。

原则：**只保留一个串行点（P0 公共契约），其余按文件 owner 垂直切给两人**，P0 合入后
全程并行、互不阻塞。

### 12.1 三段式（串行点 = P0，半天）

| 段 | 内容 | 人 | 依赖 |
|---|---|---|---|
| P0 | 契约冻结 + 依赖一次性入库 + 配置结构一次性加全（见 §12.2） | A（B review） | 无 |
| P1 | 本地归档线（A） ‖ 外部存储与界面线（B） | A + B | P0 |
| P2 | 接线 S3/ES、端到端联调、验收 | A + B | P1 |

### 12.2 P0 契约冻结清单（未冻结不得开工）

1. `pkg/model/audit_forward.go`：`AuditMessage` 字段（§5）、`AddAuditForwarder(fn)` 签名。
2. `pkg/audit/parquet.go`：`ParquetWriter` 接口签名 + **flush 完成回调**
   `OnFlush(path string, meta FileMeta) error`（S3/ES sink 唯一挂载点）。
3. 目录布局函数 `archivePath(kind, t) → <archive_dir>/<类型>/<年>/<月>/<日>/...`，两人共用，
   避免各写一套。
4. `pkg/model/audit_setting.go`、`pkg/audit/setting.go`：`ArchiveSetting` / `S3Archive` /
   `ESArchive` / `AccessLogArchive` / `FlushSetting` **一次性加全** + `Normalize` 校验规则
   + `format` 字段名与取值（`text|json`）；P1 期间不改结构。
5. 三个归档查询接口契约：URL / query / response JSON（步骤 9 按此实现、UI 按此对接）。
6. `go.mod` / `go.sum`：`segmentio/parquet-go`、`minio-go/v7`、`go-elasticsearch/v8` 由
   A 一次加齐并合 `main`——**依赖变更是冲突高发区，集中到 P0**。
7. 各契约留 stub（返回 `not implemented`），保证 `go build` / `go vet` 绿。

### 12.3 A 线：本地归档（目标 = §10.5 阶段 1 验收全过）

| 步骤 | 文件（A owner） |
|---|---|
| 1 结构化回调 + 序列化上移（唯一破坏性） | `pkg/model/audit_forward.go`、`pkg/audit/syslog.go` |
| 2 parquet writer | `pkg/audit/parquet.go` |
| 3 配置模型实现 | `pkg/model/audit_setting.go`、`pkg/audit/setting.go` |
| 4 滚动清理 | `pkg/audit/archive_cleanup.go` |
| 5 访问日志接入 | `pkg/middleware/logger.go` |
| 6 接线 + klog | `pkg/common/common.go`、`app.go`、`charts/kite/**`、`deploy/**` |
| 11 日志格式 text/json | `pkg/middleware/logger.go`、`pkg/audit/syslog.go` |

`syslog.go` / `logger.go` 只归 A（步骤 1、5、11 同源），避免 format 改动与接入相互冲突。

### 12.4 B 线：外部存储与界面（面向契约开发，不等 A 的运行时接线）

| 步骤 | 文件（B owner） | 独立验证方式 |
|---|---|---|
| 7 S3 上传 | `pkg/audit/s3_archive.go` | 本地 RustFS/MinIO 容器 + 单测；`OnFlush` 回调桩 |
| 8 ES sink | `pkg/audit/es_sink.go` | 本地 ES 容器 bulk 单测 |
| 9 归档查询接口 | `pkg/audit/archive_query.go` + handler | 按 §12.2 契约实现，ES 查询单测 |
| 10 归档配置 UI | `ui/src/**`（审计设置页归档区块） | mock API，`zh.json` 文案 |

B 的 sink 经 P0 的 `OnFlush` 挂载，**不需 A 完成接线**即可自测。

### 12.5 文件 owner 总表（冲突规避）

| 目录 / 文件 | owner |
|---|---|
| `pkg/model/**`、`pkg/audit/{parquet,archive_cleanup,syslog,setting}.go` | A |
| `pkg/middleware/logger.go`、`pkg/common/common.go`、`app.go`、`charts/**`、`deploy/**` | A |
| `pkg/audit/{s3_archive,es_sink,archive_query}.go` + 对应 handler | B |
| `ui/**` | B |
| `go.mod` / `go.sum` | P0 由 A 冻结，之后任何改动双方同步 |

### 12.6 分支与节奏

- P0：`feat/audit-archive-contract` 半天内做完合 `main`，先合先解锁 B。
- P1：A `feat/audit-archive-local`、B `feat/audit-archive-remote`，每日 rebase `main`。
- P2：两分支合 `main` 后联调（或开 `feat/audit-archive-e2e`）。

### 12.7 风险

- **契约漂移**：P1 期间任一方要改 §12.2 任一契约，先同步对方、在 P0 分支统一改，杜绝各改各的。
- **负载不均**：A 偏重（步骤 1 是核心侵入）。若 A 吃紧，把零依赖的**步骤 4 清理**划给 B
  （独立新文件、只读目录约定）。
- **验收归属**：阶段 1 由 A 负责，阶段 2（RustFS/ES/UI/format）由 B 负责，联调共同。

### 12.8 实现落地记录（步骤 1-11 全部完成）

A 线（本地归档）：

| 步骤 | 文件 | 说明 |
|---|---|---|
| 1 结构化回调 | `pkg/model/audit_forward.go`、`pkg/audit/syslog.go`、`pkg/model/password_change_log.go` | `AuditMessage` + `AddAuditForwarder`；序列化上移，回归测试锁定 syslog 字节级输出；改密补外发 |
| 2 parquet writer | `pkg/audit/parquet.go` | 4 类 schema、按天分区、`.tmp` 原子切换、时间/条数/字节三种触发、flush hook |
| 3/6 接线与热加载 | `pkg/audit/archive.go` | `StartParquetArchiver` / `reloadArchiveConfig` / S3 与 ES 挂载 |
| 4 本地清理 | `pkg/audit/archive_cleanup.go` | 按时间 + 容量，审计与访问日志分开 |
| 5 访问日志 | `pkg/audit/access_log.go`、`pkg/middleware/logger.go` | `RecordAccessLog`，非阻塞投递 |
| 11 输出格式 | `pkg/model/audit_setting.go`、`pkg/audit/{access_log,syslog}.go` | `format: text|json` 二选一，默认 text |
| 9 检索界面 | `ui/src/components/settings/archive-query.tsx` | 日志审计新增「归档检索」tab：类型/时间范围/关键字/筛选 + 分页；ES 未启用时给出引导而非空表 |
| 配置播种 | `internal/config.go`、`charts/kite`、`config.dev.yaml` | `auditArchive` 仅在库中仍为默认值时播种；`auditArchiveDir` / `logFile` 注入 |

B 线（外部存储与界面）：

| 项 | 文件 | 说明 |
|---|---|---|
| S3 sink | `pkg/audit/s3_archive.go` | `NewS3Sink` / `ObjectKey` / `Upload` / `EnsureBucket`；不持有本地文件生命周期 |
| ES sink | `pkg/audit/es_sink.go` | `NewESSink` / `IndexName` / `Index`（按天索引 + bulk）；`Search` 在 `archive_query.go` |
| 归档检索接口 | `pkg/audit/archive_query.go` | 3 个 `GET /api/v1/admin/*-archive`，参数与本地列表同构；ES 未启用返回 400 而非空列表 |
| 配置 UI | `ui/src/components/settings/audit-setting.tsx` | 归档区块（本地/访问日志/S3/ES），密钥掩码回显 |
| 契约（P0） | `pkg/model/audit_setting.go` | `ArchiveSetting` 全套结构 + `DefaultArchiveSetting` + `Normalize` 校验 |
| 路由 | `routes.go` | 3 个检索接口挂 `requireAudit` |
| 测试 | `pkg/audit/{s3_archive,es_sink}_test.go`、`pkg/model/audit_setting_test.go` | 假 ES/S3 覆盖 key 拼接、bulk 分天分组、DSL 构造、Normalize 校验 |

**接线方式（已实现）**：

- 每个 parquet writer 挂 `s3FlushHook`：文件落盘后按 `<相对路径>` 上传，成功后按
  `DeleteLocalAfterUpload` 删本地；上传失败保留本地，由清理/补传兜底。
- 审计消息经 `esDocumentFromMessage` 映射为 `ESDocument`，由 ES 攒批 writer
  （满 2000 条或 120s）bulk 写入按天索引 `<indexPrefix>-YYYY.MM.DD`。
- 归档检索接口走 ES；ES 未启用时返回 400 并给出明确原因，而不是返回空列表。
- 依赖：`minio-go/v7`、`go-elasticsearch/v8`、`github.com/parquet-go/parquet-go`
  （`go mod vendor` 已同步）。**必须用 `parquet-go/parquet-go` fork、不要用
  `segmentio/parquet-go`**——原因见 §3（后者在 Go 1.26 链接失败，只能靠 `-tags purego` 绕过）。

**遗留问题（需研发决策）**：

- `SecretString` 放进 `audit_settings.data` 这个 JSON blob **不会**走列级加密（`Value()/Scan()`
  只在独立列上生效），所以库里是明文。当前只在 handler 做了 API 层掩码（读取返回掩码、
  保存时收到掩码则保留原值）。若要真正加密，需给 `audit_settings` 加独立密文列或显式加解密。

### 12.9 本地环境端到端验证记录（2026-09-20）

组件（均为 Docker 容器，单机）：RustFS **1.0.0**（`rustfs/rustfs:latest`，限内存 512 MiB）+
Elasticsearch 单节点（限内存 1.5 GiB）；Kite 以 dev 模式运行，归档目录 `/tmp/kite-archive`。

| 验证项 | 结果 |
|---|---|
| minio-go → RustFS 上传 | ✅ 对象按 `<prefix>/<类型>/<年>/<月>/<日>/<文件名>` 落桶（实测 14 个对象） |
| 上传即删本地（`deleteLocalAfterUpload=true`） | ✅ 上传成功后本地文件数不增长 |
| 上传失败补传 | ✅ `runArchiveRetryLoop` 周期补传（单测覆盖，未做断网演练） |
| ES 按天索引写入与检索 | ✅ `GET /api/v1/admin/access-log-archive` 返回 `total=394` |
| 归档导出（CSV） | ✅ 3 个 `/export` 接口实测导出 443 / 3 / 2 行；表头与本地导出对齐，响应头带行数、时间范围与 HMAC 指纹 |
| 归档单测与编译 | ✅ `go build ./...`、`go vet`、`go test ./pkg/audit ./pkg/model` 全绿 |
| 前端类型与格式 | ✅ `tsc --noEmit`、prettier、eslint 全绿 |

**实测资源占用（容量规划参考）**：RustFS 空载 **77 MiB**、ES 单节点 **1.07 GiB**；访问日志
一个 flush 周期（120s / 20 万条阈值）产出一个 parquet 文件。

**复现命令**（单机 RustFS，注意容器以非 root `10001` 运行，用 named volume 规避属主问题）：

```bash
docker run -d --name kite-rustfs --memory=512m \
  -p 9000:9000 -p 9001:9001 \
  -e RUSTFS_ACCESS_KEY=kiteadmin -e RUSTFS_SECRET_KEY=kiteadmin123 \
  -v kite-rustfs-data:/data -v kite-rustfs-logs:/logs \
  rustfs/rustfs:latest
```

> RustFS 与 ES 都是**可选**组件：只启用本地 parquet 时两者都不需要，额外占用为 0。
> 切换对象存储后记得同步应用里的 accessKey / secretKey，否则上传返回 403。

### 12.10 并发写入优化（2026-09-21）

**背景**：审计日志是**多用户同时操作**时产生的，短时间内的并发写入会集中到同一批 writer 上。

**改造前的问题（写入循环被网络 IO 拖住）**：

```
ParquetWriter.Run（单个 goroutine）
  └─ flush() → writeFile() ─→ runHooks() ─→ S3 上传（网络，几百 ms ~ 数秒，同步阻塞）
  └─ 这期间该类型的 writer 完全停止消费 → 缓冲（4096）填满 → 丢弃记录
```

ES 侧同理：`runESWriter` 单协程里同步做 bulk，一次慢 bulk 就会让 `esBuf`（8192）积压到丢弃。
换句话说，**日志写得越多的部署，越容易在"上传慢"的那一刻丢审计记录**。

**改造后的结构**：

```
Run 协程：只攒批 → 投递「写盘任务」（毫秒级返回）
    写盘池（2 worker，本地 IO）→ 落盘成功 → 投递「上传任务」
                                  上传池（3 worker，网络 IO）→ S3 上传 / ES bulk
```

- 两级**不共享 worker**：网络慢不会反压到磁盘写入；
- 池是「有界队列（256）+ 固定 worker」，**队列满时不丢任务**，改由调用方同步执行（背压）——
  审计记录宁可慢一点，也不能悄悄少一条；
- 停止顺序固定为「先写盘池、后上传池」：上传任务是写盘 worker 落盘后投递的，反了就会让
  这些任务落到一个不再消费的池里。

**实测（对照实验，比只看"跑通了"更有说服力）**：

| 场景 | 结果 |
|---|---|
| 慢上传（每批 100 行 + 20ms 上传）× 8000 条，**关闭任务池**（退化同步） | ❌ 第 5196 条被丢弃——正是改造前的行为 |
| 同一负载，**使用任务池** | ✅ 8000 条全部落盘，`dropped=0` |
| 8 goroutine 并发投递 1600 条 | ✅ 全部落盘、ID 无重复无丢失 |
| 300 个并发请求（3 轮 × 100） | ✅ 丢记录 0、队列积压 0、背压 0、失败 0 |

第一行是**刻意保留的对照**：不做这个对照，就无法证明测试真的能捕捉回归（一个永远通过的
测试等于没有测试）。

**顺带修掉的一个真 bug**：ES 队列满时只打了 `klog.Warningf`，**没有累加 `archiveESDropped`**
——`kite_audit_forward_dropped_total{sink="elasticsearch"}` 因此恒为 0。丢记录是「日志链路
自己坏了」的头号信号，却恰好看不见。现已补上计数，并按每 100 条打点避免刷屏。

**新增指标**（`pkg/audit/metrics.go`）：

| 指标 | 含义 |
|---|---|
| `kite_audit_archive_queue_depth{pool="disk\|upload"}` | 队列积压：持续上涨说明下游跟不上 |
| `kite_audit_archive_queue_backpressure_total{pool=...}` | 队列满而同步执行的次数：**开始增长就是预警** |

这两个指标的意义是**提前发现堵**：积压/背压增长时记录还没丢，是扩容或排查的最佳时机，
而不是等 `dropped` 动了才反应。

### 12.11 审计「存储方式」三选一：不落库（2026-09-21）

**需求**：审计日志的落地方式**三选一且互斥**（数据库 / 本地 parquet / ES），由配置文件在启动时
指定、管理页面**只读可查看**；S3 是 parquet 的可选远端副本（可改）。后续可能增加
openobserve / kafka。

**核心变化**：`sink` 不是 `database` 时**不再写数据库**，记录直接进所选后端。
（注：本节当时只做到了「sink≠database 时不落库」，另外两个通道仍可共存；**真正的互斥**在
§12.13 强制——database 下不再写 parquet/S3/ES。）

| sink | 写入 | 查询 |
|---|---|---|
| `database`（默认） | 只写库（+ syslog / 标准输出外发）——§12.13 起不再同时写 parquet/S3/ES | 库表 SQL |
| `parquet` | 不写库，直接落 parquet（+ 可选 S3 远端副本） | DuckDB 查 parquet |
| `elasticsearch` | 不写库，直接写 ES | ES 检索 |

配置项：`auditSink:` 或环境变量 `AEROLINK_AUDIT_SINK`。取值非法**启动即失败**，不静默回落——
配错了必须让部署者立刻知道，而不是以为配置生效了却写去了别处。

**统一写入口**：`model.RecordAudit`（新增）+ `RecordLogin` / `RecordLoginFailure` /
`RecordPasswordChange`（改造），共覆盖 9 处 `ResourceHistory` 写入点与 3 个既有封装函数。
所有产生审计记录的地方都必须走它，直接 `DB.Create` 会绕过 sink 选择。

**不落库带来的三个必须一并处理的点**：

1. **记录标识与时间要自己补齐**。数据库不再填 `CreatedAt`（缺了归档里的时间是 1970 年）与自增
   主键。ID 用「毫秒时间戳 << 16 | 毫秒内自增」**保持数值类型**——改成 UUID 会让 parquet 的
   `id` 列类型变化，新旧文件在同一次查询里类型不一致会直接报错，属于破坏性 schema 变更。

2. **查询延迟，上限强制 5 分钟**。parquet 是攒批落盘的，检索只能看到"已经落盘"的数据，这个间隔
   就是「刚发生的操作查不到」的窗口。`MaxParquetQueryDelaySeconds = 300` 是产品约束：超了保存
   配置直接拒绝（不做静默夹取）。界面在审计列表上明示该延迟。

3. **筛选参数必须与列表接口一一对齐**。少一个就是「筛了没反应」——那种静默失效比报错更难发现
   （用户以为筛出来了，其实拿到的是全量）。为此补齐了 `resourceName`、`operatorId`、
   `operations`（新增 `opIn` 条件类型：多值 IN / ES terms）。

**读取分派**：3 个列表接口 + 3 个导出接口在 sink≠database 时转由归档后端回答，并把归档的
snake_case 结果**适配成与库查询逐字段一致的 camelCase JSON**（`pkg/audit/audit_view.go`）。
前端因此零改动，只多出两个说明字段：

- `backend`：数据来源（界面显示"数据来自归档（duckdb / elasticsearch）"）
- `queryDelaySeconds`：延迟上限（列表页提示"不含最近约 N 秒内的操作"）

**端到端验证**（独立实例：`sink=parquet` + SQLite，端口 18082）：

| 验证项 | 结果 |
|---|---|
| 3 次登录失败 | HTTP 401 |
| 数据库 `login_records` | **0 条**（确认不落库） |
| 归档文件 | ✅ `login_record/2026/09/21/*.parquet`，内含 3 条记录 |
| `GET /admin/login-logs` | ✅ `backend=duckdb`、`total=4`、字段为 `createdAt/username/result/ip`（camelCase，与库查询同构） |
| `GET /admin/audit-logs` | ✅ `backend=duckdb`、`total=0`（登录记录不在操作日志里，符合预期） |
| 默认 sink 回归 | ✅ 全仓测试通过（`sink=database` 行为不变） |

**顺带修掉一个会导致启动崩溃的既有隐患**：`archiveRuntime.writers()` 曾用
`[]flushHookTarget{r.operation, ...}` 收集再筛选——nil 的 `*ParquetWriter[T]` 装进接口后
**接口本身并不为 nil**，筛选失效，于是对 nil 调 `SetDispatchers` 直接 panic（服务启动即崩）。
`accessLog.enabled=false` + S3 启用时本来就会踩到，只是 sink 选择让某类 writer 不创建才第一次
被触发。已改为逐个判空后再装箱，并给 nil writer 的方法加了防御。

**已知待办**（两项均已在 §12.12 落地，此处保留决策背景）：

- ~~**ES sink 下的保留策略**~~：原先只清了数据库（sink≠database 时库表本来就空，属无害空转），
  过期 ES 索引没人删。现已按保留策略整体删除过期按天索引。
- ~~**多副本下合成 ID 可能撞号**~~：合成 ID 现在切出 10 位放实例标识（主机名 + 进程号散列），
  同一毫秒里两个副本不再撞号。注意这只是**标识**层面的一致：多副本重复归档本身仍未解决（§11）。

### 12.12 ES 索引保留与多副本合成 ID（2026-09-21）

两个遗留项（§12.11 的「已知待办」）的落地记录。

#### a) ES 按天索引的保留

**做法**：保留策略巡检（每天一次，`PruneExpiredAuditRecords`）除了清库表，还删除「整天的
数据都已过期」的 ES 按天索引：

| 环节 | 位置 | 说明 |
|---|---|---|
| 列索引 | `ESSink.listIndices` | `_cat/indices/<前缀>-*?format=json&h=index`，`expand_wildcards=open,closed`（被 ILM 关掉的索引也要能回收）；索引一个都还没有时 ES 返回 404，当作「还没写过」而非错误 |
| 删索引 | `ESSink.DeleteIndicesBefore` | 逐个索引删（一个失败不拖累其它）；对已不存在的索引（`404`）按「已达成」处理——多副本下另一个副本可能刚删掉同一个 |
| 接线 | `pruneExpiredESIndices` | 仅在 `archive.elasticsearch.enabled` 时执行；与库里的删除互不影响，ES 不可达只记日志与指标 |
| 失败可见 | `kite_audit_archive_failures_total{stage="index_delete"}` | 不丢数据，但磁盘只涨不降，必须能从 /metrics 看出来 |

**两个关键取舍**：

1. **粒度只能到「天」**。四类记录（操作/登录/改密/访问）共用同一天的索引，删索引就是删那一天
   的全部文档。因此保留天数取「审计保留天数」与「访问日志保留天数」的**较大值**：粒度做不到
   更细，宁可多留（多占磁盘）也不能把还在保留期内的记录先删掉。想给访问日志单独、更短的
   保留期，只能改用 delete-by-query（代价与文档量成正比，且不回收磁盘），本期不做。
2. **只删认得出来的索引**。前缀不匹配或后缀不是 `YYYY.MM.DD` 的索引一律跳过——同一个 ES 集群
   里可能有别人的索引，保留策略宁可漏删，不能误删。

保留天数为 0（永久保留，默认）时**完全不碰 ES**（连列索引都不请求）。

#### b) 多副本下标：合成 ID 切出实例标识

合成 ID 仍是数值（理由见 §12.11：字符串会破坏 parquet 的 `id` 列类型），但低 16 位的用法
从「毫秒内自增」改成「**实例标识 + 毫秒内序号**」：

```
[41 位毫秒时间戳][10 位实例标识][6 位毫秒内序号]
     与旧布局同一位宽、同一量级：新旧归档文件仍能放在一起按 id 排序
```

- **为什么必须切**：原来的「毫秒 << 16 | 毫秒内自增」在多副本下必然撞号——各副本是独立进程、
  序号都从 1 开始，同一毫秒里写出的记录会拿到相同的 id，而撞号意味着 ES 文档互相覆盖、
  parquet 里出现重复主键。
- **实例标识从哪来**：`fnv(主机名 + 进程号)` 取模到 [1, 1023]（不用 0：旧布局的低 16 位是
  「从 1 开始的毫秒内序号」，标签右移 6 位后最小是 64，刚好避开旧序号的低位区间，
  滚动升级期间新旧副本混跑时不容易碰上）。**刻意不做协调取号**：为拿一个实例编号去依赖
  数据库或 K8s API，等于在审计写入路径上新增一个失败点。代价是仍留下约 `1/1023` 的副本间
  撞号概率，由下文测试的位布局断言与分布断言守住（不依赖随机性）。
- **毫秒内序号从 65536 降到 64**：审计记录是人工操作触发的，到不了 1 毫秒 64 条的量级；真的到了
  就**等到下一毫秒再分配**（自旋，持锁但只等不足 1 毫秒），而不是回绕——回绕等于主动制造撞号。
- **顺带收紧**：时钟回拨（NTP 校时）时沿用上一毫秒继续递增，不再像改造前那样可能在同一毫秒里
  重新从 1 开始分号。

**验证**（`go test ./pkg/audit ./pkg/model`）：

| 用例 | 覆盖点 |
|---|---|
| `TestESSinkDeleteIndicesBefore` | 只删整天过期的索引；边界（一天结束 == 截止时间）删、截止当天留；别人的索引与非法后缀不动；请求带前缀通配 + json + open,closed |
| `TestESSinkDeleteIndicesBeforeWithoutIndices` | 索引还不存在（404）不报错、不发删除请求 |
| `TestESSinkDeleteIndicesBeforeToleratesAlreadyDeletedIndex` | 已被删除的索引算「已达成」，不当失败 |
| `TestESSinkDeleteIndicesBeforeKeepsGoingAfterFailure` | 一个索引删失败（403）仍继续删其它，并把失败返回 |
| `TestESIndexRetentionDays` | 保留天数取审计与访问日志的较大值 |
| `TestPruneExpiredAuditRecordsDeletesExpiredESIndices` | 保留策略端到端：0 天完全不碰 ES，90 天时删掉过期索引 |
| `TestSyntheticAuditIDLayout` | id 位布局：时间戳可还原、不同实例在同一毫秒得到不同 id |
| `TestAuditInstanceTag` | 实例标识恒定、落在 [1, 1023]，且散列不退化 |
| `TestNextSyntheticAuditIDIsMonotonicAndUnique`（既有） | 单进程内单调且不重复（序号用尽时靠等到下一毫秒） |

### 12.13 通道互斥强制 + 落地目标 fail-closed（2026-09-21）

§12.11 实现了「sink≠database 时不落库」，但三个通道仍可共存（database 下还能同时写
parquet/S3/ES）。结果是同一批审计记录散在多处、**每处都不全**，而“哪一份算准”取决于查的人。
本节把互斥真正**强制**，并补上由此暴露的几个缺口。

#### a) 通道由 sink 唯一决定

| sink | 生效通道 | 另外两个 |
|---|---|---|
| `database` | 只落库（+ syslog / 标准输出外发） | 归档运行时**根本不建**（`reloadArchiveConfig` 提前返回） |
| `parquet` | 本地 parquet，可叠加 S3 远端副本 | 不建 ES writer |
| `elasticsearch` | 只写 ES | 不建 parquet writer、不建 S3 |

- `model.AuditSinkUsesParquet()` / `AuditSinkUsesElasticsearch()` 是唯一判据；查询侧
  （`describeArchiveBackends` / `currentArchiveSearcher`）、保留侧（ES 索引清理）、探测侧
  （`probeArchiveTargets`）全部改用它，**不再看 `archive.enabled` / `elasticsearch.enabled`**。
- 三个开关由 `AuditSettingData.ApplySinkExclusivity()` 按 sink 落定：`Normalize`（保存时写入真值）
  与 GET 响应（界面看到的是**真实生效值**）各调一次。为什么是“推导”而不是“报错拒绝”：sink 来自
  配置文件、界面只读，管理员改不了它；报错只会让升级后带着旧值的设置页永远存不下去。
- 界面同步：归档区块顶部直说当前哪些通道生效（`archive.sinkNotice.<sink>`），三个通道开关改成
  由 sink 决定、**置灰不可改**；「存储方式」区块额外列出 sink≠database 时**不可用的能力**。

**迁移影响**（升级前是 database + 归档的部署）：归档链不再写 parquet/S3。需要归档就显式设
`auditSink: parquet`（或 `elasticsearch`）——这正是“一处集中”的代价，也是本节的目的。

#### b) 落地目标不可用 → 启动即失败

互斥之后 sink 就是**唯一**落点，目标不可用等于所有审计记录无处可去（归档链路上的错误只打日志、
不回压请求，静默丢记录正是最坏的结果）：

| 情况 | 旧行为 | 现行为 |
|---|---|---|
| `sink=parquet` 但没有 `localDir` 也无 `AEROLINK_AUDIT_ARCHIVE_DIR` | 日志一行 error，之后记录全丢 | 启动失败（`audit.ValidateSinkTarget` → `klog.Fatalf`） |
| `sink=elasticsearch` 但没有节点地址（或 ES 开关没开） | 日志一行 error，之后记录全丢 | 启动失败；保存时也拒绝（ES 通道由 sink 推导为启用，`normalize` 要求 urls） |

启动校验放在 `app.go`、在 `StartParquetArchiver` 之前（此时 DB 就绪、配置文件与环境变量都已应用）。
运行时另有一层：`newArchiveRuntime` 对 `sink=elasticsearch` 强制 `Enabled=true`，升级前存下的
`enabled=false` 不会再让归档器起不来。

顺带补上一个与互斥同源的空子：`internal/config.go` 的 `applyAuditSink` 现在**忽略配置文件热更新里的
sink 变更**（只警告、保持启动值）。理由是热改会产生半生效状态：`model.AuditSink` 变了、归档运行时
却没重建，例如 database→parquet 的热切换会让之后的审计记录**直接丢掉**。切换存储必须重启。

另一个让环境变量失效的漏点也一并修掉：不提供配置文件时 `applyConfig` 根本不会跑（`LoadConfigFromFile`
在 path 为空时直接 return），所以「只设 `AEROLINK_AUDIT_SINK`、不挂 `config.yaml`」的部署会静静按 database
跑——部署者以为切了存储，实际没切。现已补在 `LoadConfigFromEnv` 里（有配置文件时走
`LoadConfigFromFile`，两条路 app.go 只会走一条）。回归用例：`TestLoadConfigFromEnvAppliesAuditSink`
（去掉那一行就会失败，做过对照）。

#### c) 资源级变更历史：sink≠database 时明确说“不可用”

`GET /:namespace/:name/history`（`generic_resource_handler_history.go`、`cr_handler.go`）直读
`resource_histories`，切 sink 后恒为空——界面会显示“暂无历史记录”，让人以为资源从未被改过。
现在在 handler 最前面判定，返回 **501 + `code=resource_history_requires_database_sink`**；
前端（`resource-history-table.tsx` + `translateError`）据此给出说明文案。

为什么不做成“查归档”（虽然理论上 parquet 能查）：四类记录共用归档 schema，但操作日志的
`resource_yaml/previous_yaml` **默认不归档**（`includeResourceYAML=false`），**ES 文档则按设计
永不含 YAML**——两者都撑不起“变更前后对比 → 回滚”。要支持得先打开 YAML 归档、再把该接口
接到 DuckDB 后端，并接受“只能查到归档保留期内的变更”；本期不做，先在界面上如实告知。

同理，sink≠database 时**异地登录提醒**不再触发（`RecordLogin` 的 `isNewIP` 需要历史登录记录，
不落库时直接返回 false）——已在「存储方式」区块一并列出。

#### d) S3 默认值反转

需求口径是「配了 S3 就本地保留最近几天，同时把所有文件同步到 S3」，因此
`DefaultArchiveSetting().S3.DeleteLocalAfterUpload` 从 `true` 改为 **`false`**：
本地留 `retentionDays` 天（默认 7），S3 是长期归档；本地优先、本地没有的日期回落 S3 查询。
上传成功会落 `.uploaded` 标记，本地清理**只删带标记的**，避免删掉“S3 上还没有”的唯一副本。
（想回到「上传即删、本地只作中转」就显式设为 `true`。）

#### 验证

| 用例 | 覆盖点 |
|---|---|
| `TestApplySinkExclusivity`（`pkg/model`） | 三个通道全开的配置在三种 sink 下各自收敛；sink=es 缺地址时保存被拒 |
| `TestNewArchiveRuntimeFollowsSink`（`pkg/audit`） | database 不建运行时；parquet 不建 ES、建 S3；elasticsearch 不建 writer/S3 |
| `TestValidateSinkTarget`（`pkg/audit`） | 三种 sink 的目标可用性判定（含环境变量默认目录） |
| `TestListHistoryRequiresDatabaseSink`（`pkg/resources`） | sink≠database 时 `/history` 返回 501 + code |
| 既有用例同步 | `TestNormalizeRejectsInvalidArchive`（按 sink 分组的必填项）、`TestProbeArchiveTargetsReportsUnreachableBackend`、`TestPruneExpiredAuditRecordsDeletesExpiredESIndices`、`TestDefaultAuditSettingArchiveDefaults`（S3 新默认） |

### 12.14 新增两个落地方式：VictoriaLogs / OpenObserve（2026-09-21）

§12.13 把「通道互斥」真正强到三个通道；本节把它扩到**五个**，并把取值与配置样例写全。

#### a) sink 取值（五选一，互斥）

| sink 取值 | 写哪里 | 查询走哪个后端 | 过期谁删 |
|---|---|---|---|
| `database`（默认） | 库（+ syslog / 标准输出外发） | 库表 SQL | 本进程（库表 DELETE） |
| `parquet` | 本地 parquet（S3 为可选远端副本） | DuckDB | 本进程（文件滚留） |
| `elasticsearch` | ES 按天索引 | ES | 本进程（删过期索引） |
| `victorialogs` | VictoriaLogs 单 stream | LogsQL | **服务端** `-retentionPeriod` |
| `openobserve` | OpenObserve 单 stream | OO 自己的搜索接口 | **服务端** stream `data_retention` |

#### b) 怎么设（照抄即可）

配置文件（`config.yaml` 的 `auditSink`，**优先**）或者环境变量 `AEROLINK_AUDIT_SINK`，都在**启动时**生效，
管理页面只读。五种取值对应的完整配置段见仓库根目录 `config.dev.yaml`（①〜⑤）；环境变量方式的
换行写法与取值清单见 `dev.env`、`charts/kite/values.yaml` 与 `deploy/*.yaml` 的注释。

最小可抄两段：

```yaml
# ④ VictoriaLogs（VictoriaMetrics 体系里的日志存储，默认 9428；**不是** VictoriaMetrics）
auditSink: victorialogs
auditArchive:
  victorialogs:
    urls: ["http://victorialogs:9428"]   # 必填，否则拒绝启动
    stream: aerolink-audit                   # 单 stream，四类记录靠 kind 区分

# ⑤ OpenObserve（默认 5080）
auditSink: openobserve
auditArchive:
  openobserve:
    urls: ["http://openobserve:5080"]    # 必填，否则拒绝启动
    org: default
    stream: aerolink-audit
    username: kite@example.com
    password: ${AEROLINK_OPENOBSERVE_PASSWORD}
```

只设环境变量时：`AEROLINK_AUDIT_SINK=victorialogs`（或 `openobserve`）。注意与 parquet / ES 同理：
**只有环境变量、不挂配置文件**也会生效（§12.13 b 修过的那个漏点）；多副本部署每份副本都要写同一个值。

#### c) 与既有约定一致的地方

- **fail-closed**：urls 为空 → `ValidateSinkTarget` 直接拒绝启动（同 parquet / ES）。
- **检索不可跳过**：sink≠database 时三个列表页、三个导出接口、归档检索页全走归档后端，
  所以两家都实现了 `archiveSearcher`；后端注册表扩到四个（es / duckdb / victorialogs /
  openobserve），auto **跟随 sink**，显式指定别的后端会被带着原因拒绝（不默默换一个）。
- **凭据**：统一走 `SecretString`（读取掩码、不回显、不进日志），换了组织/地址/用户名却沿用
  掩码密码时保存被拒（`rejectStaleSecretAfterMove`）。
- **不新增第三方库**：两个 sink 都是纯 HTTP（`net/http` + `encoding/json`），无 AGPL/SSPL 风险。
- **不按天分名**：单 stream + 服务端分区；客户端拼日期只会把 stream 数放大几千倍。

#### d) 保留策略的边界必须说出来

这两家都没有「删除过期数据」的客户端接口，所以 `audit_settings.retentionDays` **对它们不生效**。
静默失效正是本项目最忌讳的，因此后端在审计设置响应里给出 `retentionServerSide`，
界面在保留策略区块直接说明「过期由服务端负责（VictoriaLogs 的 -retentionPeriod、OpenObserve 的
stream data_retention）」。`pruneExpiredESIndices` 保持 ES 专用，**不**为这两家加删除逻辑。

#### 验证

| 用例 | 覆盖点 |
|---|---|
| `TestApplySinkExclusivity`（`pkg/model`） | 五条通道全开的配置在五种 sink 下各自收敛到唯一通道 |
| `TestNormalizeRejectsInvalidArchive`（`pkg/model`） | 两个新通道生效却没有地址时保存被拒 |
| `TestValidateSinkTarget`（`pkg/audit`） | 两个新 sink 缺地址 → 启动失败 |
| `TestNewArchiveRuntimeFollowsSink`（`pkg/audit`） | 只建 sink 对应的那个 documentSink |
| `TestArchiveBackendFollowsSink` / `TestCurrentArchiveSearcherRejectsForeignBackend` / `TestParseArchiveBackend`（`pkg/audit`） | 检索后端跟随 sink；指定别的后端带原因拒绝 |
| `TestProbeArchiveTargetsFollowsSink`（`pkg/audit`） | 保存后只探测当前 sink 那条通道 |
| `VictoriaLogsSink` / `OpenObserveSink` 单测（假 HTTP 服务） | 端点路径、请求体形状、分页、总数解析、重试策略、错误标记 |

实现细节、接口核实与 OpenObserve 的版本隔离方案见
`docs/dev/plans/2026-09-21-additional-audit-log-sinks.md`。

### 12.15 多副本：写入分区、周期性任务选主（2026-09-21）

§11 原先把多副本问题写成「各副本各写一份，重复归档」，并打算用「选一个副本写归档」来解决。
动手前先把事实核清了，结论与原先的假设**相反**，方案也随之改成三件独立的事。

#### a) 先纠正前提：请求路径上的记录本来就不会重复

| 事实 | 依据 |
|---|---|
| 审计消息只在**产生它的那个副本**上投递 | `model.forwardAuditMessage` 遍历的是本进程注册的回调（`auditForwarders` 是进程内切片），既没有跨副本广播，也没有「轮询新审计行」的机制 |
| 绝大多数记录产生在各自的请求路径上 | `RecordAudit` 的调用点：`middleware/audit.go`、`resources/*`（apply/CR/通用/pod 文件）、`audit/setting.go`、认证相关的登录/改密记录——都是处理该请求的那个副本 |
| 因此「只让一个副本写归档」是**错的** | 非主副本上产生的记录会没人写；`sink≠database` 时 `RecordAudit` 不落库，这些记录连库都没有——等于静默丢掉整段审计，比重复严重得多 |
| 真正会重复的是**周期性任务** | 每个副本进程都启动同一批后台循环。定时任务（`ScheduledTask`）早已用 `lock_until` 选主，所以当时唯一没有协调的就是保留策略巡检：N 个副本同时删同一批过期行（互相把对方的删除弄成 0 行），并各自写一条「prune」留痕记录 |

结论：**写入保持「谁产生谁写」**（不重不漏），**只把周期性全局任务选主**。

#### b) 周期性任务选主：数据库租约

| 环节 | 位置 | 说明 |
|---|---|---|
| 租约表 | `pkg/model/leader.go`（`leader_leases`） | 按 `name` 唯一的一行：`holder`（主机名-进程号）、`expires_at`、`renewals` |
| 抢/续约 | `model.AcquireLeaderLease` | 条件是「自己已是持有者」或「租约已过期」，写在同一条 UPDATE 的 WHERE 里：并发时数据库只会让一个副本拿到（`RowsAffected=1`），不需要事务或应用层锁 |
| 续约循环 | `audit.runAuditLeaseLoop` | 10 秒一次，TTL 30 秒（连续三次续不上才允许接管）；持有时 `auditLeading=true` |
| 执行点 | `audit.runRetentionLoop` | 只在 `auditLeading` 为真时跑 `PruneExpiredAuditRecords` |
| 让位 | 进程退出（`ctx.Done`） | 主动删掉自己持有的那行租约，滚动升级时下一个副本不必等 TTL；删的时候带 `holder` 条件，避免误删已被接管的租约 |

两个刻意的取舍：

1. **`renewals` 自增不是装饰**。MySQL 的 `RowsAffected` 统计「值真的变了的行数」，若续约只写
   `expires_at`（时间精度截断时可能写出同一个值）会拿到 0，从而把持有者误判成「丢了租约」。
   自增一列让每次续约必然改变这一行（`TestAcquireLeaderLeaseRenewalAlwaysChangesTheRow`）。
2. **库抖动时保持现状，不主动放弃**。放弃等于保留策略停摆（过期数据只涨不降），而继续跑着的最坏
   情况只是与接管者重复巡检一次（删除幂等）。只有**确认租约已被别人拿走**才让出。错误日志按
   「出问题时一条、恢复时一条」节流，避免每 10 秒刷屏把信号淹没。

#### c) 归档写入：共享目录下的文件名不能撞

写入不选主，就引入了另一个必须先修的问题：多副本共享同一个归档目录时，两个副本完全可能在
**同一秒**各落一个文件。原先的名字是 `<类型>-<时间>-<序号>.parquet`，其中序号是**进程内**计数，
两边算出的名字完全相同——后一次原子 rename 直接覆盖先写好的文件，**丢掉一整批记录且毫无痕迹**
（没有报错、没有指标）。

现在名字是 `<类型>-<时间>-<序号>-<实例标识>.parquet`，实例标识取「主机名 + 进程号」的 FNV 散列
（8 位十六进制，见 `archiveInstanceToken`）。同一台机器上多进程靠进程号区分，跨机器靠主机名；
不用随机数是为了让文件名可复现，便于反查是哪个副本写的。

#### d) 部署前提：sink=parquet + 多副本需要共享归档目录

外部存储（ES / VictoriaLogs / OpenObserve）天然共享，各副本写各自的记录就是完整的；但 parquet 是
**本地文件**：如果每个副本用自己的 `emptyDir`，那么任一副本的检索只能看到它自己写的那部分，
另一个副本的记录看不到（记录没丢，但界面显示不全）。所以 sink=parquet 且 `replicaCount > 1` 时，
归档目录必须是共享卷（RWX PVC / NFS 等）。本项已写入 `charts/kite/values.yaml` 与
`docs/config/env.md`。

#### 验证

| 用例 | 覆盖点 |
|---|---|
| `TestAcquireLeaderLeaseIsExclusive` | 未过期时只有一个副本能持有；持有者可续约；不同租约名互不干扰 |
| `TestAcquireLeaderLeaseAllowsTakeoverAfterExpiry` | 过期后可接管；被接管后原持有者抢不回 |
| `TestReleaseLeaderLeaseLetsAnotherReplicaTakeOver` | 非持有者删不掉别人的租约；持有者释放后立刻可接手 |
| `TestAcquireLeaderLeaseRenewalAlwaysChangesTheRow` | 每次续约都改变行（`renewals` 自增），不会被 MySQL 的 RowsAffected 语义误判 |
| `TestRetentionLoopOnlyPrunesWhenLeading` | 非主副本巡检空转（过期记录原样留存），成为主副本后正常清理 |
| `TestRenewAuditLeaseTracksOwnership` / `...KeepsLeadingWhenDatabaseFails` | 被接管时让出；库报错时保持现状 |
| `TestArchiveFileNameIncludesInstanceToken` | 同一秒 + 同一序号 + 不同实例 → 不同文件名；不同类型/不同批次仍区分 |
| `TestArchiveInstanceTokenDistinguishesProcesses` | 同实例稳定、不同进程/主机不同、长度 8 |

## 13. 后续演进

- **单机检索（不引入 ES）**：评估用 **DuckDB CLI 子进程**直接查本地 / S3 上的 parquet，
  作为单机部署的检索后端（保住纯 Go、静态单二进制、交叉编译等约束）。
  评估文档：`docs/dev/plans/2026-09-20-single-node-parquet-search.md`
  （结论：推荐 CLI 子进程方案；CGO 绑定仅在极致延迟/流式场景才值得）。
- **多副本归档一致性**：已在 §12.15 落地（写入按「记录产生在哪就由谁写」分区；周期性任务选主；
  文件名带实例标识），不再列为待办。
- **更多外部日志存储**：§12.14 已落地 VictoriaLogs / OpenObserve；新增同类存储时按
  `documentSink` + `archiveSearcher` 两个接口实现即可（参照 `pkg/audit/logsink_http.go`）。
- **上传失败补传与 ES 重试**：已在实现中补齐（S3 周期补传 + ES bulk 退避重试），见 §8.1、§8.2。
