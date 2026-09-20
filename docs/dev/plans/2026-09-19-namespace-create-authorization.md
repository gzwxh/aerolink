# 方案：创建命名空间的授权口径

> ⚠️ **已被取代**：内部协商后的口径是「创建命名空间只归管理员，不通过角色 / 绑定组
> 下发」，见 `docs/dev/plans/2026-09-20-namespace-create-admin-only.md`。
> 下文保留作为历史：它记录了为什么曾经把创建开放给受限角色（当时的理由是让绑定组成员
> 能建出自己组的第一个命名空间），以及那次改动涉及的判定位置。

- 状态：**已被取代**（原实现已回退；文中引用的 `pkg/bindinggroups/auto_bind.go`、
  `pkg/resources/namespace_handler.go` 及 `nsCreate.autoBindHint` 等已随「自动归属」
  整体下线一并删除）
- 相关：`docs/dev/plans/2026-09-18-comment-chinese-migration.md` 之后的配套口径；
  自动归属见 `pkg/bindinggroups/auto_bind.go`

## 1. 问题

「创建命名空间」是**没有目标命名空间**的动作，但原有判定一律拿"目标命名空间"去匹配
角色的命名空间列表，`_all` 只是占位哨兵：

- `POST /api/v1/_clusters/<c>/namespaces` 在 `pkg/middleware/rbac.go` 里被解析成
  `namespace = _all`（URL 没有命名空间段），随后
  `CanAccess(user, "namespaces", "create", cluster, "_all")`。
- `pkg/rbac/rbac.go` 的 `namespaceUnconstrained` **故意把 `namespaces` 排除**，于是不会走
  「集群级资源忽略命名空间列表」的分支，而是走
  `len(role.Namespaces) > 0 && !match(role.Namespaces, "_all")` ——
  限定命名空间的角色（`namespaces: ["dev"]`）直接**被跳过**。
- 权限绑定组也兜不住：`canAccessViaBindingGroup` 遇到 `_all` **提前 return false**，
  只有全局组、或角色带裸 `resources: ["*"]` 才放行。

后果：**只有"命名空间不受约束"的角色持有人或全局组成员能建命名空间**。这与
「普通用户通过权限绑定组获得受限角色」的模型冲突——这类用户建不了命名空间，
`pkg/bindinggroups/auto_bind.go` 的自动归属也就永远打不到他们身上。

## 2. 口径（本次采用）

1. 「创建命名空间」**忽略角色的命名空间列表**，只看「集群匹配 + 资源/动词匹配」。
   理由：动作本身没有目标命名空间，用哨兵去匹配列表在语义上是错的。
2. 同时要求角色**显式点名** `namespaces`（裸 `resources: ["*"]` 不算），
   与其它集群级资源用 `matchExplicit` 排除裸 `"*"` 的原则一致。
3. 其余操作（`get` / `list` / `watch` / `update` / `delete`）**口径不变**：仍然拿真实
   命名空间名（或 `_all`）去匹配角色的命名空间列表。
4. 权限绑定组路径同样适用：成员所属组的角色显式点名 `namespaces` 且授予 `create`
   即可创建，且不看组内命名空间归属（新建的命名空间此刻还不属于任何组）。创建成功后由
   「自动归属」把它交给创建者的组（见 `pkg/bindinggroups/auto_bind.go`）。
5. **空组也要下发得出创建入口**：权限绑定组还没有任何命名空间时，
   `NamespaceScopedBindingGroupRoles` 原本会跳过该角色（指名资源在空组里确实什么都
   授不了），而前端正是用这些角色判断「创建命名空间」入口是否可见的——不例外就会出现
   「后端放行、界面没有入口」，成员建不了第一个命名空间。例外下发时只保留 `namespaces`
   这一条授权：其余资源在空组里确实授不了，带着空命名空间列表（前端当作「不约束」）
   会放出多余入口。

由此得到的权限形状是：**能建新命名空间，但改/删/列仍只能动自己有权的那些**。
管理员要给出这个能力，就在角色的资源里勾上「命名空间」的「创建」；
角色编辑器里 `namespaces` 本来就带「集群级」徽标（`ui/src/lib/rbac-privileges.ts`）。

## 3. 实现落点

| 位置 | 内容 |
| --- | --- |
| `pkg/rbac/rbac.go` | `namespacesExplicitlyGranted`（新）；`canAccessVerb` 里新增 `creatingNamespace` 分支，优先于 `clusterScoped` 分支 |
| `pkg/rbac/binding_group.go` | `bindingGroupAllowsNamespaceCreate`（新）；在 `_all` 提前返回之前调用；`NamespaceScopedBindingGroupRoles` 对「空组 + 点名 namespaces + 有 create」的角色例外下发（`namespacesCreateOnlyRole`） |
| `ui/src/lib/rbac-permissions.ts` | `grantsNamespacesExplicitly`（新，镜像后端）；`roleCanAccess` 与 `roleCanAccessAnyNamespace` 的 `namespaces` 分支按 `verb === 'create'` 区分 |
| `ui/src/lib/rbac-permissions.test.ts` | 原「显式点名也不放宽 create」的不变量改为新口径，并补「裸 `*` 不授予 create」「create 不放宽其它操作」 |
| `ui/src/components/settings/rbac-role-form-dialog.tsx` + `ui/src/i18n/locales/{en,zh}.json` | 权限面板提示补一句说明 |
| `pkg/rbac/namespace_create_authorization_test.go`（新） | 后端回归测试：两条授权路径 + 空组下发规则 |
| `e2e/specs/namespace-create-scope.spec.ts`（新） | 端到端：受限用户建出绑定组的第一个命名空间 |

## 4. 兼容性

- **不受限角色**（`namespaces` 为空 / `*` / `_all`）：行为完全不变，仍可创建。
- **限定命名空间 + 显式点名 `namespaces` 的旧式角色**：从"不能建"变为"能建"。
  这是本次唯一的行为放宽，且需要角色配置里显式列出 `namespaces` 作为信号。
- **限定命名空间 + 仅通配 `*` 资源的角色**：仍然不能建（避免既有角色被静默提权）。
- **新式（grants）角色**：`namespaces` 字段为空 = 不受限，本来就能建；本次不改变其行为。
- 前端镜像与后端一致；`roleCanAccessAnyNamespace` 仍会把"创建命名空间"入口渲染给这类
  用户（`ui/src/components/namespace-row-actions.tsx`、`namespace-detail-page.tsx`）。

## 5. 验证

- `go test ./pkg/rbac ./pkg/middleware ./pkg/resources`（授权判定、中间件与空组下发回归）
- `pnpm --dir ui run test`（`rbac-permissions.test.ts` 覆盖新口径的两个入口函数）
- `make e2e-run-existing SPEC="specs/namespace-create-scope.spec.ts"`：受限用户登录后，
  在**空组**的命名空间页看得到创建入口、能建出第一个命名空间、并被自动归属
  （它自己的命名空间列表里只有这一个），同时删别人的命名空间仍然 403
- `make e2e-run-existing SPEC="specs/rbac-custom-role.spec.ts specs/resource-creation.spec.ts"`
  （前者验证绑定组内放行、组外拒绝不变；后者验证管理员创建命名空间不回归）
- 手工：给一个受限角色勾上「命名空间 · 创建」，用该账号 `POST /api/v1/namespaces`
  预期 201；再 `GET /api/v1/namespaces` 只应看到自己有权（或被自动归属）的命名空间。
