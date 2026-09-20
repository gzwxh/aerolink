# 用户管理

用户管理接口位于 `/api/v1/admin/users/`。

除特别说明外，这些接口要求调用方已经是管理员用户，或者使用一个拥有 `admin` 角色的 API 密钥。

## 初始化第一个超级管理员

这个接口用于首次初始化，在还没有建立管理员认证之前即可调用。

```http
POST /api/v1/admin/users/create_super_user
Content-Type: application/json
```

请求体：

```json
{
  "username": "admin",
  "password": "change-me",
  "name": "Administrator"
}
```

它只会在系统里还没有任何用户时成功。

## 获取用户列表

```http
GET /api/v1/admin/users/
```

支持的查询参数：

- `page`
- `size`
- `search`
- `role`
- `sortBy`
- `sortOrder`

示例：

```bash
curl \
  -H "Authorization: kite1-adminsecret" \
  "https://kite.example.com/api/v1/admin/users/?page=1&size=20&search=alice&sortOrder=desc"
```

响应示例：

```json
{
  "users": [
    {
      "id": 12,
      "username": "alice",
      "provider": "password",
      "name": "Alice",
      "enabled": true,
      "lastLoginAt": "2026-04-20T08:30:00Z",
      "roles": [
        {
          "id": 2,
          "name": "viewer"
        }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "size": 20
}
```

## 创建密码用户

```http
POST /api/v1/admin/users/
Content-Type: application/json
```

请求体：

```json
{
  "username": "alice",
  "password": "change-me",
  "name": "Alice"
}
```

示例：

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"change-me","name":"Alice"}' \
  https://kite.example.com/api/v1/admin/users/
```

## 更新用户

```http
PUT /api/v1/admin/users/:id
Content-Type: application/json
```

请求体（字段都是可选的：只有出现在请求里的字段才会被处理，显式传空值等于清空该字段）：

```json
{
  "name": "Alice Zhang",
  "avatar_url": "https://example.com/avatar.png",
  "email": "alice@example.com",
  "phone": "13800000000",
  "remark": "外包账号",
  "groups": ["dev", "sre"]
}
```

示例：

```bash
curl \
  -X PUT \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice Zhang"}' \
  https://kite.example.com/api/v1/admin/users/12
```

字段归属：

- **本地（密码）账号**：`name`、`avatar_url`、`email`、`phone`、`remark`、`groups` 全部可改。
  `email` 会按 `profileUpdate` 的规则校验（trim、长度、邮箱格式），不合法时返回 `400`
  且不写入任何字段。`groups` 是完整用户组列表（空数组 = 不属于任何用户组），
  会影响基于用户组的 RBAC 判定。
- **目录账号（LDAP / OIDC）**：只有 `avatar_url` 生效；`name`、`email`、`phone`、`remark`
  与 `groups` 由源系统掌管，会被静默忽略（不报错）。目录账号的用户组请改用下面的
  逐成员接口维护（可以追加「本地附加组」）。

密码不在这个接口里修改，本地账号请用下面的重置密码接口。

## 查看用户组成员

```http
GET /api/v1/admin/groups/:name/members
```

```json
{
  "members": [
    { "username": "alice", "name": "Alice", "provider": "password", "source": "local" },
    { "username": "bob", "name": "Bob", "provider": "ldap", "source": "local" },
    { "username": "carol", "name": "Carol", "provider": "ldap", "source": "ldap" }
  ]
}
```

`source` 描述的是这条**成员关系**的来源，不是账号来源：

- `local` —— 在控制台添加的，目录同步不会移除它；
- `ldap` / `oidc` —— 由目录同步带进来的，只能在目录里移除。

## 添加用户组成员

```http
POST /api/v1/admin/groups/:name/members
Content-Type: application/json

{ "username": "bob" }
```

任意账号都可添加，**包括 LDAP / OIDC 账号**。该成员关系记为「本地附加」：
账号自己的目录用户组仍归目录管辖，下一次同步不会移除这里加的组，
用户因此也会获得绑定在该组上的全部角色。

## 移除用户组成员

```http
DELETE /api/v1/admin/groups/:name/members/:username
```

只能移除「本地附加」的成员关系。移除目录同步来的成员关系会被拒绝，
返回 `409` 与错误码 `group_member_directory_managed`（否则下一次同步又会把它带回来）。

## 删除用户

```http
DELETE /api/v1/admin/users/:id
```

示例：

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/users/12
```

响应示例：

```json
{
  "success": true
}
```

内置超级管理员**永远不支持删除**：请求会被拒绝，返回 `400` 与错误码 `user_super_admin_not_deletable`。
需要收回它的访问权请用**停用**（见下文），那是可逆的做法。

其余账号在「删完就没人持有系统管理员角色」时也会被拒绝，返回 `400` 与错误码
`user_last_administrator`。

## 重置用户密码

```http
POST /api/v1/admin/users/:id/reset_password
Content-Type: application/json
```

请求体：

```json
{
  "password": "new-password"
}
```

## 获取被自动禁用的账号

```http
GET /api/v1/admin/users/disabled
```

列出被「不活跃自动禁用」策略关闭的账号（最新在前），便于管理员用下面的接口恢复。
响应为 `{"users": [...]}`。

该接口原本位于 `GET /api/v1/admin/notification-setting/disabled-users`，
已迁到 `users` 下：它返回的是用户数据，而控制台里展示它的面板用
`POST /users/:id/enable` 恢复账号——把读和写放在同一个章节，才能避免「只有某一个
章节权限的账号看到空面板」或「按钮可点却一点就失败」。

## 启用或禁用用户

```http
POST /api/v1/admin/users/:id/enable
Content-Type: application/json
```

请求体：

```json
{
  "enabled": false
}
```

响应示例：

```json
{
  "success": true
}
```

内置超级管理员可以停用，但前提是系统里还有另一个启用账号**持有系统管理员角色**：直接分配、通过
所属用户组、或通过**全局作用域**的权限绑定组获得都算；只有安全管理员 / 审计管理员是不够的（它们
只能打开自己的页面，接手不了系统管理员的职责）。否则返回 `400` 与错误码 `user_last_administrator`。
删除该账号则永远不允许（`user_super_admin_not_deletable`）。
