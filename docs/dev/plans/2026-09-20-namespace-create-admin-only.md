# 方案：创建命名空间只归管理员

- 状态：**已实现**（`pkg/rbac`、`ui/src/lib`、两侧测试与反证已就绪）
- 取代：`docs/dev/plans/2026-09-19-namespace-create-authorization.md`（那份把创建开放给受限角色）
- 触发：内部协商一致 —— 命名空间的创建不支持给普通用户这个权限，由管理员创建后再授权出去。

## 1. 口径

**「创建命名空间」是管理员专属动作，不通过角色 / 权限绑定组下发。**

工作流因此变成：

1. 管理员创建命名空间；
2. 管理员在「权限管理 → 权限绑定」里把它分配给某个绑定组，并给成员绑角色；
3. 用户在自己被授权的命名空间里干活。

管理员侧有两个创建入口，都在管理面（`/api/v1/admin/*`，`RequireAdmin`）：

- 权限绑定组页的「在组内创建命名空间」→ `pkg/bindinggroups/handler.go` 的
  `CreateBindingGroupNamespace`（建完直接归属该组，这正是新工作流最顺的一条）；
- 命名空间列表页的「创建」→ 通用资源创建接口。

## 2. 判定落点（只有一处）

`pkg/rbac/rbac.go` 的 `canAccessVerb` 开头：

```go
if resource == string(common.Namespaces) && verb == string(common.VerbCreate) {
    return IsAdministrator(user)
}
```

选这一处的原因：它同时覆盖两条创建路径 —— 通用资源创建接口，以及
`POST /resources/apply` 的 YAML 创建（`apply_handler.go` 用的也是同一个 `CanAccess`）。
`IsAdministrator` 认「直接持有 admin 角色」与「经全局权限绑定组持有 admin 角色」两种，
与其它管理面判定一致。

顺带删掉只服务于旧口径的三处：

| 位置 | 删除的内容 |
| --- | --- |
| `pkg/rbac/rbac.go` | `canAccessVerb` 里的 `creatingNamespace` 分支、`namespacesExplicitlyGranted` |
| `pkg/rbac/binding_group.go` | `canAccessViaBindingGroup` 里的创建例外、`bindingGroupAllowsNamespaceCreate`、`namespacesCreateOnlyRole`，以及 `NamespaceScopedBindingGroupRoles` 对空组的例外下发 |

## 3. 前端镜像

- `ui/src/lib/rbac-permissions.ts`：新增 `isNamespaceCreate(resource, verb)`，
  `roleCanAccess` 与 `roleCanAccessAnyNamespace` 在最前面按 `options.isAdmin` 判定，
  不再看角色；删掉 `grantsNamespacesExplicitly`。
- `ui/src/hooks/use-can.ts`、`ui/src/contexts/auth-context.tsx`：
  `useCanAnyNamespace` 与 `user.can()` 把 `isAdmin: user.isAdmin()` 传进去。
- `ui/src/lib/node-permissions.ts`：给 `namespaces` 加权限面板预设，**只列
  get / update / delete**，并附提示说明「创建是管理员专属动作」。这样角色编辑器里不再
  出现「命名空间 · 创建」——勾了不生效的开关本身就是缺陷。
- i18n：`rbac.permissionsHint`（去掉旧口径那句话）、新增
  `rbac.namespacePermissions.panelTitle` / `rbac.namespacePermissionHint`；
  删掉 `nsCreate.autoBindHint`（见 §6）。

三条界面入口自动跟着消失（判定的都是「namespaces + create」）：命名空间列表页的创建
按钮（`ui/src/components/resource-table.tsx` → `useCanAnyNamespace`）、命名空间详情的
「克隆」与行操作的「克隆」（`namespace-detail-page.tsx`、`namespace-row-actions.tsx`）。

## 4. 测试与反证

- `pkg/rbac/namespace_create_authorization_test.go`（重写）：
  四种普通角色写法（受限角色点名 namespaces、裸 `*`、不受约束的角色、无角色）一律
  拿不到 create；管理员可以；经全局绑定组持有 admin 的账号可以；绑定组成员拿不到；
  空组不再下发任何角色；**创建之外的操作口径不变**（组内 `get`、列表内 `delete` 照旧）。
- `ui/src/lib/rbac-permissions.test.ts`：原先「点名 namespaces 就能建」的两条用例反转成
  「无论角色怎么写都拿不到 create」+「只有 `isAdmin` 才给」。
- `e2e/specs/namespace-create-scope.spec.ts`（重写）：受限成员的命名空间页**没有**创建
  入口、直接 POST 创建接口得到 403、集群里确实没有建出来，同时组内 `get` 仍然 200，
  最后管理员建/删同名命名空间成功。

反证（都跑过并还原）：

| 反证 | 结果 |
| --- | --- |
| 去掉 `canAccessVerb` 开头的管理员分支 | `TestCreateNamespaceRequiresAdministrator` 失败：`显式点名 namespaces 的受限角色 不应能创建命名空间` |
| 去掉前端 `isNamespaceCreate` 提前返回 | `rbac-permissions.test.ts` 的 "never grants creation through roles" 失败 |

## 5. 升级影响

- **已经拿到「命名空间 · 创建」的角色，升级后不再能创建。** 这是本次的目的；受影响用户
  在界面上会看到创建入口消失，直接调接口得到 403。
- 现有角色的授权配置**不做迁移**：`namespaces` 上的 `create` 会留在库里但不再生效。
  角色编辑器里也不再列出它，管理员下次编辑该角色时该项自然消失。
- 命名空间归属、组内授权、其它操作全部不变。

## 6. 待决定：自动归属已成空开关

`pkg/bindinggroups/auto_bind.go` 的 `AutoBindCreatedNamespace` 对管理员**直接返回**
（`NamespaceBindingReasonAdministrator`），而创建现在只有管理员能做 —— 也就是说这条链路
永远走不到「归属」分支，连带这些内容都失效了：

| 位置 | 现在的状态 |
| --- | --- |
| 通用设置「命名空间自动归属」开关（`general_setting.auto_bind_user_namespace`） | 打开或关掉都没有任何效果 |
| `create-namespace-dialog.tsx` 的归属提示（`boundToBinding` / `boundToRoles` / `notBound`） | 不会触发（管理员拿到的 reason 是 `administrator`，函数直接返回） |
| 创建响应的 `namespaceBinding` 字段 | 恒为 `{"reason":"administrator"}` |

本次只把**与授权规则直接冲突的文案**改掉了（删 `nsCreate.autoBindHint`、改
`rbac.permissionsHint`），功能本身没动，等确认后再整体下线。

## 7. 不变的部分

- 命名空间的 `get` / `list` / `watch` / `update` / `delete` 判定完全不变。
- 权限绑定组对命名空间的归属、成员、角色绑定不变。
- 权限绑定组页的「创建命名空间并直接归属该组」（`CreateBindingGroupNamespace`，
  `RequireAdmin` + `settings.rbac` 写权限）不变 —— 这就是新口径下的管理员入口。
- 命名空间列表页对非管理员仍然是「只看得到自己被授权的命名空间」（与本次无关的既有行为）。
