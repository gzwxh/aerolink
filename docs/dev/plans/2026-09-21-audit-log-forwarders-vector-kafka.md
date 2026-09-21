# 审计日志外发：新增 Kafka（外发方式二选一）+ 多副本设置收敛

日期：2026-09-21
状态：**已实施**（拍板结论见 §7，落地记录见 §9；Vector 本期不做）

## 1. 背景

「日志审计 → 审计设置」页上的**日志外发（syslog）**原先只有 syslog 一种去向。需求是在同一位置
再提供外部外发方式，候选为 **Vector** 与 **Kafka**。

口径与既有一致：外发是**尽力而为**的副本——失败、目标不可达、队列满都只记日志与计数，绝不影响
审计记录落库，也不回压请求（见 `pkg/audit/logforward.go` 的注释）。

## 2. 现状：这是「再加一条外发通道」，不是「再加一个 sink」

| | sink（落点） | 外发（本方案） |
|---|---|---|
| 语义 | 审计记录的**唯一**落点 | 同一批记录的**额外副本** |
| 互斥 | 五选一互斥（见 2026-09-20 方案 §12.13） | **外发方式本身二选一**（§3.1） |
| 决定时机 | 启动期由配置文件决定，界面只读 | 运行期由管理员在界面改，改了热生效 |
| 实现样板 | `pkg/audit/archive.go` + 各 sink | `pkg/audit/logforward.go`、`pkg/audit/stdout_sink.go` |

外发的接线方式：

1. `model.AddAuditForwarder(fn)`：审计记录产生时（落库后 / 或 sink≠database 时直接）在**本进程**触发；
2. 各自的 `chan model.AuditMessage` 队列 + 一个 worker goroutine；
3. 队列满 → 丢弃并计数（`kite_audit_forward_dropped_total{sink=...}`），绝不阻塞；
4. 配置热生效：`applyAuditSettingChanges()` 由 `UpdateAuditSetting`、启动与收敛轮询调用；
5. 配置存在 `audit_settings.data` 这个 JSON blob 里，新增子块**不需要数据迁移**。

因此**不动 sink 枚举**，只在 `AuditSettingData` 上加外发方式的参数（与 `Stdout` 并列）。
与 syslog 一样，外发配置**只从界面维护**，不进 `config.yaml` 的播种段。

### 2.1 顺带发现：多副本下改设置只对一个副本生效

`UpdateAuditSetting` 只在**处理这次请求的那个副本**上重载配置，其它副本的内存里还是旧值（它们只在
启动时读一次；`internal.StartConfigWatcher` 盯的是配置文件、不是库里的设置）。结果是：多副本部署下
改外发/归档设置后，只有 1/N 个副本按新配置工作，直到重启才收敛。

**本次一并修掉**（§5）：给审计设置算一个内容指纹，每个副本低频轮询比较，变了才重载。

## 3. 设计

### 3.1 界面组织：一个开关 + 一个「外发方式」二选一（**已拍板**）

```text
日志外发
  [x] 启用外发
  外发方式  [ syslog ▾ ]        ← syslog | kafka
  —— 选中 syslog 时显示 ——
  网络协议 / 输出格式 / 服务器地址 / 标签 / 设施 / 跳过证书校验
  —— 选中 kafka 时显示 ——
  Broker 地址 / 主题 / SASL 认证 / 用户名 / 密码 / 使用 TLS / 跳过证书校验
```

为什么是二选一而不是各自一个开关：同一批审计记录被两条链路各发一份时，运维只看其中一条就会以为
日志齐全了——这与 sink 必须互斥是同一个道理（「日志到处都有、哪里都不全」）。

被放弃的备选（原方案 §3.1 的 (a)）：三个独立分组、各自带开关，可同时外发到多处。代价是页面上会
出现两条链路同时生效的状态，与 sink 的互斥口径不一致。

### 3.2 Vector（**本期不做**）

Vector（`timberio/vector`）作为日志路由器，最合适的接入面是它的 `http_server` source（默认
`0.0.0.0:8686`）：`POST <url>` + NDJSON，正文复用 `esDocumentFromMessage` 的字段映射。

**拍板结论：本期不做**（「Vector 先删除」）。原因是外发方式二选一之后，运维实际只需要一个
「机器人消费端」出口，Kafka 已经覆盖；Vector 的价值在于路由，而那件事可以在 Kafka 之后由消费侧
自己接。若将来要加，按上面的接口形态作为第三种 `mode` 加进来即可（`LogForwardMode` 枚举 +
`vector_sink.go`），不需要动 sink 与既有两种方式的语义。

### 3.3 Kafka（**本期实施**）

- 客户端：**`segmentio/kafka-go`**（MIT、纯 Go、无 CGO）——本次唯一的新增依赖。备选方案都不划算：
  走 Kafka REST Proxy 要额外组件；自己实现 produce 协议不可靠。
- 字段：`enabled` / `mode` / `brokers`（host:port 列表）/ `topic` / `saslMechanism`
  （`none` | `plain` | `scram-sha-256` | `scram-sha-512`）/ `username` / `password`（`SecretString`）/
  `useTLS` / `tlsInsecureSkipVerify`。
- 写入：`kafka.Writer` + 本通道队列（与 syslog 同构）；`RequiredAcks = RequireOne`
  （审计外发不值得为全副本确认付出延迟，丢了本地还有）；消息 **key = `kind`**（同类记录落同一分区，
  顺序稳定），**value = 与 ES / parquet 同一份 JSON**（`auditDocumentJSON`）。
- 两个刻意的取值：`BatchTimeout = 100ms`（worker 是串行的，默认 1s 会让每条白等一秒）、
  `MaxAttempts = 3`（不无限重试：broker 长时间不可达时会把队列堵死直到丢弃，宁可快速失败 + 计数）。
- 连接复用：writer 与 transport 都是并发安全、可长期复用的，**只在配置指纹变化时重建**
  （broker / topic / SASL / 用户名 / 密码哈希 / TLS 任一变化）；配置改了却沿用旧连接池会把日志发到
  旧集群去，属于最难排查的一类问题。
- `useTLS` **默认开**：审计记录含操作者、资源名与来源 IP，明文发到 broker 不是一个可接受的默认值；
  内网明文集群需要显式关掉（关掉是一次看得见的动作）。

### 3.4 公共语义

| 项 | 取值 |
|---|---|
| 阻塞请求 | 否：队列满丢弃并计数 |
| 影响落库 | 不影响（与 syslog / stdout 一致） |
| 访问日志 | **不外发**（与 syslog / stdout 一致，保持现状） |
| 正文格式 | Kafka 只有 JSON，不提供 text（机器消费者，少一个旋钮少一处误配）；syslog 保留 text/json |
| 指标 | `kite_audit_forward_dropped_total{sink="syslog"\|"kafka"}`（复用现有指标，标签取当前生效方式） |
| 保存后自检 | Kafka：连一次 broker + 读 metadata（含 topic）——只给 warning，不阻止保存 |
| 校验 | 启用时 Kafka 要求 brokers 与 topic 非空、SASL 机制合法且给了用户名，否则拒绝保存（`Normalize`）；**只校验当前生效的那一种方式** |

### 3.5 凭据

Kafka 密码一律 `SecretString`：读取掩码、保存收到掩码则沿用库中原值，**换了目标（brokers / topic /
用户名 / TLS 开关）却沿用掩码时拒绝保存**（复用 `rejectStaleSecretAfterMove` 的做法）；变更摘要
（`auditSettingDiff`）为外发块留痕，只记「密码是否变更」，绝不留明文。

### 3.6 JSON 键名兼容（不可改名）

外发这一块在 `audit_settings.data` 里的 JSON 键**仍是历史的 `syslog`**（当时只有 syslog），现在同时
承载 Kafka 参数、由 `mode` 决定用哪一组。改键名会让升级后旧行里的外发配置静默回到默认值——那等于
悄悄关掉外发。字段名与键名不一致这件事已写进 `pkg/model/audit_setting.go` 与 `ui/src/types/api.ts`
两处的注释。

旧行没有 `mode` 也没有 `kafka` 子块：`GetAuditSetting` 先铺一份默认值再 unmarshal，所以
`mode` 落成 `syslog`、`kafka.saslMechanism` 落成 `none`、`kafka.useTLS` 落成 `true`，行为与升级前
一致（有回归测试钉住）。

## 4. 界面与 i18n

- 「日志外发」组：`enabled` 开关 + 外发方式选择器 + 按选择渲染两组字段（§3.1）。
- 前端即时校验：选中方式的关键必填项为空时禁用保存并就地提示（与后端 `Normalize` 同一套规则）。
- 文案：`zh.json` 是唯一事实来源（必须完整），`en.json` 同步（`locales.test.ts` 守键集合一致）。
  选项类文案用嵌套对象（`forwardMode.*` / `kafka.saslMechanism.*`）——i18next 以 `.` 拆键路径，
  写成扁平的 `"mode.kafka"` 会查不到。

## 5. 多副本设置收敛（本次一并实施）

- `model.AuditSettingRevision()`：`audit_settings.data` 的 SHA-256。比较**内容**而不是 `UpdatedAt`
  ——各数据库对时间精度的截断行为不同（MySQL 默认秒级、SQLite 存字符串），用时间戳判断会漏掉同一秒
  内的第二次修改。
- `pkg/audit/setting_watcher.go`：每个副本 30 秒轮询一次指纹，变了才调 `applyAuditSettingChanges()`
  （重载外发 / 标准输出 / 归档）。
- **不能无条件周期重载**：`reloadArchiveConfig` 会停掉并重建归档运行时（`archiveCurrent.stop()` +
  新建 writer），无谓重建会不停切文件、把小批次都冲成单独文件，所以必须先比指纹。
- 保存设置的那个副本自己也要记指纹（`UpdateAuditSetting` 成功后调
  `markAuditSettingApplied()`），否则它会在下一轮把同一份配置再重载一遍。

不采用「选主决定谁写归档」：审计消息是**进程内投递**的，选主会静默丢掉非主副本产生的记录。
多副本写入的正确做法仍是「谁产生谁写」（见 2026-09-20 方案 §12.15）。

## 6. 测试

| 层 | 用例 |
|---|---|
| Kafka | 假 `kafkaWriter` 注入：断言消息 value（JSON 字段集）/ key（分类）、未知分类不投递、写失败向上暴露、配置变了才重建 writer 且旧 writer 被关闭、SASL 机制映射 |
| 外发链路 | 访问日志不进外发、关闭时短路、队列满丢弃并计数、`/metrics` 标签随方式变化、worker 按 mode 分派到 Kafka |
| 模型 | 二选一校验（未知 mode 被拒绝、只校验生效方式、Kafka 必填项、SASL 机制非法）、空 mode / 空机制落成显式取值、**旧行 JSON 兼容**、`AuditSettingRevision` 随内容变化 |
| 收敛 | 指纹未变不重载、指纹变了重载、标记后不重复重载、轮询 tick 触发收敛且 ctx 取消后退出 |
| 设置接口 | 掩码下发（含 Kafka 密码）、掩码还原、换目标要求重填、变更摘要含外发且不含明文 |

## 7. 拍板结论

| 点 | 结论 |
|---|---|
| A 界面组织 | 一个「外发方式」**二选一**选择器（syslog / kafka），共用上层一个 `enabled` 开关 |
| B Vector | **本期不做**（保留 §3.2 作为将来第三种 mode 的设计参考） |
| C Kafka 客户端与认证 | 用 `segmentio/kafka-go`；SASL（plain / scram-sha-256 / scram-sha-512）与 TLS **本期就要** |
| D 访问日志 | **不外发**（保持现状：只发操作 / 登录 / 改密三类） |
| E 多副本收敛 | **修**（§5） |

## 8. 不做的事

- 不做「外发限流 / 采样」：审计事件量很小（相对访问日志不到 1%），先不加旋钮。
- 不做 Kafka 的 compression / 分区器 / 自定义 header 等高级项，需要时再提。
- 不改 sink 枚举与归档链路（互斥语义不动）。
- 外发配置不进配置文件 / 环境变量（与 syslog 一致，只从界面维护）。

## 9. 落地记录（2026-09-21）

| 文件 | 内容 |
|---|---|
| `pkg/model/audit_setting.go` | `LogForwardSetting`（`enabled` + `mode` + syslog 参数 + `Kafka`）、`KafkaSetting`、`LogForwardMode*` / `KafkaSASL*` 常量、`KafkaSetting.normalize()`、`Normalize` 的二选一校验、`AuditSettingRevision()`；`AuditSettingData.Syslog` 改名 `Forward` 但 **JSON 键仍是 `syslog`** |
| `pkg/audit/logforward.go` | 外发公共链路（队列 / worker / 指标 / 按 mode 分派 / `applyAuditSettingChanges`），由原 `syslog.go` 的队列部分抽出 |
| `pkg/audit/syslog.go` | 裁剪为协议层（`sendSyslog` / `dialSyslog` / RFC5424 渲染），新增共享的 `auditDocumentJSON` |
| `pkg/audit/kafka_sink.go` | Kafka 写入（writer 复用与指纹、SASL/TLS、`probeKafkaTarget` 保存后自检） |
| `pkg/audit/setting_watcher.go` | 多副本设置收敛轮询（30 秒 / 指纹比较 / ctx 退出） |
| `pkg/audit/setting.go` | 掩码 / 还原 / 换目标拒绝覆盖 Kafka 密码；`auditSettingDiff` 覆盖外发；保存后调 `applyAuditSettingChanges()` + `markAuditSettingApplied()`；`probeArchiveTargets` 增加 Kafka 探测 |
| `pkg/audit/metrics.go` | `kite_audit_forward_dropped_total{sink=...}` 的标签改为当前外发方式 |
| `app.go` | `StartLogForwarder()` + 各链路启动后 `StartSettingWatcher(ctx)` |
| `ui/src/components/settings/audit-setting.tsx`、`types/api.ts`、`i18n/locales/{zh,en}.json` | 外发方式选择器 + Kafka 字段 + 即时校验 + 文案 |
| 依赖 | `github.com/segmentio/kafka-go v0.4.51`（+ `xdg-go/{scram,stringprep,pbkdf2}` 间接依赖），已 `go mod vendor` |

## 10. 工作量（实际）

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 配置模型 + 校验 + 掩码/摘要留痕 | 完成 |
| 2 | Kafka 通道：kafka-go + 队列/SASL/TLS/指标 | 完成 |
| 3 | 界面 + i18n + 前端校验 | 完成 |
| 4 | 多副本设置收敛轮询 | 完成 |
| 5 | Vector 通道 | **不做**（§3.2） |
