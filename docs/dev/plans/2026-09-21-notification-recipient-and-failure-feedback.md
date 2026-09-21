# 站内信的收件人口径与失败反馈口径

- 状态：**已实施**（后端与前端均已合入本次工作区，验证见 §11）
- 触发：线上反馈「管理员没有给用户配置站内信规则，用户就收不到任何一条站内信」。
- 结论：两处口径都要改——
  1. 给**当事人**加回**受清单约束**的必达路径，与既有「管理员必收」并列；
  2. 失败反馈统一为「立即弹窗」，站内信只承载「不在场时发生的、与自己相关的事」。

## 1. 现状与根因

站内信有两条写入路径，只有一条不依赖订阅：

| 路径 | 入口 | 收件人怎么定 | 受全局开关约束 |
| --- | --- | --- | --- |
| A. 服务端业务事件 | `notification.SendEvent()`（`pkg/notification/service.go:24`） | **只来自启用的订阅**（`resolveRecipients:71`），例外只有 5 个「管理员必收」事件（`pkg/model/notification.go:388`） | 是（`service.go:30`） |
| B. 前端失败上报 | `POST /api/v1/notifications/client-events`（`pkg/notification/handler.go:551`） | **直写上报者本人**（`:579`），不看订阅 | **否** |

仓库里**没有任何默认订阅的播种逻辑**（`CreateNotificationSubscription` 只被管理接口调用），
所以开箱即用状态下：路径 A 的 13 个事件一条都发不出去，路径 B 只在「自己操作失败」时出现。

根因是上一轮把「受影响用户」这条路径当成 `extras` 一起删掉了
（`plans/2026-09-20-console-ux-and-notification-fixes.md` §5：删掉 `SendEvent` 的 `extras` 参数与
`Recipient` 类型，9 处调用不再传「额外接收人」）。那份文档的「注意」栏自己写明了后果：

> 安全类提醒（异地登录、密码/账号变更）现在必须先有订阅才会发出

本次**不是**把 `extras` 加回来（那会重新变成「任何调用方都能随手群发」），而是给「当事人」这个
确定角色单独开一档、并用清单元数据锁住。

### 1.1 事件与天然收件人（现状）

| 事件 | 触发点 | 天然收件人 | 现在实际谁收 |
| --- | --- | --- | --- |
| `remote_login` | `triggers.go:56` | 本人 | 仅订阅 |
| `password_expiring` / `password_expired` | `triggers.go:191` | 本人 | 仅订阅 |
| `account_expiring` | `triggers.go:162` | 本人 | 仅订阅 |
| `inactive_user_disabled` | `triggers.go:275` | 本人 | 仅订阅 |
| `account_disabled` / `account_enabled` | `users/handler.go:1019` | 本人 | 仅订阅 |
| `password_reset_by_admin` | `users/handler.go:871` | 本人 + 管理员 | 仅管理员 |
| `mfa_reset_by_admin` | `users/handler.go:703` | 本人 + 管理员 | 仅管理员 |
| `role_assigned` / `role_unassigned` | `rbac/handler.go:709` | 本人 + 管理员 | 仅管理员 |
| `session_takeover` | `session_takeover.go:79` | 本人 + 管理员 | 仅订阅（不在必收清单） |
| `mail_delivery_failed` | `service.go:215` | 管理员 | 管理员 ✓ |

12 个事件的当事人收不到，其中 4 处服务端注释明确写着「告知本人」（`users/handler.go:870`、
`:1018`、`triggers.go:250`、`pkg/model/notification.go:38`）。

## 2. 目标口径

### 2.1 三档收件人（并集 + 去重）

| 档 | 来源 | 能否退订 | 说明 |
| --- | --- | --- | --- |
| 订阅者 | `notification_subscriptions`（用户 / 全体用户 / 邮箱） | 能 | 语义收敛为「**额外**收件人」（例如把某事件也发给管理员/某个组） |
| **当事人必收** | 触发点显式传入的那个账号 | 不能 | 本次新增，只对清单内的账号/权限类事件生效 |
| 管理员必收 | `rbac.AdminUserIDs()` | 不能 | 既有，清单不变 |

三档取并集后按用户去重（`dedupeUserIDs`）。两档「必收」都：

- **仍受全局站内信开关约束**（沿用「管理员必收」的既定判断：全局开关是对整个通道的取舍，
  与「某事件能否退订」是两个维度）；
- **只走站内信，不发邮件**：邮件仍完全由订阅决定（避免强制群发邮件）；
- **收件人永远是一个具体账号**。这是相对旧的 `extras` 的关键护栏：强制档不可能因为调用方
  传了「全体」而群发（清单 + 单账号参数共同保证）。

### 2.2 当事人必收清单（`model.targetUserEvents`）

| 事件 | 为什么当事人必须知道 |
| --- | --- |
| `password_reset_by_admin` | 凭据被他人改动，本人要能第一时间发现并申诉 |
| `mfa_reset_by_admin` | 强认证凭据被移除（等保三级） |
| `account_disabled` / `account_enabled` | 账号可用性变化；重新启用后要能看到留痕 |
| `role_assigned` / `role_unassigned` | 权限被授予或收回，不该让人措手不及 |
| `inactive_user_disabled` | 账号被系统关闭，本人必须知道原因 |
| `account_expiring` | 到期后会被停用，需提前处理 |
| `password_expiring` / `password_expired` | 过期后登录受阻 |
| `session_takeover` | 安全事件，原注释即承诺「本人与管理员都会收到」 |
| `remote_login` | 新 IP 登录提醒；**保留 `securitySetting.RemoteLoginNoticeEnabled` 作为总闸**（该开关的语义正是「要不要提醒本人异地登录」，关闭时不进本档） |

**不在清单**：`mail_delivery_failed`（受众只有管理员）、`test`（收件人由管理员在界面填）。

与 `NotificationEventList()` 的关系：13 个事件里 12 个进清单；新增事件默认**不进**，
要在清单里显式加一行——并有一条测试锁住「清单 ⊆ 事件表」。

### 2.3 失败反馈口径

| 场景 | 承载 |
| --- | --- |
| 操作成功 | 瞬时 toast（不变，`error-reporter.ts` 的注释里已写明这是既定交互） |
| 操作失败 | **一律立即 toast 给操作者**（不再有静默失败，也不再有「只有站内信没有弹窗」的页面） |
| 表单/权限预检失败（请求都没发出） | 内联错误或 toast，**不进站内信**（不变） |
| 不在场时发生的、与自己相关的事 | 站内信（§2.2 清单 + 管理员必收 + 订阅者） |

推论：**下线前端失败上报链路**（路径 B）——路径 B 的作用是「先弹一下、再留一条站内信」，
而按新口径请求失败属于「在场发生」，只应给即时反馈；它的存在还让 48 处调用点误以为
失败已经有反馈，从而删掉了失败弹窗。

顺带修掉两个不一致：路径 B **不看** `InAppEnabled`（关掉站内信总开关后铃铛仍然会涨），
以及 `operation_failed` 是「铃铛里只有失败、没有成功」这一怪异语义的来源。

## 3. 后端设计

### 3.1 `SendEvent` / `SendEventTo`

```go
// SendEvent 渲染模板并投递给该事件的订阅者（+ 管理员必收档）。
func SendEvent(event string, variables map[string]string)

// SendEventTo 额外把「当事人」加入必收收件人。
// 只有 model.NotificationEventTargetsUser(event) 为真时才采纳 recipients：
// 非清单事件传入的收件人会被忽略并记一条 V(1) 日志，避免调用方随手把事件
// 变成「必收」（这是旧 extras 参数被删掉的原因，不能再开这个口子）。
func SendEventTo(event string, variables map[string]string, recipients ...uint)
```

- `SendEvent` 变成 `SendEventTo(event, variables)` 的薄封装，既有调用点零改动。
- 新增 `model.TargetUserEvents() []string` 与 `model.NotificationEventTargetsUser(event string) bool`，
  与 `MandatoryAdminEvents()` / `NotificationEventMandatoryForAdmins()` 同形。
- `resolveRecipients(event string, explicit []uint)` 增加第二个参数；在订阅解析之后并入
  `explicit`（仅当事件在清单里），最后统一 `dedupeUserIDs`。
- **当事人不按 `Enabled` 过滤**：`account_disabled` 的当事人此刻就是停用状态，
  若沿用 `resolveSubscriptionUser` 那套 `!user.Enabled → 跳过`，这条消息永远发不出去。
  这也是显式收件人与「按用户订阅」的必要差异，会在代码注释里写明。
- `pkg/notification/handler.go` 的订阅列表接口一并下发 `targetUserEvents`，供前端标注。

### 3.2 触发点改动（10 个事件、9 处）

| 文件:行 | 事件 | 当事人来源 |
| --- | --- | --- |
| `pkg/users/handler.go:703` | `mfa_reset_by_admin` | 已有的 `target` → `target.ID` |
| `pkg/users/handler.go:871` | `password_reset_by_admin` | 已有的 `target` → `target.ID` |
| `pkg/users/handler.go:965` | `account_enabled`（批量恢复） | 循环里的 `u.ID` |
| `pkg/users/handler.go:1019` | `account_disabled` / `account_enabled` | 已有的 `target` → `target.ID` |
| `pkg/rbac/handler.go:709` | `role_assigned` / `role_unassigned` | 已解析的 `user` → `user.ID`（保持现有 `!user.Enabled` 早退） |
| `pkg/notification/triggers.go:56` | `remote_login` | `user.ID`（已在安全策略开关之后） |
| `pkg/notification/triggers.go:162` | `account_expiring` | `user.ID` |
| `pkg/notification/triggers.go:191` | `password_expiring` / `password_expired` | `user.ID` |
| `pkg/notification/triggers.go:275` | `inactive_user_disabled` | `user.ID` |
| `pkg/notification/session_takeover.go:79` | `session_takeover` | `user.ID`（已是入参） |

### 3.3 下线路径 B

- 路由 `routes.go:317`、`HandleCreateClientNotification`（`handler.go:551-585`）、
  `clientEventLimiter` 及其类型（`handler.go:517` 起）、`truncateRunes`（仅此处使用）。
- `model.NotificationEventOperationFailed` 常量：无模板、不在 `NotificationEventList()`，
  删除即彻底退役（历史数据保留，不回填删除）。
- **保留** `model.CreateUserNotification`：`mail_delivery_failed` 的告警仍在用它（`service.go:236`）。
- 前端不再有任何「成功后写站内信」的路径（现状也没有）。

## 4. 前端设计

1. **删掉失败上报链路**：`ui/src/lib/error-reporter.ts`（离线队列 / 指纹去重 / 限流重试）
   整份删除；`ui/src/lib/api-client.ts` 的 4 处调用（`:169`、`:184`、`:224`、`:234`）与
   `ui/src/components/settings/general-management.tsx:130` 的 1 处显式调用一并去掉。
2. **补回失败弹窗**：全仓 **48 处**注释为「操作失败已由 API 客户端统一写入站内信，不再弹窗」
   的调用点，在 `catch` 里补 `toast.error(translateError(error, t))`
   （`translateError` 在 `ui/src/lib/utils.ts:248`，能把后端的错误码翻成中文）。
   两点注意：
   - 少数 `catch` 里有专门分支（如 `resource-delete-confirmation-dialog.tsx:45` 的
     404 → 跳列表），补 toast 时不要把该分支的文案覆盖掉；
   - `namespace-row-actions.tsx:219` 这类 `catch {` 无绑定变量，需要改成 `catch (error)`。
   这 48 处**逐个看一遍**，不做无脑批量替换。
3. **订阅设置页的措辞**：`ui/src/components/settings/notification-management.tsx` 的订阅页签
   现在写的是「没有配置接收者的事件不会通知任何人（管理员也一样）」，新口径下不成立——
   要改成「当事人一定会收到；订阅用于增加额外收件人（管理员 / 全体 / 邮箱）」，
   并对 `targetUserEvents` 里的事件加「当事人必收」标记（与既有「管理员必收」标记并列）。
   涉及 `ui/src/lib/api/notification.ts` 的类型与两个 locale。
4. 其余前端不动：铃铛、未读数轮询、全部已读/清空都保持现状。

## 5. 涉及文件

- 后端：`pkg/model/notification.go`（清单 + 判定）、`pkg/notification/service.go`（并入与去重）、
  `pkg/notification/handler.go`（下线 client-events + 下发 `targetUserEvents`）、
  `pkg/notification/triggers.go`、`pkg/notification/session_takeover.go`、
  `pkg/users/handler.go`、`pkg/rbac/handler.go`、`routes.go`
- 前端：`ui/src/lib/error-reporter.ts`（删）、`ui/src/lib/api-client.ts`、
  `ui/src/components/settings/general-management.tsx`、
  48 处补失败弹窗的组件/页面、`ui/src/components/settings/notification-management.tsx`、
  `ui/src/lib/api/notification.ts`、`ui/src/i18n/locales/{zh,en}.json`
- 文档：本文件、`docs/dev/feature-code-index.md`（通知投递口径那两行）、
  `docs/dev/plans/2026-09-20-console-ux-and-notification-fixes.md` §5（加一行指向本文件）

## 6. 测试计划

**后端**（新增 `pkg/notification/target_user_events_test.go`）

- 零订阅时，`password_reset_by_admin` 的**当事人**收到站内信；
- 零订阅时，非清单事件（如 `mail_delivery_failed` 之外挑一个）即使传了收件人也不发；
- 当事人与订阅命中的是同一人时只写一条（去重）；
- 当事人账号**已停用**时，`account_disabled` 仍然送达；
- `session_takeover` 零订阅时当事人收到、且邮件节流逻辑不变；
- 清单本身：每一项都在 `NotificationEventList()` 里、且不含 `mail_delivery_failed`；
- 全局 `inAppEnabled=false` 时两档必收都不写站内信（与既有行为一致）。

**现有测试调整**：`service_test.go:238/259/273` 调用 `resolveRecipients(event)` → 补第二个参数；
`mandatory_admin_events_test.go` 的既有断言不变（管理员档未改）。

**前端**：48 处补 toast 属机械改动，用组件测试挑 3~4 个代表（删除确认、命名空间行操作、
资源批量操作）断言「失败时出现 toast」；`api-client` 不再上报（删掉相关引用后 `tsc` 通过即可）。
`print-*` 等既有测试不涉及。

## 7. 实施步骤

| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| 1 | 后端：清单 + `SendEventTo` + `resolveRecipients` + 10 处触发点 + 下发 `targetUserEvents` | `go test ./pkg/notification/... ./pkg/users/... ./pkg/rbac/...` |
| 2 | 前端：删上报链路 + 48 处补失败弹窗 + 订阅页措辞与标记 | `vitest run`、`tsc`、`eslint` |

两步可分开合并：第 1 步单独上线即可解决「当事人收不到」；第 2 步纯前端交互口径。

## 8. 验证（真机）

| 检查 | 期望 |
| --- | --- |
| 零订阅 + 管理员重置他人密码 | 当事人收到 `password_reset_by_admin`；管理员仍收到（必收档） |
| 零订阅 + 管理员停用某人账号 | 该账号（已停用）收到 `account_disabled` |
| 零订阅 + 新 IP 登录 | 该用户收到 `remote_login`；关闭安全策略里的异地登录提醒后不再收到 |
| 零订阅 + 给用户分配角色 | 当事人与管理员都收到，且只有一条 |
| 零订阅 + 订阅表为空时跑每日检查 | 密码/账号将到期的用户各自收到一条 |
| 订阅了某事件给「全体用户」 | 该事件照旧群发（订阅档未被强制档影响） |
| 删除一个非清单事件的订阅 | 该事件不再有任何收件人（清单外不强制） |
| 触发一次请求失败（如删除不存在的资源） | 界面立即弹错误 toast；铃铛**不**增加 |
| 关闭站内信总开关 | 两档必收都不写站内信 |

## 9. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 强制档让 `notifications` 表在某天集中增长（例如每日检查命中大量用户） | 强制档每位当事人每天至多一条；日检查本来就一天一次。观察表增长，必要时给「同一事件同一天只写一条」加一层去重 |
| `password_expiring` 在提醒窗口内每天一条（默认 7 天） | 与邮件口径一致，属预期；如嫌吵，另开一版去重 |
| 删掉前端上报后，用户错过瞬时 toast | 这正是本次要的：请求失败属「在场发生」，且 48 处补了弹窗，不再依赖铃铛 |
| 回滚 | 第 1 步：把触发点的 `SendEventTo` 换回 `SendEvent`、清单清空即可（行为回到「只发订阅」）；第 2 步：恢复 `error-reporter.ts` 与 4 处调用 |

## 10. 本次不做

1. ~~**后台任务失败的通知**~~：已在 §12 实施（2026-09-21，同一轮工作的后续）。
2. **事件级别的「静默开关」**：管理员可能希望关掉某些当事人必收事件。
   按「必收」的定义不做；要做得先想清楚哪些能关。
3. **通知去重/聚合**（同一事件多天合并成一条）。
4. **邮件侧的当事人强制投递**：本次只强制站内信。

## 11. 实施结果（2026-09-21）

### 11.1 后端

- `pkg/model/notification.go`：新增 `targetUserEvents`（12 项）与 `TargetUserEvents()` /
  `NotificationEventTargetsUser()`；删除 `NotificationEventOperationFailed` 常量；
  `CreateUserNotification` 保留（`mail_delivery_failed` 仍在用），注释改为只描述这个用途。
- `pkg/notification/service.go`：`SendEvent` 改为 `sendEvent(event, vars, nil)` 的薄封装；
  新增 `SendEventTo(event, vars, recipients ...uint)`；`resolveRecipients(event, explicit)`
  并入当事人档（非清单事件传了收件人则记 `V(1)` 日志并忽略）。
- 触发点 9 处、事件 10 个全部换成 `SendEventTo` 并传当事人（`pkg/users/handler.go` 4 处、
  `pkg/rbac/handler.go` 1 处、`pkg/notification/triggers.go` 4 处、`session_takeover.go` 1 处）。
- 下线路径 B：删掉 `HandleCreateClientNotification`、`clientEventRateLimiter`/`clientEventLimiter`、
  `truncateRunes` 与 `routes.go` 上的路由。
- 订阅列表接口新增下发 `targetUserEvents`。

### 11.2 前端

- 删掉 `ui/src/lib/error-reporter.ts`，去掉 `api-client.ts`（4 处）与
  `general-management.tsx`（1 处）的上报调用；顺带删掉随之失效的 `methodOf`。
- 补回失败弹窗：原计划 48 处，实际共 **61 处**——后来发现还有 13 处同类静默失败
  （另一种措辞的注释 11 处，如 `user-status-panel.tsx`、`user-form-dialog.tsx`、
  `notification-management.tsx` 4 处、`resource-detail-shell.tsx`、`binding-group-management.tsx`、
  `user-detail-dialog.tsx`；以及 `sidebar-customizer.tsx` 里只写 `console.error` 的 2 处）。
- 订阅页：事件勾选列表对清单内事件加「当事人必收」图标与 tooltip，底部补说明；
  `noReceiverHint` 文案从「没有配置接收者的事件不会通知任何人」改为
  「订阅用于增加额外收件人；当事人自己关心的事件由当事人必收保证送达」。
- 两个 locale 同步新增 `targetUser` / `targetUserHint`（i18n 测试会校验键集合一致）。

### 11.3 测试与验证

- 新增 `pkg/notification/target_user_events_test.go`（7 例）：零订阅时当事人收到；
  非清单事件即使传了收件人也不发；与订阅命中同一人只写一条；当事人已停用时
  `account_disabled` 仍送达；`session_takeover` 零订阅时当事人收到；全局开关关闭时两档都不写；
  清单本身（⊆ 事件表、不含 `mail_delivery_failed`/`test`）。
- `service_test.go`：`resolveRecipients` 补第二个参数；把「只发给订阅者」的用例名与注释
  改为「不带当事人的 SendEvent」，以免读者误以为订阅是唯一入口。
- 新增 `ui/src/components/resource-delete-confirmation-dialog.test.tsx`：锁住失败弹窗，
  以及「资源已不存在 → 回列表、不弹删除失败」这条保留分支。
- `go build ./...`、`go test ./pkg/notification/... ./pkg/model/... ./pkg/users/... ./pkg/rbac/...`
  全过；`tsc --noEmit -p tsconfig.app.json` 通过；`vitest run` 380 例全过；
  `eslint`（改动文件）0 error；`prettier --check`（改动文件）通过。

### 11.4 与方案的差异

- 方案 §4 预估 48 处补弹窗，实际 61 处（见 §11.2）；
- 额外修正两处 `catch` 里的过期注释（`audit-filters.tsx` 已有弹窗、`lib/api/core.ts`
  关于「404 会被记进站内信」的说法已不成立）。
- 未动 `cluster-management.tsx` 的既有 prettier 漂移（对 HEAD 基线也不干净，不属本次范围）。

### 11.5 后续

- 真机验证按 §8 的表格跑一遍（零订阅时重置密码/停用账号/异地登录/分配角色/每日检查、
  订阅全体用户仍群发、非清单事件删掉订阅后无人收、请求失败只弹窗不涨铃铛、关总开关两档不写）。
- §10 的四项未做，其中「后台任务失败的通知」在新口径下已经有了天然的收件人（任务创建者），
  已作为 §12 单独一轮做完。

## 12. 后续实施：定时任务失败的通知（2026-09-21）

### 12.1 问题

`pkg/scheduler` 的 Helm 自动升级失败只做两件事：把错误写进 `scheduled_tasks.last_error`
（`manager.finish`）和记一条 klog（`manager.runTask`）。任务在用户不在场时跑，失败后
没有任何通知，用户只能自己想起来去「自动升级」弹窗的「最近错误」里看一眼。

### 12.2 设计取舍

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 收件人 | **任务创建者**（`scheduled_tasks.creator_id`） | 是「不在场时发生的、与自己相关的事」；进 `targetUserEvents`，不依赖订阅 |
| 是否也发全体管理员 | 不发（不进 `mandatoryAdminEvents`） | 「有人在动别人的账号/权限」才需要管理员兜底；这里是用户自己的任务失败，不应变成群发 |
| 触发层 | `Manager.runTask` 的 `err != nil` 分支，**不在 Helm 执行器里** | 调度框架是通用的，写在这一层所有任务类型都自动覆盖（未来的执行器不用记得加） |
| 调度配置错误（`scheduleErr`） | 不通知 | 这类错误不会推进 `next_run_at`，任务会被每轮扫描重复捡起，通知会变成刷屏 |
| 每次失败都发 | 是（不做去重/聚合） | 与 §10 第 3 条的取舍一致；先观察表增长，必要时另开一版「同一任务同一天只写一条」 |

### 12.3 落点

- `pkg/model/notification.go`：新增 `NotificationEventScheduledTaskFailed`
  （`scheduled_task_failed`）→ 加进 `defaultNotificationTemplates`（新增部署与升级后
  由 `EnsureNotificationTemplates` 补种）→ 加进 `NotificationEventList()` 与 `targetUserEvents`；
  `targetUserEvents` 的入选依据从一类扩为两类（账号/凭据变化，以及「当事人自己的东西出了结果」）。
- `pkg/scheduler/scheduler.go`：`notifyTaskFailure`，由 `runTask` 的失败分支调用，
  以 `SendEventTo` 把任务名/类型/集群/对象/失败原因/时间发给 `task.CreatorID`。
  带 `recover()`（调度循环里的 panic 会带崩整个进程），`CreatorID == 0` 时早退。
- 模板变量：`taskName`（空则回落 `task.Key`）、`taskType`、`cluster`、`key`、`reason`、`time`。
  正文不含 `{{username}}`：收件人就是本人。
- 前端：订阅页的事件清单来自后端模板，新事件自动出现并带「当事人必收」标记；
  另在 Helm 自动升级弹窗的说明里加一行「执行失败时会用站内信通知配置这个任务的账号」。

### 12.4 测试

- `pkg/scheduler/failure_notification_test.go`：失败 → 创建者收到一条、事件与
  任务名/集群/失败原因都在正文里、**没有未渲染的 `{{...}}`**（锁住触发点变量名与模板一致）、
  无关用户为零条、`last_error` 仍照旧落库；成功 → 零条。
- `pkg/notification/target_user_events_test.go`：清单断言加上新事件（数量不变式仍成立：
  14 个事件里 13 个是当事人必收，只有 `mail_delivery_failed` 不是）。
- `pkg/scheduler/scheduler_test.go` 的测试库补迁通知相关表。

### 12.5 验证

- `go build ./...`、`go vet ./pkg/scheduler/... ./pkg/model/... ./pkg/notification/...` 通过；
  `go test ./pkg/scheduler/... ./pkg/notification/... ./pkg/model/...` 全过。
- `tsc --noEmit -p tsconfig.app.json`、`vitest run`（380 例）、`eslint`、`prettier --check` 通过。
- 真机：造一个必然失败的自动升级任务（如把 Chart 源指向不存在的仓库），等一个计划时间，
  确认创建者在铃铛里收到一条、且「最近错误」与正文一致。
