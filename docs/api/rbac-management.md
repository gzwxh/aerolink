# RBAC 管理

RBAC 管理接口位于 `/api/v1/admin/roles/`。

这些接口要求调用方已经是管理员用户，或者使用一个拥有 `admin` 角色的 API 密钥。

## 获取角色列表

```http
GET /api/v1/admin/roles/
```

示例：

```bash
curl \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/roles/
```

响应示例：

```json
{
  "roles": [
    {
      "id": 2,
      "name": "viewer",
      "description": "Viewer role with read-only access",
      "isSystem": true,
      "clusters": ["*"],
      "namespaces": ["*"],
      "resources": ["*"],
      "verbs": ["get", "log"],
      "assignments": []
    }
  ]
}
```

## 获取单个角色

```http
GET /api/v1/admin/roles/:id
```

## 创建角色

```http
POST /api/v1/admin/roles/
Content-Type: application/json
```

请求体：

```json
{
  "name": "namespace-editor",
  "displayName": "Namespace Editor",
  "description": "Edit workloads in dev",
  "namespaces": ["dev"],
  "resources": ["deployments", "pods", "services"],
  "verbs": ["get", "create", "update", "delete", "log"]
}
```

角色不带集群属性：角色是**全局**的，只定义「能做什么」（资源与操作）；「在哪里生效」（哪个集群、哪些命名空间）由绑定该角色的权限绑定组决定。`namespaces` 字段为兼容保留，与集群字段一样不再参与授权判定。

绑定组的命名空间列表只收窄**指名资源**的规则（例如只给了 `pods` 的角色）；角色里**资源通配 `*`** 的规则（权限 ID 形如 `k8s:*:get`，界面上的「全部资源」）写的是「集群里的一切资源」，作用范围本来就是整个集群：不受组内命名空间列表限制，集群级资源（节点、持久卷等）与跨命名空间请求也一并放行。

`name` 是角色 ID：全局唯一，权限绑定与权限判定都以它为依据，控制台创建后不再提供修改入口。`displayName` 是可选的界面展示名，只影响界面文案、不参与授权判定；留空（或传空串）时内置角色按界面语言显示内置名称，自定义角色显示 `name`。

示例：

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"namespace-editor",
    "description":"Edit workloads in dev",
    "namespaces":["dev"],
    "resources":["deployments","pods","services"],
    "verbs":["get","create","update","delete","log"]
  }' \
  https://kite.example.com/api/v1/admin/roles/
```

## 更新角色

```http
PUT /api/v1/admin/roles/:id
Content-Type: application/json
```

请求体字段与创建角色时一致。

`roleType` 与 `namespaces` 为可选字段。角色表单只定义资源与操作权限；集群与命名空间范围由绑定该角色的权限绑定组决定。请求中省略 `namespaces` 时，创建的角色为不含命名空间限制的用户角色，更新时则保留原有取值。`clusters` 仍可传入但会被忽略：角色始终是全局的。

`grants` 是按资源授权的正式形式：`[{"resource": "nodes", "verbs": ["get", "exec"]}, {"resource": "pods", "verbs": ["get"]}]`。每个资源各自携带操作集合，因此同一个角色可以对不同资源授予不同操作。`resources` / `verbs` 是 `grants` 推导出的并集，仅为兼容只认识笛卡尔积形式的客户端保留；不带 `grants` 的存量角色仍然按「操作作用于列出的全部资源」判定。

受保护的内置角色是只读的：`admin`、`security-admin`、`auditor`、`viewer` 的更新请求统一返回 `403` 与 `{"code": "protected_role_immutable"}`。等保三员的权限集就是三权分立本身；`viewer`（只读管理员）的规则同样由代码维护、不应被误改。因此四者唯一允许的变更是 `POST /roles/:id/restore_defaults`（恢复默认）。

创建角色时使用保留名、或把已有角色改名为保留名，统一返回 `409` 与 `{"code": "role_name_reserved"}`。保留名是 `admin`（唯一的最高权限角色）与已退休的 `super-admin`，以免自定义角色被误认为内置的最高权限入口。

## 系统设置权限

控制台设置按**章节**授权：设置区的每个章节都是名为 `settings.<章节>` 的合成资源（不对应任何 Kubernetes API），而裸 `settings` 覆盖全部章节。章节包括 `general`、`clusters`、`notification`、`templates`、`apikeys`、`authentication`、`users`、`rbac`、`security`、`audit`。

每个资源拆分两个操作：

- `get`：查看该章节（页面可打开，其读取接口可用）；
- `update`：修改它（新建 / 编辑 / 删除）。拥有 `update` 的角色同样可以查看。

```json
{
  "grants": [
    { "resource": "settings.clusters", "verbs": ["update"] },
    { "resource": "settings.audit", "verbs": ["get"] }
  ]
}
```

上例是一个既维护集群、又只读审计日志的账号——正是三权分立所需的形式，安全与审计职责各自以独立章节委派出去：

| 内置角色 | 可用的控制台设置章节 |
| --- | --- |
| `admin`（系统管理员） | 全部章节（通过父级 `settings`） |
| `security-admin`（安全管理员） | `authentication`、`users`、`rbac`、`security` |
| `auditor`（审计管理员） | `audit`（`get` 与 `update`；`update` 仅用于配置保留策略与 syslog 外发，审计记录本身仍然只读） |
| `viewer`（只读管理员） | 无 |

`admin` 同时掌握安全策略与审计日志（全部章节），这是对等保三级三权分立原始设定的**有意偏离**——原设定要求系统管理员不掌握安全策略与审计日志。该偏离已记录在 `等保三级-三权分立权限方案.md`，需按新版等保方案重新评估；`security-admin` 与 `auditor` 仍然存在，用于把安全授权与审计单独委派给他人。

有两条规则需要特别注意：

- **`*` 通配不覆盖设置类资源。** 它们必须被显式授权，否则一个持有 `resources: ["*"]` 的角色会顺手拿到「系统配置 / 授权 / 审计」三个章节，把三员职责并回同一账号。唯一需要覆盖全部设置章节的角色是 `admin`，它在通配之外再显式持有父级 `settings` 资源。
- **章节授权不反向包含父级。** 授予 `settings.audit` 不等于授予 `settings`；需要整个设置区时，请授予父级 `settings`（或逐个章节）。

能进入 `/api/v1/admin/*` 的前提是至少拥有一个 `settings.<章节>` 权限（或持有 `admin` 角色），这也是安全管理员 / 审计管理员不需要被授予完整管理员角色就能使用自己页面的原因。

## 职责分离（三权分立）

三类管理员职责必须由不同人员担任，因此内置角色 `admin`、`security-admin`、`auditor` 互斥。同一账号同时持有其中多个时，其所有管理面接口统一返回 `403` 与 `{"code": "role_conflict", "roles": [...]}`；写入此类组合会被拒绝并返回 `409 role_conflict`。集群资源访问刻意不受影响：组成员关系可能来自外部目录，不应因此把账号的业务访问一并锁死。

恢复内置角色默认权限

```http
POST /api/v1/admin/roles/:id/restore_defaults
```

把内置系统角色重置为本版本随代码发布的定义，并返回更新后的角色。只有 `isSystem` 角色有默认值；自定义角色返回 `400 not_a_system_role`。当内置角色的规则被改得不再符合其职责时，可以用它回到出厂状态。

## 删除角色

```http
DELETE /api/v1/admin/roles/:id
```

删除角色会同时清理它的引用：直接角色分配与权限绑定组成员在同一个事务里删除，不会留下指向已不存在角色 ID 的残留行（否则角色被重建后（自增 ID 不同）这些行会永久悬空）。

受保护的内置角色（`admin`、`security-admin`、`auditor`、`viewer`）返回 `403` 与 `{"code": "protected_role_immutable"}`。

`super-admin` 已不再是可删除的内置角色：代次 3 的内置角色规则把它并入 `admin` 并退休。老库里的角色行、它的分配关系与权限绑定组成员都会由单向迁移删除，且不会再被创建回来——重启与内置角色代次迁移都不会。第一次迁移会记录 `general_settings.super_role_removed` 标记，因此迁移只执行一次。「超级管理员」现在只是**账号级**概念：`users.is_super_admin` 标记，加上受保护的全局作用域「超级权限绑定」组，初始化向导创建的账号正是由它表达。

示例：

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/roles/3
```

响应示例：

```json
{
  "success": true
}
```

## 分配角色

```http
POST /api/v1/admin/roles/:id/assign
Content-Type: application/json
```

请求体：

```json
{
  "subjectType": "user",
  "subject": "alice"
}
```

当前服务端实现支持的 `subjectType`：

- `user`
- `group`

示例：

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{"subjectType":"group","subject":"platform-team"}' \
  https://kite.example.com/api/v1/admin/roles/3/assign
```

## 移除角色分配

```http
DELETE /api/v1/admin/roles/:id/assign?subjectType=user&subject=alice
```

示例：

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  "https://kite.example.com/api/v1/admin/roles/3/assign?subjectType=group&subject=platform-team"
```
