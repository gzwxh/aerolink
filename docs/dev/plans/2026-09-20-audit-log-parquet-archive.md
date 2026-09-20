# 审计/系统日志归档方案（本地 parquet + 外部存储 S3/ES）

日期：2026-09-20
状态：评审通过（未实现）

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
5. S3 上传成功后默认**删本地（上传即删）**，本地仅作暂存中转。
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

- parquet：`segmentio/parquet-go`（纯 Go、Apache-2.0）。
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
                         ├── forwardToSyslog   (已有)
                         └── forwardToParquet  (新增)
                                │ 攒批缓冲
                                ▼
                          parquetWriter goroutine
                                │ flush 成 .parquet
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
        本地目录(默认)     S3/MinIO/COS/OBS    Elasticsearch
        (滚动保留 N 天)   (上传后按策略删本地) (按天索引,检索)
```

`middleware.Logger` 的 `Formatter` 额外调 `audit.RecordAccessLog(param)`，走同一通道，
仅 schema 与滚留阈值独立。

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

- **klog**：`-log_file=/var/log/kite/kite.log -log_file_max_size=512
  -logtostderr=false`，零代码；`/var/log/kite` 挂可写卷。
- **访问日志**：`Formatter` 里调 `audit.RecordAccessLog`，详见
  `docs/dev/plans/2026-09-20-system-log-archive.md` §2。
- **输出格式**：三类日志（klog / 访问日志 / 审计 syslog）当前格式均硬编码、不可配置，
  文本为默认。JSON 化的取舍见 §10.4 决策点 6。

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
**默认「上传即删」**：上传成功即删本地 `.parquet`（`deleteLocalAfterUpload=true`），本地
只作暂存中转、长期保留落在 S3；上传失败则保留本地、由重试任务补传，不丢数据。

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

### 8.2 Elasticsearch（检索，非归档，阶段 2）

审计 + 访问日志结构化写入按天索引 `<indexPrefix>-YYYY.MM.DD`，bulk + 重试 + basic
auth / TLS。ES 是检索面，**不替代** S3 归档与本地 MySQL；与 S3 同期在阶段 2 实现。

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
    DeleteLocalAfterUpload bool  `json:"deleteLocalAfterUpload"` // 默认 true，上传成功即删本地
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

1. **环境变量 / 配置文件**（启动兜底，只读）：`KITE_AUDIT_ARCHIVE_DIR`（本地目录）、
   `KITE_LOG_FILE`（klog 文件路径）。`config.yaml` 增加 `auditArchive` 块作为**初始
   播种值**——DB 无归档配置时写入 `audit_settings`。
2. **`audit_settings` 表（真身）**：管理员在「审计设置」页配置位置、时长、S3/ES 参数；
   该页属阶段 2，阶段 1 界面只读、仅经 `UpdateAuditSetting` 接口或 config 播种写入。
3. 配置改动（接口或页面）经 `UpdateAuditSetting` 触发 `reloadArchiveConfig()` 热生效。

### 9.3 config.dev.yaml 示例

```yaml
auditArchive:
  enabled: false            # 本地开发默认关闭
  localDir: /var/log/kite/archive
  retentionDays: 7
  maxBytes: 10737418240
  accessLog:
    enabled: true
    retentionDays: 3
    maxBytes: 5368709120
  s3:
    enabled: false
    endpoint: http://minio:9000
    bucket: kite-audit
    accessKey: ${KITE_S3_ACCESS_KEY}
    secretKey: ${KITE_S3_SECRET_KEY}
    pathStyle: true
    deleteLocalAfterUpload: true   # 上传成功即删本地（默认）
  elasticsearch:
    enabled: false
    urls: ["http://es:9200"]
    indexPrefix: kite-audit
```

### 9.4 charts / 部署

`charts/kite/values.yaml` 增加 `auditArchive`（含 `persistence` 挂载 + `s3`/`es` 段）；
`deployment.yaml` 注入 `KITE_AUDIT_ARCHIVE_DIR`、`KITE_LOG_FILE` 与 klog `args`
（`-log_file -logtostderr=false`）；`docker-compose.yaml`、`install*.yaml` 同步。

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
`KITE_AUDIT_ARCHIVE_DIR`、`KITE_LOG_FILE`；`StartParquetArchiver()` 启动各 writer +
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
6. **日志输出格式（text/json）**：现状三类日志格式均硬编码、不可配置。要做 nginx
   `log_format` 式的任意模板代价高、内网自用价值低，建议收敛为「输出格式二选一」：
   klog 直接用自带 `--logging-format=json`（部署侧 flag，零代码）；访问日志与审计日志
   加 `format: text|json` 配置（text 保持现状、json 输出结构化字段，字段集同 parquet
   schema），放阶段 2 与查询/UI 同期。

### 10.5 验收标准

阶段 1：
- [ ] 操作/登录/改密三类审计 + 访问日志各自生成 `.parquet`，schema 与 §5 一致。
- [ ] `.tmp` 原子切换，无半写文件；按天分区正确。
- [ ] 滚动清理按审计 7 天 / 访问日志 3 天生效。
- [ ] syslog 输出与改造前一致（回归）；改密日志与 parquet 同期外发 syslog（已定）。
- [ ] 归档失败不影响 MySQL 落库、不回压请求。
- [ ] `go test ./pkg/audit ./pkg/middleware ./pkg/model` 全绿。

阶段 2：
- [ ] 本地 RustFS（`9000`）端到端：上传 → 删本地 → 失败重试。
- [ ] ES 按天索引可检索；3 个归档查询接口可用。
- [ ] UI 归档区块可配置、密钥掩码回显。
- [ ] 访问/审计日志 `format: text|json` 切换生效：text 回归无感、json 字段与 §5 schema 一致。

### 10.6 预估工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| 阶段 1 | 结构化回调 + parquet writer + 清理 + 接线（含测试） | 3-5 人日 |
| 阶段 2 | S3 + ES + 查询 + UI + 日志格式（含 RustFS 联调与测试） | 5-8 人日 |

## 11. 风险与注意点

- **许可证**：内网自用不登记；首次对外交付时在 `NOTICE` 登记新增三方组件。
- **CGO 依赖的镜像**：若引入 CGO 组件（如 DuckDB），构建镜像需带 `gcc`、运行时镜像
  需带 `libc`（放弃 `distroless/static`，改 Debian/Ubuntu slim 等），构建去掉
  `CGO_ENABLED=0`，见 §9.4。纯 Go 选型维持现状零改动。
- **不可变文件**：攒批一次性写 + 原子 rename，不同文件追加。
- **不阻塞请求**：`RecordAccessLog`/`forwardAuditMessage` 仅内存 append，磁盘/网络 IO
  全在后台 goroutine；缓冲满丢弃 + 计数，绝不回压请求。
- **磁盘写满**：清理任务独立于写入协程，写失败退化「丢弃 + 计数 + 告警」。
- **敏感值**：`ResourceYAML/PreviousYAML` 默认排除；S3/ES 密钥 `SecretString` 且不入日志；
  远端归档前评估 `ErrorMessage` 脱敏（与 syslog 同等级别）。
- **多副本**：`replicaCount > 1` 各副本各写一份会重复归档，本期默认单副本，多副本一致性
  留待后续。
- **S3 上传失败**：保留本地 `.parquet`，由下次 flush 或重试任务补传，不丢数据。
