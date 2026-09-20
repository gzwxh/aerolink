# 站内信订阅：事件全选 + 「管理员必收」的安全事件

- 状态：**已实现**
- 背景（研发反馈）三条：
  1. 订阅要一个一个事件加，太麻烦 → 要能**全选**；
  2. 没有配置接收者时，除了页面上的即时提示，其它消息**不要**推给管理员（管理员不是默认收件人）；
  3. 有些重要消息，管理员**不能取消**推送。

## 1. 现状与问题

投递口径在上一轮已经改成「只发订阅者」（见 `2026-09-20-console-ux-and-notification-fixes.md` §5），
但两件事没做：

- **界面**：新增订阅一次只能选一个事件（`notifications.events.*` 有 13 个），配一套接收者要点 13 遍；
- **例外**：强制发管理员的那条路径（`notifyAdminsOfMailFailure`）是硬编码的特例，没有明确的规则，
  也没人知道「哪些事件管理员退订不了」。而且它用 `model.ListAdminUserIDs()`（纯 SQL），
  漏掉通过**全局权限绑定组**拿到 admin 角色的账号。

## 2. 三条口径

### 2.1 事件全选（多选 + 批量创建）

- 界面：事件从单选下拉改成**复选框列表**，带「全选」与「已选 N/M」计数；点一次「添加订阅」按选中的事件批量创建。
- 接口：新增 `POST /api/v1/admin/notification-subscriptions/batch`，请求体 `{events[], channel, receiverType, receiverId?, receiver?}`，
  响应 `{created[], skipped[]}`。
  - 语义：`事件 × (渠道, 接收者)` 展开成多条订阅；**已存在完全相同订阅的事件跳过**（判重键 = 事件+渠道+接收者类型+接收者），
    所以「全选」点两次不会留下重复行。
  - 校验复用单条创建的同一套函数（`buildSubscription`）：任何一个事件不合法就整批不写，错误信息带上事件名。
  - 单事件上限 100，挡掉构造出来的超大请求。

### 2.2 没有接收者就不推给任何人

保持上一轮的口径并**在界面上写明**：`没有配置接收者的事件不会通知任何人（管理员也一样）`。
「管理员」不是隐式收件人——只有订阅表里出现才发。

### 2.3 「管理员必收」的安全事件（不可取消）

`model.mandatoryAdminEvents` 是一份**刻意很短**的清单，投递时无条件并上全部管理员的站内信（不看订阅）：

| 事件 | 为什么必须让管理员知道 |
| --- | --- |
| `password_reset_by_admin` | 有人重置了别人的密码 |
| `mfa_reset_by_admin` | 有人解除了别人的动态码绑定 |
| `role_assigned` / `role_unassigned` | 权限被授予或收回（提权痕迹） |
| `mail_delivery_failed` | 系统自身发不出通知，SMTP 可能坏了 |

- **只走站内信**：邮件依赖 SMTP，而这类事件按次群发给全体管理员会变成噪音。
- **仍受全局站内信开关约束**（`notificationSettings.inAppEnabled`）：那是管理员对「整个站内信通道」的显式取舍，
  与「某个事件能不能退订」是两个维度。要连全局开关也绕过，是一行代码的事，但那更像 bug 而不是需求。
- **不可取消的含义**：删掉/停用与它相关的订阅，投递照样发生（有回归测试锁住）。
- 界面：`GET /admin/notification-subscriptions/` 一并下发 `mandatoryEvents`，勾选列表里给这些事件加锁图标，
  已配置订阅列表里也带「管理员必收」标记——否则管理员会以为自己退订成功了。
- 「管理员」的判定：`rbac.AdminUserIDs()`（直接授权 + 全局权限绑定组），已停用账号排除。
  `pkg/rbac` 依赖 `pkg/notification`（handler.go 用了通知接口），反向 import 会成环，所以由
  `app.go` 启动时 `notification.SetAdminUserResolver(rbac.AdminUserIDs)` 注入；未注入时退回
  `model.ListAdminUserIDs()`（只认直接授权）。
  顺带把「邮件发送失败告警」也改用同一个解析器，两条路径口径统一。

## 3. 涉及文件

- 后端：`pkg/model/notification.go`（清单 + 判定）、`pkg/notification/service.go`（强制送达 + 解析器注入点）、
  `pkg/notification/handler.go`（批量创建 + 下发清单）、`pkg/rbac/rbac.go`（`AdminUserIDs`）、`app.go`、`routes.go`
- 前端：`ui/src/components/settings/notification-management.tsx`（多选 + 全选 + 上锁 + 提示）、
  `ui/src/lib/api/notification.ts`（`createNotificationSubscriptionsBatch`、`mandatoryEvents` 类型）、两个 locale
- 文档：本文件、`docs/dev/feature-code-index.md`

## 4. 验证

**单测**

- `pkg/notification/mandatory_admin_events_test.go`：零订阅时管理员仍收到强制事件、非强制事件（异地登录）
  在零订阅时**不**发给管理员、删掉订阅后仍送达、停用账号不收、投递走注入的解析器、订阅命中同一人时只写一条、
  清单本身与「异地登录这类不能进清单」。
- `pkg/notification/handler_batch_test.go`：全选批量创建、重复点击全部跳过、非法接收人整批不写并指出事件名、
  空/超量拒绝、列表接口下发 `mandatoryEvents`。
- `pkg/rbac/admin_users_test.go`：`AdminUserIDs` 覆盖「直接授权 + 全局绑定组授权」，排除普通用户与停用账号。

**真机验证**（一次性实例 + curl，未动线上 8080）

| 检查 | 结果 |
| --- | --- |
| 列表接口 | 下发 `mandatoryEvents` 5 项 |
| 「全选」13 个事件 | 新增 13 条；再点一次新增 0、跳过 13 |
| 零订阅时重置他人密码 | 管理员收到 `password_reset_by_admin` 站内信 |
| 零订阅时给用户分配角色 | 管理员收到 `role_assigned` |
| 零订阅时异地登录（非强制） | 管理员**没有**收到 |
| 订阅异地登录给该用户 | 只有该用户收到；管理员仍然没有 |
| 删掉该订阅后再异地登录 | 谁都没收到（含管理员） |
