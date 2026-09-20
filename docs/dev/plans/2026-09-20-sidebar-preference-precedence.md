# 方案：侧边栏布局的优先级（个人 > 全局 > 内置默认）

- 状态：**已实现**（后端 `pkg/auth`、`pkg/users`，前端 `ui/src`，两侧测试与反证已就绪）
- 触发：设置页的「自定义侧边栏」和头像菜单的「自定义侧边栏」被问「两个有什么区别」；
  查下去发现旧口径本身是坏的。

## 1. 问题

「自定义侧边栏」只有一份实现（`ui/src/components/sidebar-customizer.tsx`），设置页用
`inline` 形态嵌在卡片里，头像菜单用对话框形态：

| 入口 | 位置 | 谁能看到 |
| --- | --- | --- |
| 设置 → 侧边栏导航 | `ui/src/components/settings/navigation-management.tsx` | 只有能进设置页的账号 |
| 头像菜单 → 自定义侧边栏 | `ui/src/components/user-menu.tsx` | 所有登录用户 |

**功能上没有区别**，区别只在入口和权限：设置页那份多一个「发布为全局侧边栏」按钮
（`canPublishGlobal`，门禁是 `settings.general` 的写权限）。

真正的问题在旧口径：管理员一旦发布全局布局，

- 非管理员看到的侧边栏被**无条件替换**成全局布局；
- 非管理员点保存自己的布局会被 **403**（`sidebar customization is disabled by global sidebar`）；
- 头像菜单里的入口对非管理员**直接隐藏**（前端靠 `hasGlobalSidebarPreference` 判断）。

于是「管理员发一次全局布局」= 普通用户永远锁不死自己的侧边栏，且连入口都消失。
用户明确的口径是：

> **个人设置优先，个人没有设置才用管理员设置的，管理员也没有设置就用系统默认。**

## 2. 新口径

**优先级：个人布局 > 全局布局 > 前端内置默认。**

「全局侧边栏」的语义从「强制覆盖」降级为「**新账号的初始值**」：

- 任何登录用户都可以保存自己的布局，包括管理员已发布全局布局期间（不再 403）。
- 已经保存过个人布局的账号，不受后续全局发布影响。
- 只有 `users.sidebar_preference` 为空（含纯空白）的账号，才在读取时被补上全局布局。

## 3. 落点

| 位置 | 改动 |
| --- | --- |
| `pkg/auth/bootstrap_handler.go` `applyBootstrapSidebarPreference` | 唯一判定点：用户自己非空直接返回；否则用非空的全局布局顶上；加 nil 防御。删掉已无用的 `HasGlobalSidebarPreference` 响应字段 |
| `pkg/auth/login_handler.go` `GetUser` | 改为复用 `applyBootstrapSidebarPreference`（原先内联了一份同样的逻辑，两处容易改漏）。`globalSidebarPreference` 仍然下发，供前端显示「已发布」状态 |
| `pkg/users/handler.go` `UpdateSidebarPreference` | 删掉「非管理员 + 全局非空 → 403」的分支 |
| `ui/src/components/user-menu.tsx`、`account/appearance-section.tsx` | 去掉 `(isAdmin() \|\| !hasGlobalSidebarPreference)` 门禁，入口对全部登录用户可见 |
| `ui/src/contexts/auth-context.tsx`、`ui/src/lib/api/bootstrap.ts` | 删掉 `hasGlobalSidebarPreference`（类型 / 计算 / memo / deps） |
| `ui/src/i18n/locales/{zh,en}.json` | `sidebar.setAsGlobalDescription`、`settings.descriptions.navigation` 改为新口径；`navigation-management.tsx` 里过期的 `defaultValue` 一并对齐 |

## 4. 测试与反证

`pkg/auth/sidebar_preference_test.go`

- `TestApplyBootstrapSidebarPreferencePriority`：个人优先 / 空则继承全局 / 纯空白不遮蔽全局 /
  两边都没有保持空（交给前端内置默认）/ nil user / nil setting。
- `TestGetUserSidebarPreferencePriority`：同口径在 `/api/auth/user` 响应上成立——继承全局
  布局时 `globalSidebarPreference` 仍要上报；保存个人布局后返回个人布局，且每次请求都按
  鉴权中间件的方式从库里取用户（否则测的是 context 里的旧对象）。

`pkg/users/handler_test.go` 的 `TestUpdateSidebarPreferenceHonorsGlobalPolicy` 口径反转：
已发布全局布局时，非管理员保存自己的布局要 **200 且落库**（原来断言 403 且不落库）。

反证（都做过，随后还原）：

| 反证 | 结果 |
| --- | --- |
| 把 `UpdateSidebarPreference` 的 403 分支加回去 | `TestUpdateSidebarPreferenceHonorsGlobalPolicy` 失败：`non-admin status = 403, want 200` |
| 把 `applyBootstrapSidebarPreference` 改回「全局无条件覆盖」 | `TestApplyBootstrapSidebarPreferencePriority` 失败：`SidebarPreference = "{...workloads}", want "{...custom}"`；`TestGetUserSidebarPreferencePriority` 同步失败 |

## 5. 升级影响（需要告知）

**已经自己配过侧边栏的非管理员，升级后会看到自己的旧布局，而不是管理员后来发布的全局
布局。** 这正是要的行为，但和旧版本的观感不同，容易被当成「全局布局丢了」。

另外，升级后 `hasGlobalSidebarPreference` 不再下发，旧前端若还在跑会退化成隐藏入口——
前端与后端同包发布，无需兼容。

## 6. 不变的部分

- 表结构不动：`users.sidebar_preference`、`general_settings.global_sidebar_preference`。
- 管理端的「发布 / 取消发布全局侧边栏」接口与门禁（`settings.general` 写权限）不动。
- 前端读取链路不动：`ui/src/contexts/sidebar-config-context.tsx` 仍以 `user.sidebar_preference`
  为输入，解析失败或为空时回落 `ui/src/contexts/sidebar-config-defaults.ts` 的内置默认。
