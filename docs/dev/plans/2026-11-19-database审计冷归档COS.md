# database 主存储 + 冷归档 COS（审计「落库 + 不可变副本」）

日期：2026-11-19
状态：**已实现**（决策见 §6；落地范围见 §7）

## 1. 背景

审计记录的落地方式目前是**五选一互斥**（`database` / `parquet` / `elasticsearch` /
`victorialogs` / `openobserve`，见 `2026-09-21-新增审计落地方式.md` §3.1 与
`2026-09-20-审计日志parquet归档.md` §12.13）：`auditSink` 在启动时指定，`ApplySinkExclusivity`
把归档通道开关按 sink 推导，database 下归档整体关闭。

这个互斥带来了一个两难：

- **资源级变更历史 / 平台操作时间列**只查库表 `resource_histories`，因此**只在 sink=database
  时可用**（`rejectUnsupportedResourceHistory` 对非 database sink 直接返回 501）。
- **等保三级安全审计**要求：审计记录留存不少于 6 个月，且要防篡改、防删除。纯 database 主库
  长期留存会膨胀，且只靠「应用层只写不改 + 数据库权限最小化」的抗篡改强度偏弱；对象存储开
  **对象锁定/合规保留（WORM）** 才是更硬的防篡改手段。

因此要在**不放弃 database sink 的两个能力**的前提下，把审计冷归档到腾讯云 COS（开 WORM）做
长期不可变留存。当前代码里 COS 已被 `S3Sink` 原生支持（S3 兼容，`pkg/audit/s3_archive.go`），
缺的只是「database 模式下也能跑归档通道」这一点。

## 2. 目标与非目标

**目标**

- sink=database 时，审计**照常落库**（权威、实时、支撑变更历史/平台操作时间），同时**异步冷归档**
  到 parquet → S3/COS（第二副本，长期不可变，满足 6 个月留存 + 防篡改）。
- 改动局部：只在「归档运行时接线」与「配置互斥语义」两处解耦，不新增存储驱动、不新增依赖。

**非目标**

- 不新增「逐条直写 COS」的 sink（对象存储没有逐条 append 语义，正确形态就是攒批 parquet 对象）。
- 不改动 database 之外四个 sink 的既有行为（它们仍是主存储、仍互斥）。
- 不引入厂商专属 COS SDK（继续走 minio-go 的 S3 兼容，endpoint 指向 `cos.<region>.myqcloud.com`）。

## 3. 现状接缝（为什么改动面很小）

写入分发链在 database 模式下**已经贯通**：

```go
// pkg/model/audit_record.go
func RecordAudit(ctx context.Context, record *ResourceHistory) error {
	if AuditSinkUsesDatabase() {
		return dbWithContext(ctx).Create(record).Error   // → AfterCreate → forwardAuditMessage
	}
	// ... 非 database：合成 ID 后 forwardAuditMessage
}
```

`ResourceHistory`/`LoginRecord` 的 `AfterCreate` 钩子会 `forwardAuditMessage`，而 parquet
forwarder（`StartParquetArchiver` 里的 `AddAuditForwarder(forwardToParquet)`）是**始终注册**的。
真正让 database 模式下归档失效的是两处「主动关闭」：

1. `pkg/audit/archive.go` 的 `reloadArchiveConfig`：`if model.AuditSinkUsesDatabase() { return }`，
   `archiveCurrent` 保持 nil，`forwardToParquet` 空转。
2. `pkg/model/audit_setting.go` 的 `ApplySinkExclusivity`：database 下把 `Archive.Enabled` /
   `S3.Enabled` 强制置 false。

把这两处解耦后，database 落库 → `AfterCreate` → `forwardAuditMessage` → parquet writer →
S3/COS 上传这条链就自动成立，**写入路径本身无需改**。

## 4. 设计

### 4.1 语义：冷归档是「第二副本」，权威仍是数据库

这是对 §12.13「五选一互斥」的一次**有意放宽**，但只放宽 database 这一种：

| sink | 归档通道角色 | 变更 |
|---|---|---|
| database | **可选冷归档副本**（管理员显式开） | 新能力 |
| parquet / es / vl / oo | 主存储（由 sink 推导） | 不变 |

权威性口径：**数据库是唯一权威**，冷归档是尽力而为的异介质副本（异步攒批、失败不回压），
与 `docs/features/audit-and-compliance.md` 里「归档是尽力而为的异介质副本」一致。等保审计时
以库为准、归档用于长期留存与异地防篡改，两者不是「三处都不全」的并列权威。

### 4.2 配置模型

复用现有 `ArchiveSetting.Enabled` 与 `ArchiveSetting.S3.Enabled`，不新增 sink 取值、不新增表列：

- **database sink**：`Archive.Enabled` / `S3.Enabled` 由管理员显式控制（默认 false，即现状）。
- **其它 sink**：`ApplySinkExclusivity` 行为保持不变（由 sink 推导、强制收敛）。

`ApplySinkExclusivity` 改动如下（database 分支不再覆盖归档开关）：

```go
func (d *AuditSettingData) ApplySinkExclusivity() {
	// database：冷归档开关由管理员显式控制，这里不动 Archive.Enabled / S3.Enabled。
	if AuditSinkUsesDatabase() {
		return
	}
	d.Archive.Enabled = AuditSinkUsesParquet()
	d.Archive.Elasticsearch.Enabled = AuditSinkUsesElasticsearch()
	d.Archive.VictoriaLogs.Enabled = AuditSinkUsesVictoriaLogs()
	d.Archive.OpenObserve.Enabled = AuditSinkUsesOpenObserve()
	if !d.Archive.Enabled {
		d.Archive.S3.Enabled = false
	}
}
```

**fail-closed**：database 冷归档开启必须配齐落点，否则拒绝生效/启动——

- 本地目录 `Archive.LocalDir`（或环境变量 `AEROLINK_AUDIT_ARCHIVE_DIR`）非空；
- 目标对象存储 `S3.Endpoint` / `S3.Bucket` 非空（S3 normalize 已要求）、AK/SK 齐全；
- COS 要求 `PathStyle=false`（COS 强制 virtual-hosted，`s3_archive.go` 的 `bucketLookup` 已处理）。

### 4.3 运行时接线（`pkg/audit/archive.go`）

- `reloadArchiveConfig`：删除 database 的 early-return；改为「sink=database 且 `Archive.Enabled`
  为真 → 建 parquet + S3 运行时（不建 docSink）」。`Archive.Enabled=false` 时维持现状（nil）。
- `newArchiveRuntime`：为 database+冷归档 分支设置 `useParquet=true`，复用 `archive.S3.Enabled`
  建 `S3Sink` 并挂 `s3FlushHook`；不进入 `switch model.AuditSink` 的 docSink 分支。

写入侧零改动：`forwardToParquet` → `archiveCurrent.append(message)` 已按 `message.Kind` 分派
到 operation/login/password/access 四个 writer。

### 4.4 资源 YAML

database 模式下 `resource_histories` 已存 `ResourceYAML` / `PreviousYAML`，`operationAuditMessage`
会带上；冷归档**强制写入**资源 YAML（`includeYAML = IncludeResourceYAML || AuditSinkUsesDatabase()`），
满足等保溯源，代价是归档文件变大。界面上该开关在 database 下显示为「已开启且不可关」。

### 4.5 UI

- `ui/src/components/settings/audit-setting.tsx`：存储方式=database 时，「归档」区块不再整体
  置灰，允许开本地目录 + S3/COS；标注「数据库为主、归档为冷副本」。
- `ui/src/components/settings/archive-query.tsx`：database+冷归档开启时归档检索可用（数据来源
  parquet/S3），移除「database 无归档可查」的硬分支（改为「未开启冷归档时提示先开启」）。
- `ui/src/i18n/locales/zh.json`（`en.json` 同步）：新增/调整冷归档文案。

### 4.6 保留与 COS WORM

| 层 | 保留 | 说明 |
|---|---|---|
| 数据库 `resource_histories` 等 | `retentionDays`（建议 180） | 近期可查，支撑两个功能 |
| 本地 parquet | `Archive.RetentionDays` | 仅中转，可按容量/天数滚动 |
| COS | **开对象锁定/合规保留（WORM）**，生命周期 ≥ 180 天 | 长期不可变，等保留存的硬保证；本进程**不删** COS 对象 |

协调原则：**先确认冷归档已上传成功，再允许库侧过期清理**，避免「库删了、归档也没落上」的双失
窗口。落库是同步权威，归档是异步副本，因此库侧保留策略在等保口径下应保守（如 180 天），并依赖
`archiveUploadFailures` / `archiveRetainedUnuploaded` 指标与「已上传标记」兜底。

## 5. 安全性 / 数据一致性

- **凭据**：COS 的 AK/SK 沿用 `SecretString`（`S3Archive.SecretKey`），不进日志、读取掩码。
- **权限最小化**：生产库应用账号建议只授 INSERT/SELECT（不授 UPDATE/DELETE），整批过期由保留
  任务用独立通道执行——配合 COS WORM 形成「应用层只写不改 + 存储层不可变」双保险。
- **多副本**：database 落共享库天然集中；冷归档每副本写自己产生的记录（S3 object key 带实例
  标识，见 `archiveInstanceToken`），共享归档目录时文件名不撞号——与现有 parquet sink 同一约束，
  不引入新问题。
- **一致性**：冷归档异步攒批（默认 120s，parquet 唯一存储时上限 5 分钟由 `MaxParquetQueryDelaySeconds`
  约束；作为副本不受该上限约束，但界面上仍应提示延迟）。

## 6. 待确认（已拍板，保留作决策依据）

1. **配置形态** —— 复用现有 `Archive.Enabled` / `S3.Enabled` 开关，不新增配置键。
2. **资源 YAML** —— 冷归档保留资源 YAML：database 冷归档**强制写入**（等保溯源需要，不可关）。
3. **本地中转** —— 支持「直传 COS、本地不落盘」：新增 `S3Archive.DirectUpload`，攒批在内存里
   编码 parquet 后直接上传（无本地文件，上传失败那一批只计数丢弃）。
4. **归档检索** —— 仅查归档文件（库内近况走三个列表页）；database 冷归档开启后 DuckDB 后端可用。

## 7. 工作量与实施步骤

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| 1 | 配置语义解耦：`ApplySinkExclusivity` database 分支 + `normalizeArchive` 校验 | `pkg/model/audit_setting.go` |
| 2 | 运行时接线：`reloadArchiveConfig` / `newArchiveRuntime` 支持 database+冷归档 | `pkg/audit/archive.go` |
| 3 | 单测：database+冷归档下 runtime 构建、S3 配置 fail-closed、forwardToParquet 分发 | `pkg/audit/*_test.go`、`pkg/model/audit_setting_test.go` |
| 4 | UI：审计设置归档区块 + 归档检索页提示 + i18n | `ui/src/components/settings/audit-setting.tsx`、`archive-query.tsx`、`zh.json`/`en.json` |
| 5 | 文档：本文件、`docs/features/audit-and-compliance.md`、`docs/dev/feature-code-index.md` | — |
| 6 | 部署样例：`config.dev.yaml`、`deploy/config.example.yaml` 增加 database+冷归档 COS 示例 | — |

## 8. 验证

```
go build ./...
go vet ./pkg/audit/... ./pkg/model/... ./internal/...
go test -count=1 ./pkg/audit ./pkg/model ./pkg/resources ./pkg/middleware ./internal
pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json
pnpm --dir ui exec vitest run src/i18n/locales.test.ts
```

端到端：`AEROLINK_AUDIT_SINK=database` + 归档开 S3(COS)，确认 ① 资源变更历史/平台操作时间列
恢复 200；② 操作后本地 parquet 落盘并上传 COS；③ COS 桶开 WORM 后对象不可覆盖/删除；④ 关闭
归档后两个功能仍正常（回归现状行为）。
