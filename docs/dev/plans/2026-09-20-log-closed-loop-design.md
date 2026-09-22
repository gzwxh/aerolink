# 日志闭环设计（谁、何时、从哪、做了什么）

> 目标：让**只采集 stdout / stderr 的日志平台**也能回答「什么时间、哪个用户、从哪个 IP、
> 做了什么操作」；同时让日志链路**自己坏了能被立刻发现**，而不是等真要查日志时才发现缺了一段。
>
> 关联文档：
> - `2026-09-20-audit-log-parquet-archive.md`（审计归档：parquet / S3 / ES / syslog）
> - `2026-09-20-system-log-archive.md`（系统日志）
> - `2026-09-20-single-node-parquet-search.md`（单机检索评估）

## 1. 闭环的判定标准

任意一条成立，才算闭环：

1. 任取一次用户操作，能用同一个 `request_id` 串起：**访问日志 + 审计事件 + 报错日志**。
2. 任取一个用户或 IP，能查到其**全部**登录（含失败）与操作历史——包括已被本地清理、只剩归档的部分。
3. 链路任一段坏掉（丢弃积压、归档失败、ES 连不上、磁盘写满），**5 分钟内**能从指标或告警发现。
4. 导出的取证材料可**离线校验**（文件未被改动 + 确实由本服务器生成）。

## 2. 改造前的三条链路

| | 审计链路 | stdout 链路 |
|---|---|---|
| 载体 | `resource_histories` / `login_records` / `password_change_logs` → 可归档 parquet / S3 / ES | gin 访问日志 + klog |
| 用户 / IP / 操作语义 | ✅ 全有 | ⚠️ 访问日志有用户与 IP 但**只有 HTTP 语义**；klog **无身份** |
| 能否被采集工具收走 | ❌ **不经过 stdout**（登录事件在 syslog 未启用时完全不可见） | ✅ |
| 链路自监控 | ❌ 只有 klog 警告 | ❌ |

**根因**：字段最全的审计链路不在 stdout 上；stdout 上的日志只有 HTTP 语义，且三条链路之间**没有任何关联 ID**。

## 3. 本次落地（2026-09-21）

| # | 内容 | 位置 |
|---|---|---|
| 1 | **审计事件 → stdout sink**（默认开启，json）：操作 / 登录 / 改密三类，非阻塞队列，满时丢弃计数 | `pkg/audit/stdout_sink.go`、`pkg/model/audit_setting.go`（`StdoutSetting`） |
| 2 | **自监控指标**：丢弃 / 失败 / 补传积压全部暴露到 `/metrics` | `pkg/audit/metrics.go` |
| 3 | **`request_id` 贯穿**：中间件生成或复用 `X-Request-ID`，回写响应头；经请求上下文 → gorm `Statement.Context` → 审计事件 → 所有外发通道 | `pkg/middleware/request_id.go`、`pkg/model/request_context.go` |
| 4 | **访问日志补 `user_id`**（用户名会改名，ID 才是稳定主键） | `pkg/audit/access_log.go`、`pkg/middleware/logger.go` |
| 5 | **安全修复**：访问日志归档的 `path` 不再包含查询串（gin 的 `param.Path` 实际带着 `RawQuery`，原注释误以为不含 → token 会进 parquet / S3 / ES / 日志平台） | `pkg/middleware/logger.go` |
| 6 | 审计写入点带上请求上下文（管理接口写操作、通用资源 / CR / apply / Pod 文件操作） | `pkg/middleware/audit.go`、`pkg/resources/*` |

**实测**（同一请求的两条日志，`request_id` 一致）：

```json
{"logger":"audit","event":"audit_history","kind":"audit_history","id":858,"request_id":"e9f80abcf152677a7fb88d2e967603ae","created_at":"2026-09-21T07:27:00+08:00","client_ip":"127.0.0.1","operator_name":"archivetest","operator_id":173,"operation_type":"read","resource_type":"system/audit-log","success":true,"user_agent":"curl/8.4.0"}
```
```json
{"ts":"2026-09-21T07:27:00+08:00","client_ip":"127.0.0.1","method":"GET","path":"/api/v1/admin/audit-logs","status_code":200,"latency_ms":25,"user":"archivetest","user_id":173,"request_id":"e9f80abcf152677a7fb88d2e967603ae"}
```

## 4. 字段契约（交付给运维 / 采集侧）

采集侧据此建索引与分流。**`logger` 字段是分流依据**：`audit` 走审计流，其余走应用流。

### 4.1 审计事件（`logger: "audit"`）

公共字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `logger` | string | 固定 `audit` |
| `event` / `kind` | string | `audit_history` / `login_record` / `password_change_log` / `access_log` |
| `id` | string | 记录主键（ES 的 `_id`，重复投递幂等） |
| `request_id` | string | 请求关联 ID（可能为空：非请求路径产生的事件） |
| `created_at` / `ts` | RFC3339 | 事件业务时间（带时区） |

按 `kind` 的附加字段：

| kind | 字段 |
|---|---|
| `audit_history` | `cluster_name`、`resource_type`、`resource_name`、`namespace`、`operation_type`、`operation_source`、`success`、`error_message`、`client_ip`、`user_agent`、`operator_id`、`operator_name` |
| `login_record` | `user_id`、`username`、`provider`、`ip`、`user_agent`、`result`（成功为 `success`，失败为原因码） |
| `password_change_log` | `user_id`、`username`、`operator_id`、`operator`、`source` |
| `access_log` | `ts`、`client_ip`、`method`、`path`、`status_code`、`latency_ms`、`cluster`、`user` |

### 4.2 访问日志（gin）

`ts`、`client_ip`、`method`、`path`、`status_code`、`latency_ms`、`cluster`、`user`、
`user_id`、`request_id`。

> `path` **不含查询串**（安全考虑，查询串可能带 token）。
> text 格式保持改造前形态（不含 `user_id` / `request_id`）：需要关联能力请把
> 「审计设置 → 访问日志归档 → 输出格式」切到 `json`。

### 4.3 应用日志（klog）

`--logging-format=json` 即可，零代码。应用日志**不携带用户身份**，需要定位「哪个用户的请求触发了这个错误」时，
请用 `request_id` 与访问日志 / 审计事件关联。

## 5. 采集侧建议

- 按 `logger` 分流：`logger=audit` → 审计索引（长期保留）；其余 → 应用索引。
- 审计流的保留期应与归档策略对齐（本地 parquet 7 天 / S3 长期 / 平台建议 ≥180 天）。
- 多副本部署（`replicaCount > 1`）时每个 Pod 都会输出，采集侧需去重或只采一个副本（见第 7 节）。

Fluent Bit 片段（示意）：

```ini
[FILTER]
    Name    rewrite_tag
    Match   kite.*
    Rule    $logger ^audit$ audit.$TAG true

[OUTPUT]
    Name   es
    Match  audit.*
    Index  aerolink-audit
```

## 6. 告警规则（自监控）

指标（`/metrics`，与其它指标共用 `AEROLINK_METRICS_TOKEN` 保护）：

| 指标 | 含义 |
|---|---|
| `kite_audit_archive_written_total{kind}` | 已落盘记录数 |
| `kite_audit_archive_dropped_total{kind}` | **内存缓冲满而丢弃**（数据真丢了） |
| `kite_audit_forward_dropped_total{sink}` | 转发队列满而丢弃（`sink` = `syslog` / `stdout` / `elasticsearch`） |
| `kite_audit_archive_failures_total{stage}` | 失败次数（`stage` = `flush` / `upload` / `index` / `index_delete`） |
| `kite_audit_archive_pending_files` | 最近一次巡检发现的待补传文件数 |

Prometheus 规则建议：

```yaml
groups:
  - name: aerolink-audit-pipeline
    rules:
      - alert: KiteAuditRecordsDropped
        expr: increase(kite_audit_archive_dropped_total[5m]) > 0
        labels: { severity: critical }
        annotations:
          summary: "审计记录因内存缓冲已满被丢弃（数据不可恢复）"

      - alert: KiteAuditForwardQueueFull
        expr: increase(kite_audit_forward_dropped_total[5m]) > 0
        labels: { severity: warning }
        annotations:
          summary: "审计转发队列积压：{{ $labels.sink }} 消费不过来"

      - alert: KiteAuditArchiveFailing
        expr: increase(kite_audit_archive_failures_total[15m]) > 0
        labels: { severity: warning }
        annotations:
          summary: "归档 {{ $labels.stage }} 阶段持续失败"

      - alert: KiteAuditUploadBacklog
        expr: kite_audit_archive_pending_files > 0
        for: 30m
        labels: { severity: critical }
        annotations:
          summary: "补传积压持续 30 分钟未消化：S3 侧可能不可用"
```

## 7. 剩余项

| # | 项 | 说明 |
|---|---|---|
| 1 | **多副本去重** | `replicaCount > 1` 时同一事件每个 Pod 各输出一份（归档与 stdout 同源问题） |
| 2 | ES 索引生命周期（ILM） | 与「本地 7 天 / 平台 180 天」对齐 |
| 3 | klog 请求上下文 | 让应用报错日志直接带 `request_id` / 用户；不做也能靠 `request_id` 关联 |
| 4 | 混合检索体验 | 界面让用户不必关心「查库还是查 ES」 |
| 5 | Helm 等其它审计写入点 | 补齐 `WithContext`（当前仅未带 `request_id`，不影响落库） |

## 8. 非目标（要写清楚，避免误用）

- **stdout 日志不作为合规凭据**：容器重建即丢、权限面大。审计合规仍以**落库 + syslog 外发**为准。
- **不记录请求体与查询串**：防密码、token 进入日志。
- **不做 nginx `log_format` 式任意模板**：格式二选一（`text` / `json`），字段集复用同一套 schema。
