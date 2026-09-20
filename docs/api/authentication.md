# 认证

Kite 支持通过 OAuth、密码用户、LDAP 和 MFA 进行页面登录，也支持通过 API 密钥进行程序化访问。API 密钥会以一个特殊用户身份完成认证，并沿用与页面登录用户相同的 RBAC 模型。

## 页面登录

密码登录接口：

```http
POST /api/auth/login/password
Content-Type: application/json
```

请求体：

```json
{
  "username": "alice",
  "password": "change-me",
  "mfa_code": "123456"
}
```

只有当该密码用户已启用 MFA 时，才需要传 `mfa_code`。

LDAP 登录使用相同请求体，接口为 `POST /api/auth/login/ldap`。

## 当前用户资料

任何已登录用户都可以从 bootstrap 响应里读自己的资料，并更新其中的本地字段：

```http
PUT /api/users/me
Content-Type: application/json
```

```json
{
  "name": "Alice",
  "email": "alice@example.com",
  "phone": "13800000000",
  "avatar_url": "https://example.com/a.png"
}
```

所有字段都是可选的：不传的字段保持原值，传空字符串则清空该可选字段。`name` 不超
过 100 字符，`phone` 50、`avatar_url` 2048；`email` 必须能解析为合法
地址（它同时是邮件通知的收件地址）。校验失败返回 `400`，且**不会修改任何字段**。

目录同步的账号（LDAP / OIDC）其 `name`、`email`、`phone` 受源系统管辖：
对这些用户这几个字段会被**忽略**而不是报错，客户端只需把输入框置灰即可；
`avatar_url` 是纯本地字段，所有用户都可以改。

`POST /api/users/me/password` 用于改密码（仅密码用户），且需要提供当前密码。

## MFA

MFA 适用于密码用户。用户可以在「用户信息」页（`/account?tab=security`）管理 MFA，也可以使用以下已认证接口：

```http
POST /api/users/me/mfa/setup
POST /api/users/me/mfa/enable
POST /api/users/me/mfa/disable
```

初始化 MFA 需要当前密码：

```json
{
  "current_password": "change-me"
}
```

初始化响应包含 `secret`、`otpauth_url` 和 `qr_code`。启用或停用 MFA 时提交 TOTP 验证码：

```json
{
  "code": "123456"
}
```


## 认证设置

管理员可以在 **设置 -> 安全策略 -> 认证配置** 中启用或停用密码登录和 MFA。

同样的设置也可以通过以下接口管理：

```http
GET /api/v1/admin/general-setting/
PUT /api/v1/admin/general-setting/
```

相关请求字段：

```json
{
  "passwordLoginDisabled": false,
  "enableMFA": true
}
```

## 登录尝试封禁

基于账号密码的登录会在连续失败时按客户端 IP 临时封禁。Kite 允许 1 分钟内最多 10 次错误密码或 MFA 验证失败；第 11 次失败会封禁该客户端 IP 的账号密码登录 5 分钟。

当 Kite 运行在 Ingress 或负载均衡器后面时，封禁使用的客户端 IP 取决于 `TRUSTED_PROXIES` 配置。详见[环境变量](../config/env.md)。

## API 密钥格式

完整 API 密钥格式如下：

```text
kite<ID>-<SECRET>
```

使用时直接把完整值放进 `Authorization` 请求头，不要加 `Bearer`。

```http
Authorization: kite12-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 在哪里配置

拥有 `admin` 角色的用户可以在 **设置 -> API 密钥** 中创建 API 密钥。

创建后，复制完整密钥值，并把它作为 API 请求里的 `Authorization` 请求头使用。

## 权限说明

API 密钥与普通用户共用同一套 RBAC 权限模型。

- 创建 API 密钥本身不会自动获得任何资源权限。
- `/api/v1/...` 下的资源访问仍然会经过 RBAC 校验。
- `/api/v1/admin/...` 下的管理接口要求调用方拥有 `admin` 角色。
- 集群资源接口通常还需要传 `x-cluster-name`。

## 认证请求

示例：

```bash
curl \
  -H "Authorization: kite12-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "x-cluster-name: demo-cluster" \
  https://kite.example.com/api/v1/pods/default
```

说明：

- `/api/v1/...` 下的资源接口通常还需要传 `x-cluster-name`。
