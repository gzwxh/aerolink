# 方案：第三方登录（OIDC/CAS/SAML2）的动态码挑战

- 状态：**已实现**（`pkg/auth`、`routes.go`、`ui/` 及两侧测试已同步）
- 相关：`docs/dev/plans/2026-09-19-account-lifecycle-and-login-source-controls.md` §6
  （MFA 策略口径：策略只回答「谁必须绑定 MFA」，绑定之后一律使用）

## 1. 现在的问题

「绑定即使用」覆盖的是**表单类**登录：密码与 LDAP 都能在同一请求里收动态码，所以
只要账号绑定过动态码就一律挑战（见 `mfaChallengeRequiredFor`）。
第三方登录还差一步：OIDC/CAS/SAML2 走的是**重定向流**，回调里只有认证结果，
没法在同一请求里收动态码，因此：

- 已绑定动态码的账号从 OIDC 登录，**直接拿到完整会话**，不验码；
- 回调现在只是清掉浏览器上的提权信任 cookie（`mfa.ClearTrusted`），
  保证敏感操作仍要验码，但**读取类资源在敏感操作之前已经暴露**。

LDAP 的情况不同：它是表单提交，能收动态码，目前只对「第三方 MFA 开关 + 管理员」挑战
（`MFAThirdPartyEnabled`）。本方案不改 LDAP 的既有口径。

### 术语约定

本文的**动态码**指认证器 App 里那个 6 位 TOTP（`pkg/mfa/totp.go` 的 `Verify`，
接受前后各 `OTPVerifyWindow` 个 30 秒步长），对应登录页上 `maxLength={6}` 的
「MFA Code」输入框、接口字段 `mfa_code`、错误码 `invalid_mfa_code`。

它**不是**登录页那个 4 位图形验证码（`loginCaptchaEnabled` + `pkg/auth` 的
`invalid_captcha`）：那个是防机器人猜密码的，与 MFA 无关。pending 状态下
**不要求图形验证码**——票据是一次性且 5 分钟过期，猜码由既有的凭据失败限流兜住，
再加一层只会让已经通过身份源的用户多等一步。

## 2. 可选的实现路径

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（推荐） | 回调发现需要验码时，**不签发会话**，改发一个短时「待验证」票据并 302 到登录页；登录页显示动态码输入，提交到新端点换取会话 | 新端点 + 前端登录页多一个状态 + i18n；改动可测试 |
| B | 回调照样签发会话，但置一个「未完成二次验证」标记，除 MFA 校验接口外全部拒绝 | 要在鉴权中间件里加一个全局标记分支，等于把「受限会话」铺到所有路由，权限模型复杂化 |
| C | 回调后 302 到一个专门的 `/<base>/mfa` 页面 | 需要新页面与路由；方案 A 复用登录页即可，页面数量更少 |

选 **A**：失败路径天然收敛在登录页（用户看得到「需要动态码」与错误原因），
不需要新增页面，也不会产生「半可用会话」。

## 3. 方案 A 的流程

```
GET /api/auth/callback（OIDC 回调）
  ├─ 身份源认证成功 → FindWithSubOrUpsertUser
  ├─ 需要挑战？（user.MFAEnabled && !mfa.IsTrusted(c, user.ID)）
  │    └─ 是：不签发会话，302 → {base}/login?mfa_pending=<票据>
  └─ 否：照现在这样签发会话（并清提权信任 cookie）

POST /api/auth/mfa/verify  { mfa_pending, mfa_code }
  ├─ 票据校验失败/过期/已用过 → 401 mfa_pending_invalid
  ├─ 动态码错误 → 401 invalid_mfa_code（并计入既有的凭据失败限流）
  └─ 通过：mfa.MarkTrusted(c, user.ID) + 走与密码登录相同的会话签发
           （activeSessions.start / LoginUser / 签发 JWT / setCookieSecure）→ 204
```

前端（`ui/src/pages/login.tsx`）：读取 `mfa_pending` 查询参数 →
只渲染动态码输入（隐藏用户名/密码表单）→ 提交到新端点 → 成功后跳转应用根路径。

### 票据（pending ticket）

- 内容：`userID`、签发时间、随机 nonce；用 `common.JwtSecret` 做 HMAC-SHA256 签名，
  形如 `<base64url(payload)>.<base64url(mac)>`。
- 有效期：**5 分钟**（足够输入动态码，不足以成为绕过入口）。
- **一次性**：验证成功后把 nonce 记入内存集合（带 TTL 清理），重放直接拒绝。
  内存实现意味着「多副本部署下票据只能被签发它的那个实例兑换」——对内部部署可接受；
  如果日后要支持多副本，把 nonce 落到 `pending_sessions` 表即可（接口不变）。
- 不复用 `pkg/model/pending_session.go`：那个表是 AI 工具确认用的，语义与生命周期都不同，
  混用会让 AI 侧清理任务顺手删掉登录票据。

### 与既有机制的关系

- `mfa.MarkTrusted` 仍然在验证成功后调用，因此「敏感操作二次验证」（`MFAStepUpEnabled`）
  的时间窗行为与密码登录一致。
- 失败计数走既有的 `credentialLoginAttempts`，与密码登录共享同一套限流口径。
- 账号状态检查（`Enabled` / 有效期 / 角色）继续在会话签发前统一执行——
  即复用 `completePasswordLikeLogin` 的检查，避免两处判定漂移。

## 4. 已确认的取舍

1. **票据 5 分钟、一次性**（已确认）。
2. **LDAP 一并纳入**：LDAP 是表单提交，能在同一请求里收动态码，所以与密码登录统一为
   「绑定即使用」，包括非管理员（`mfaChallengeRequiredFor` 不再区分管理员）。
   `MFAThirdPartyEnabled` 的原有作用保留：即使 LDAP 管理员还没绑定，也要求他先验码
   （强制的绑定引导）。该开关的界面文案说的是「OIDC/CAS/SAML2」，与它实际作用在 LDAP
   上不一致——这是既有的表述问题，本次未改，留给界面侧决定是重新表述还是废弃。
3. **票据失效后的体验**：回到登录页并提示「这次登录已超时，请重新登录」，
   不自动重发身份源登录（已确认）。
4. **`MFAThirdPartyEnabled` 的处理：只改文案**（按实际作用改写成「LDAP 管理员强制绑定
   动态码」，并写明「未绑定的管理员将无法登录」）。行为不变，不动逻辑、不删设置项。
5. **已登录浏览器也要走这次验证**：URL 里带着待验证票据时，登录页不再因为「浏览器里
   已有登录态」而跳走（`ui/src/lib/login-flow.ts` 的 `shouldLeaveLoginPage`）。
   否则用户会看到「点了登录却没让输验证码」。
6. **「一次性」的状态放进数据库**（`model.MFAPendingTicket`）：控制台要多副本部署、
   前面有负载均衡随机分发请求，进程内存里的记录会导致兑换概率性失败。改法是把票据的
   nonce 登记成一行，兑换就是「按 nonce 原子删掉这一行」——多副本下也只有一次能成功。
   （注意：本仓库的部署形态是「单节点 → 计划多节点」，所以这条现在就必须做。）

## 5. 实现落点

| 位置 | 内容 |
| --- | --- |
| `pkg/auth/mfa_ticket.go` | 票据的签发 / 校验 / 兑换（一次性） |
| `pkg/model/mfa_pending_ticket.go` | 票据登记行：`nonce + user_id + expires_at`；兑换即原子删除该行，签发时顺手清理过期行 |
| `pkg/auth/login_handler.go` | 回调里的挑战分支；`VerifyPendingMFA`；抽出 `completeThirdPartyLogin`；`mfaChallengeRequiredFor`（表单类登录的挑战口径） |
| `routes.go` | `POST /api/auth/mfa/verify` |
| `ui/src/lib/api/auth.ts` | `verifyPendingMFA` |
| `ui/src/pages/login.tsx`、`ui/src/lib/login-flow.ts` | 带 `mfa_pending` 时只渲染 6 位动态码输入（并且不被「已登录」的守卫跳走）；错误与「重新登录」引导 |
| `ui/src/i18n/locales/{zh,en}.json` | `login.mfaPending.*` |
| 测试 | `pkg/auth/mfa_ticket_test.go`、`pkg/auth/mfa_login_test.go`（回调延迟签发、错误码不作废票据、一次性、LDAP 口径）|

## 6. 验证

- `pkg/auth/mfa_login_test.go` 或新文件：
  - 回调在需要挑战时**不签发会话**，且 302 到登录页并带票据；
  - 正确动态码 → 204 + 会话 cookie + 提权信任已标记；
  - 错误动态码 → 401 `invalid_mfa_code` 且不签发会话；
  - 同一票据二次兑换 → 401（一次性）；
  - 过期票据 → 401；
  - 不需要挑战的账号（未绑定动态码）行为不变（直接签发会话）。
- 前端：登录页在带 `mfa_pending` 时只渲染动态码输入；提交失败显示本地化错误。
- 每个用例做反证（关掉对应分支必须失败）。实际反证记录：
  - 让回调无条件签发会话 → 用例报 `callback redirected to "/"`；
  - 去掉 nonce 重放检查 → 报 `replay = 204, want 401` 与 `the same nonce was accepted twice`；
  - 去掉票据有效期检查 → 报 `an expired ticket was accepted`；
  - 让 LDAP 只挑战管理员 → 报 `LDAP 普通用户 + 已绑定 = false, want true`。

## 7. 已知边界

- 票据只证明身份源认证通过，本身换不到权限；动态码通过后才作废票据，因此同一张票据在
  5 分钟内允许多次尝试（猜码由既有的凭据失败限流兜住）。
- 登记行随签发顺手清理（过期即删）：这张表的写入只发生在「已绑定动态码的账号走第三方
  登录」时，频率很低，不值得为它再起一个后台任务；即使长期无人登录、过期行堆积，
  它们也只会被 `expires_at > now` 挡掉，不影响正确性。
- 票据在登录页的 URL 上，但 `Referrer-Policy: strict-origin-when-cross-origin` 让跨域
  请求只带 origin、不带查询串，所以开启统计时也不会把票据带出去。
