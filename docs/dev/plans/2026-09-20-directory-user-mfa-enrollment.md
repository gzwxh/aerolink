# 方案：目录账号自助绑定 MFA（口径 B + C）

- 状态：**已实现**（后端 + 前端 + 单元/组件测试；反证逐条做过）
- 触发：用户提问「当用户想自己绑定 MFA，需要怎么操作？」，并要求先定口径。
- 相关：`docs/dev/plans/2026-09-19-third-party-login-mfa-challenge.md`（第三方登录动态码挑战）、
  `docs/dev/plans/2026-09-19-account-lifecycle-and-login-source-controls.md`

## 1. 问题（改前的三处硬限制 + 一条死锁）

本地密码账号的自助绑定是通的（头像 → 用户信息 → 安全页签，或被策略强制时由
`ui/src/components/mfa-enrollment-gate.tsx` 挡住整个界面）。目录账号（LDAP / OIDC）则完全做不到：

1. `ui/src/pages/account-page.tsx`：`isPasswordUser` 决定「安全」页签是否可见，
   带 `?tab=security` 进入会被落回 `profile`；
2. `pkg/users/handler.go`：`SetupCurrentUserMFA` / `EnableCurrentUserMFA` /
   `DisableCurrentUserMFA` 都有 `provider != password → 403 mfa is only available for password users`；
3. 绑定的第一步必须提交**当前密码**（`model.CheckPassword`），目录账号在 Kite 里没有密码。

**死锁链路**（改前的真实后果）：

- `pkg/model/security_setting.go` 的 `MFARequiredFor` **只看策略不看 provider**：策略「所有用户」
  时所有账号都必须绑定；
- `pkg/auth/middleware.go` 的 `blockForMFAEnrollment` 对 `mfa_required && !mfa_enabled` 的账号
  拦掉除 5 条路径外的全部 API；
- 前端 `MFAEnrollmentGate` 于 `user.mfa_required && !user.mfa_enabled` 时挡住整个界面，向导索要当前密码。

于是：策略设「所有用户」会把所有 OIDC / LDAP 账号锁死（向导永远走不完），策略设「仅管理员」会
锁死以 OIDC 登录的管理员。改前只能靠关掉通用 MFA 开关、把账号设成 `MFADisabled`、或改库补救。

## 2. 口径（B + C，用户拍板）

**一句话**：策略只回答「谁必须绑定」；绑定之后一律使用（后者已在方向 1 落地）。

- **C：谁能被强制绑定** = 谁能自助绑定，也就是**本地密码账号 + LDAP 账号**。
  OIDC / 第三方身份源的二次验证交给 IdP：既不强制，也不提供自助绑定入口。
  这条落在 `model.(*User).CanSelfEnrollMFA()`，被 `MFARequiredFor` 统一引用，
  因此鉴权中间件、bootstrap 下发的 `mfa_required`、前端门禁自动一致。
- **B：绑定前必须重新认证**，且方式按 provider 区分：
  - 本地密码账号：提交**当前密码**（`model.CheckPassword`），与改前一致，不引入回归；
  - LDAP 账号：要求**最近 5 分钟内重新登录过**（`user_sessions.started_at`）。
    Kite 侧不校验目录口令——重新登录走的是完整的 LDAP 认证（含审计、失败限流、账号有效期、
    过期检查），比在 MFA 向导里另做一次 LDAP bind 更完整，也不需要把 LDAP 客户端代码
    搬进 `pkg/users`（会与 `pkg/auth` 形成导入环）。
  - 5 分钟窗口只约束「开始绑定」这一步：二维码出来后，用户再花多久装 App 都不影响提交动态码。

补充两条同口径的调整（都是为了让上面这套真的可用）：

- **通用「启用 MFA」与「强制绑定 MFA」彻底分开**：通用开关是功能闸，安全策略只管「谁必须绑定」。
  改前前端把两者揉成一个 `mfaEnabled`（`bootstrap.auth.mfaEnabled = 通用开关 && 策略 != disabled`），
  于是策略为默认值「未启用」时「绑定 MFA」按钮是灰的并提示「需要先在安全管理里启用」——
  想自愿绑定的用户其实无路可走（后端 `ensureMFAEnabled` 本来是允许的）。
  现在 bootstrap 下发的是通用开关原值 `auth.mfaAvailable`（删掉了那个综合值），
  界面按它决定按钮是否可用；被策略强制的那部分走用户对象上的 `mfa_required`。
- **`MFAThirdPartyEnabled`（LDAP 管理员强制绑定动态码）改为并入「谁必须绑定」**：
  改前它在**登录环节**要求未绑定的 LDAP 管理员输入动态码，而他没有密钥，于是
  `mfa.Verify("", code)` 必然失败 —— 该账号**完全无法登录**（原提示文案也承认这点）。
  现在它生效在**注册绑定判定**里：未绑定的 LDAP 管理员会命中 `blockForMFAEnrollment`，
  被引导到绑定向导（有了 B 就能走完），绑定后按「绑定即使用」照常验码。开关的语义
  （默认开 = LDAP 管理员必须绑定）不变，只是从「锁死」变成「可完成」。

## 3. 落点

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 模型 | `pkg/model/oauth.go` | 新增 `(*User).CanSelfEnrollMFA()`：provider 为 `""` / `password` / `ldap` 为真 |
| 模型 | `pkg/model/security_setting.go` | `MFARequiredFor` 增加 provider 前置判定；`MFAThirdPartyEnabled` 并入强制绑定判定 |
| 鉴权 | `pkg/auth/login_handler.go` | `mfaChallengeRequiredFor` 删掉 LDAP 管理员分支（只留「表单登录 + 已绑定 → 验码」） |
| 鉴权 | `pkg/auth/bootstrap_handler.go` | auth 目录新增 `enableMFA`（通用开关原值） |
| 用户 | `pkg/users/handler.go` | setup 的 provider 门禁改为 `CanSelfEnrollMFA`；LDAP 走「近期登录」而非口令；enable/disable 改为只依赖密钥与动态码；新增错误码 |
| 前端 | `ui/src/pages/account-page.tsx` | 「安全」页签对本地密码 + LDAP 可见；改密码区块只对本地密码账号渲染 |
| 前端 | `ui/src/components/account/mfa-section.tsx` | 按 provider 区分「输当前密码」与「直接开始绑定」；会话过旧时给「重新登录」入口 |
| 前端 | `ui/src/components/mfa-enrollment-gate.tsx` | 同上，保证被强制绑定的目录账号能走完向导 |
| 前端 | `ui/src/lib/mfa-enrollment.ts` | 新增：`canSelfEnrollMFA` / `mfaEnrollmentNeedsPassword` / `isMFAReauthRequired`（与后端口径镜像） |
| 前端 | `ui/src/lib/api/bootstrap.ts`、`ui/src/contexts/auth-context.tsx` | `auth.mfaEnabled` → `auth.mfaAvailable`（通用开关原值） |
| 文案 | `ui/src/i18n/locales/{zh,en}.json` | 新增键；`mfaThirdPartyEnabled` 提示改为「会被要求绑定」 |

错误码（前端据此本地化，不再直接展示英文原文）：

- `mfa_not_self_enrollable`：账号类型不支持在 Kite 自助绑定（OIDC / 第三方）；
- `mfa_reauth_required`：需要重新登录（LDAP 账号的登录时间超出 5 分钟窗口，或查不到会话记录）。

## 4. 现网现状（改前查的 `dev.db`，只读）

- 安全设置：`mfaPolicy = disabled`、`mfaThirdPartyEnabled = false`、`mfaStepUpEnabled = false`；
- 账号：139 个 LDAP 账号 + 3 个本地密码账号，**没有任何账号绑定过动态码**；
- 未配置任何 OAuth / OIDC 提供方（`o_auth_providers` 为空），员工走 LDAP 登录，
  所以本次改动在现网的实际影响面是「LDAP 账号现在可以自助绑定」，OIDC 那部分是为将来预留；
- `admin` 是 LDAP 账号且当前已停用：如果哪天打开 `mfaThirdPartyEnabled`，
  改前它会直接无法登录，改后会被引导去绑定（这正是本次修掉的坑）。

## 5. 升级影响

- **策略为「所有用户」且线上有 OIDC 账号**：这些账号不再被强制绑定，也不再被门禁挡住 —— 这正是修复的
  目的。已经绑定过动态码的 OIDC 账号行为不变（OIDC 回调仍会发票据、由登录页补验）。
- **LDAP 账号**：策略「所有用户」/「仅管理员」下仍会被强制绑定，但现在能走完（此前是死锁）。
  刚登录 5 分钟内可直接开始绑定；超时则需重新登录一次。
- **LDAP 管理员 + `MFAThirdPartyEnabled`（默认开）**：从「无法登录」变成「被引导绑定后即可用」。
- **匿名模式**（`AnonymousUserEnabled`）：伪用户 provider 为 `Anonymous`，一并归入「不可自助绑定」，
  因此策略「所有用户」不再把匿名访问整片拦死（顺带修掉的既有缺陷）。
- 数据层无迁移：不新增表/字段，`security_settings` 里 `MFAThirdPartyEnabled` 原样保留（语义收窄到
  「谁必须绑定」）。

## 6. 测试与反证

后端：`pkg/model/security_setting_test.go`（provider × 策略 × `MFAThirdPartyEnabled` 的判定矩阵）、
`pkg/auth/middleware_test.go`（OIDC 不被 `mfa_setup_required` 拦下，密码 / LDAP 仍被拦）、
`pkg/users/handler_test.go`（LDAP 近期登录通过 / 无会话与过期会话被拒 / OIDC 不支持、
本地密码账号仍要口令且空口令报「必填」）、`pkg/auth/mfa_login_test.go`（挑战条件矩阵更新）。
前端：`ui/src/lib/mfa-enrollment.test.ts`、`ui/src/components/mfa-enrollment-gate.test.tsx`、
`ui/src/pages/account-page.test.tsx`。
e2e：`specs/backend-api.spec.ts` 里 MFA 三个端点在「通用开关关闭」时的 403 断言保持通过
（本地集群实跑）；LDAP 的完整绑定链路没有 e2e（需要真实 LDAP 目录），由单元/组件测试覆盖。

反证方式：逐条关掉对应改动（去掉 provider 判定 / 恢复「未绑定也验码」分支 / 去掉近期登录判定 /
去掉口令必填校验 / 前端把所有账号都当作可自助绑定 / 前端一律索要本地密码），确认对应用例失败
且断言指向该行为，再还原。六条反证都实测过（失败输出的断言逐条对得上）。

## 7. 已知取舍

- LDAP 账号不提供「在向导里输入目录口令」的入口，必须重新登录一次换取新鲜会话。代价是多一次登录，
  换来的是绑定前的再认证与登录链路（审计 / 限流 / 有效期）一致。
- 5 分钟窗口写成常量 `mfaSelfEnrollReauthWindow`（`pkg/users/handler.go`），暂不做成安全设置项；
  要调只改这一行。策略「仅管理员」+ `MFAThirdPartyEnabled` 开时，LDAP 管理员仍会被强制绑定，
  这是该开关的既有默认语义。
