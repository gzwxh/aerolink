# 系统日志（访问日志 + 启动/运行日志）落盘归档方案

日期：2026-09-20
状态：待评审（未实现）
关联：《[审计日志本地 parquet 归档方案](./2026-09-20-audit-log-parquet-archive.md)》

## 0. 一句话结论

你贴的这些行（`IP - 时间 "方法 路径" 状态码 延迟 - 用户`）是 **gin 访问日志**，它和
审计日志**可以完全一样的操作**：在同一个 `Formatter` 里把结构化的请求参数推入同一套
parquet 攒批 sink，本地滚留、收集工具收走半年。

但「项目启动时的输出日志」里还有另一路 **klog 应用日志**（如 `Kite server started on
port ...`、`Version: ...`），它是自由文本，**不适合进 parquet**，改为 klog 自带
`-log_file` 落本地文件（零代码），再由收集工具收走。

即：**两条路都能满足「本地保留一定量 + 收集工具收走半年」，只是介质不同**——访问日志
= parquet，klog = 文本文件。

**已定决策**：访问日志纳入本期 parquet；klog 只落文件（`-logtostderr=false`）；访问
日志滚留阈值单独配置、默认保留 3 天；S3 上传即删本地；外部存储 S3（兼容
MinIO/RustFS/Ceph/COS/OBS/OSS 等）+ ES 走阶段 2。

## 1. 现状：两路日志的输出方式

| 日志 | 产生位置 | 输出目标 | 结构化？ |
|---|---|---|---|
| 访问日志 | `pkg/middleware/logger.go` `Formatter` | `gin.DefaultWriter`（默认 stdout） | ✅ `gin.LogFormatterParams` 全字段 |
| 应用日志 | `klog.*`（`main.go` 已 `klog.InitFlags(nil)` + `flag.Parse()`） | stderr（`logtostderr` 默认 true） | ❌ 自由文本 |

关键点：

- 访问日志的 `Formatter` 拿到的是**已经解析好的结构化参数**（`param.ClientIP`、
  `TimeStamp`、`Method`、`Path`、`StatusCode`、`Latency`，以及 `param.Keys["user"]`
  / `Keys[ClusterNameKey]`），比审计日志还直接——审计日志要改回调签名才能拿到字段，
  访问日志天生就有。
- 访问日志已有一层过滤：`unlogPath`（`/healthz`、`/assets/`、`/favicon.ico`、
  `/metrics`）直接 `return ""` 跳过，parquet 天然复用同一过滤，不会把健康检查刷进归档。
- 频率差异大：访问日志是每请求一条（含前端每 10s 的 session 轮询），比审计日志高几个
  数量级，攒批阈值要单独调（见 §2.3）。

## 2. 访问日志 → parquet（与审计日志同一条通道）

### 2.1 接入点

在 `pkg/middleware/logger.go` 的 `Formatter` 里，除了 `return` 文本行，再调一个
`archive.RecordAccessLog(...)` 把结构化记录推入内存缓冲。示意：

```go
func Logger() gin.HandlerFunc {
    return gin.LoggerWithConfig(gin.LoggerConfig{
        Formatter: func(param gin.LogFormatterParams) string {
            for _, path := range unlogPath {
                if param.Path == path || strings.HasPrefix(param.Path, path) {
                    return ""
                }
            }
            // ...现有 name/cluster 解析...
            // 新增：推入归档缓冲（无阻塞，仅 append 到内存 channel）
            audit.RecordAccessLog(param)
            return fmt.Sprintf("%s - %s ...", ...)
        },
    })
}
```

`RecordAccessLog` 只做「把字段塞进攒批缓冲」，**不做磁盘 IO**，不拖慢请求路径；flush
由后台 goroutine 统一完成，与审计日志共用同一套 writer 基础设施。

### 2.2 schema（`access_log/` 子目录）

| 列 | 类型 | 来源 |
|---|---|---|
| ts | TIMESTAMP(ms) | `param.TimeStamp` |
| client_ip | STRING | `param.ClientIP` |
| method | STRING | `param.Method` |
| path | STRING | `param.Path`（不含 query，与现有文本日志一致，避免 token 入归档） |
| status_code | INT32 | `param.StatusCode` |
| latency_ms | FLOAT | `param.Latency` 换算 |
| cluster | STRING | `Keys[ClusterNameKey]` |
| user | STRING | `model.User.Key()`，匿名 `-` |

`path` 刻意排除 `RawQuery`：query 可能含 token、过滤参数等，现有文本日志也不打，归档
保持一致。

### 2.3 攒批阈值（与审计日志分开）

访问日志量级远高于审计日志，沿用审计日志的「每 10 分钟 / 10 万条」会导致文件过大或
内存积压。建议访问日志单独一套阈值：**每 2 分钟 / 20 万条 / 64 MiB** 触发 flush。
阈值作为配置项，放进访问日志的攒批参数。

### 2.4 与审计日志共用 vs 独立

- **共用**：攒批缓冲结构、flush 流程（`.tmp` 原子写 → rename `.parquet`）、按天分区、
  本地滚动清理、`StartParquetArchiver` 生命周期。这些在《审计日志归档方案》§7 已定义。
- **独立**：缓冲实例（各 sink 各自攒批）、目标子目录（`access_log/`）、schema、flush
  阈值。因为频率与字段完全不同。

因此实现上把 parquet writer 抽成「基础设施 + 按 sink 实例化」，审计 3 类 + 访问日志
各挂一个实例，互不阻塞。

## 3. klog 应用日志 → 本地文本文件（不进 parquet，已定：只落文件）

klog 日志是自由文本，塞进 parquet 只能得到「一行一列 message」的退化 schema，既无
过滤价值也徒增复杂度。正确做法是让它落本地文件，由收集工具按同样规则收走。

`main.go` 已 `klog.InitFlags(nil)` + `flag.Parse()`，因此**零代码**，只需在启动参数
（或 KLOG 环境变量）里加：

```text
-log_file=/var/log/aerolink/aerolink.log
-log_file_max_size=512          # 单个文件上限 MB，触发轮转
-logtostderr=false              # 只写文件、不再重复打 stderr（见下）
```

klog 相关 flag 语义（实现时按最终选型核对）：

| flag | 作用 |
|---|---|
| `log_file` | 日志落文件路径（空 = 不落文件） |
| `log_file_max_size` | 单文件上限，超过轮转（保留旧文件后缀） |
| `logtostderr` | 默认 true；`log_file` 也设置时，两者都写会重复 |
| `alsologtostderr` | 同时写文件与 stderr |

容器场景的选择：

- **只归档、不占运行时日志**：`-logtostderr=false -log_file=...`（日志不再进 stdout/
  stderr，由收集工具从文件收走）。
- **两边都要**（实时看 + 归档）：`-log_file=...`（默认 `logtostderr=true`），stdout/
  stderr 继续进运行时采集，文件供收集工具收走，代价是双份。

**已定：只落文件**（`-logtostderr=false`）：运行时告警由 Prometheus 指标与审计告警
覆盖，避免同一份日志在容器日志系统和归档系统各存一份。

## 4. 配置与部署

配置统一收口到《审计日志归档方案》§9 的 `ArchiveSetting`（`audit_settings` 表为真身、
管理员页面可改），访问日志相关字段在 `ArchiveSetting.AccessLog`：

| 字段 | 含义 | 默认 |
|---|---|---|
| `AccessLog.Enabled` | 是否归档访问日志 | `true`（本期纳入） |
| `AccessLog.RetentionDays` | 访问日志本地保留天数（单独） | `3` |
| `AccessLog.MaxBytes` | 访问日志本地容量上限（单独） | 5 GiB |
| `AccessLog.Flush.*` | 访问日志攒批 flush 阈值 | 120s / 20 万 / 64 MiB |
| `S3.*` / `Elasticsearch.*` | 远端归档/检索（阶段 2） | 见主文档 §9 |

环境变量与 klog 落点：

- `AEROLINK_AUDIT_ARCHIVE_DIR`：本地归档根目录（默认 `/var/log/aerolink/archive`）。
- `AEROLINK_LOG_FILE`：klog 文本日志文件路径（默认空 = 不落文件）。
- klog 启动参数：`-log_file=$AEROLINK_LOG_FILE -log_file_max_size=512 -logtostderr=false`。

charts / compose 同步：

- `auditArchive.enabled` 时，`/var/log/aerolink` 挂可写卷（PVC/hostPath），同时覆盖
  `AEROLINK_AUDIT_ARCHIVE_DIR`（parquet 目录）与 `AEROLINK_LOG_FILE`（klog 文件）两个落点。
- klog 的 `-log_file -logtostderr=false` 由 `args` 注入 deployment。

## 5. 实施计划（与主文档对齐）

**阶段 1（本期）**

1. 复用主文档阶段 1 抽出的 parquet writer 基础设施。
2. `pkg/audit/parquet.go` 增加 `accessLogWriter` 实例（独立缓冲 + 阈值 + schema）。
3. `pkg/middleware/logger.go` 的 `Formatter` 里调 `audit.RecordAccessLog`。
4. `pkg/audit/archive_cleanup.go`：访问日志按 `AccessLog.RetentionDays/MaxBytes`
   单独清理。
5. 配置项 + 启动接线 + 单测（攒批 flush、unlogPath 过滤、schema 字段）。
6. klog 落文件：deployment 注入 `-log_file -logtostderr=false` + 挂载（零 Go 代码）。

**阶段 2（后续）**

7. 访问日志随审计日志一起上传 S3 / 写 ES（复用主文档阶段 2 的 s3/es sink）。

## 6. 风险与注意点

- **不阻塞请求**：`RecordAccessLog` 只能 append 到内存缓冲，磁盘 IO 全在后台 goroutine；
  缓冲满时丢弃 + 计数，绝不回压请求（否则一个慢盘会拖垮整个 API）。
- **频率与磁盘**：访问日志量大，本地滚留默认天数/容量要单独评估，避免比审计日志先
  撑满盘（见 §2.3 的短 flush 周期与 §2.4 的独立清理）。
- **敏感值**：`path` 不含 query（防 token/过滤参数入归档）；`user` 只是用户名/`-`。
- **`Latency` 类型**：`param.Latency` 是 `time.Duration`，parquet 落 `FLOAT` 毫秒，
  与文本日志的展示口径一致。

## 7. 待确认项

1. 访问日志本地保留 3 天已定，容量上限 5 GiB 是否符合预期？
2. klog `-log_file_max_size=512`（MB）是否合适？
3. 访问日志是否与审计日志一起进 S3/ES，还是仅审计日志进远端、访问日志只本地滚动？
