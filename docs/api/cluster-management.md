# 集群管理

集群管理接口位于 `/api/v1/admin/clusters/`。

这些接口要求调用方已经是管理员用户，或者使用一个拥有 `admin` 角色的 API 密钥。

## 获取集群列表

```http
GET /api/v1/admin/clusters/
```

示例：

```bash
curl \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/clusters/
```

响应示例：

```json
[
  {
    "id": 1,
    "name": "demo-cluster",
    "description": "staging cluster",
    "enabled": true,
    "inCluster": false,
    "isDefault": true,
    "prometheusURL": "http://prometheus.monitoring.svc:9090",
    "config": "",
    "version": "v1.31.0",
    "badgeEnabled": true,
    "badgeText": "测试环境",
    "badgeColor": "#0011ff",
    "badgeIconEnabled": true,
    "badgeIconText": "测试环境",
    "badgeIconUrl": "/api/v1/clusters/1/badge-icon?v=8f14e45fceea167a"
  }
]
```

说明：徽章字段（`badgeEnabled`、`badgeText`、`badgeColor`、`badgeIconEnabled`、
`badgeIconText`、`badgeIconUrl`）在这个接口里始终返回原值，供管理界面编辑。给集群
切换器与顶栏取展示数据的 `GET /api/v1/clusters` 只在 `badgeEnabled` 为真时才带上
`badgeEnabled` / `badgeText` / `badgeColor`；图标字段（`badgeIconEnabled` /
`badgeIconText` / `badgeIconUrl`）由 `badgeIconEnabled` 单独控制，与徽章开关无关。

## 创建集群

```http
POST /api/v1/admin/clusters/
Content-Type: application/json
```

请求体：

```json
{
  "name": "demo-cluster",
  "description": "staging cluster",
  "config": "<kubeconfig-yaml>",
  "prometheusURL": "http://prometheus.monitoring.svc:9090",
  "inCluster": false,
  "isDefault": true
}
```

示例：

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"demo-cluster",
    "description":"staging cluster",
    "config":"apiVersion: v1\nkind: Config\n...",
    "prometheusURL":"http://prometheus.monitoring.svc:9090",
    "inCluster":false,
    "isDefault":true
  }' \
  https://kite.example.com/api/v1/admin/clusters/
```

响应示例：

```json
{
  "id": 1,
  "message": "cluster created successfully"
}
```

## 更新集群

```http
PUT /api/v1/admin/clusters/:id
Content-Type: application/json
```

请求体：

```json
{
  "description": "production cluster",
  "prometheusURL": "http://prometheus.monitoring.svc:9090",
  "isDefault": false,
  "enabled": true,
  "badgeEnabled": true,
  "badgeText": "测试环境",
  "badgeColor": "#0011ff",
  "badgeIconEnabled": true,
  "badgeIconText": "测试环境"
}
```

示例：

```bash
curl \
  -X PUT \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{
    "description":"production cluster",
    "enabled":true
  }' \
  https://kite.example.com/api/v1/admin/clusters/1
```

响应示例：

```json
{
  "message": "cluster updated successfully"
}
```

说明：

- 更新时 `config` 是可选的，不传就会保留现有 kubeconfig。
- 如果传了新的非空 `name`，集群名称会被更新。
- 徽章字段也是可选的，只改其中几个不会影响其它字段。`badgeEnabled` 为真时
  `badgeText` 不能为空；`badgeColor` 只接受 `#RRGGBB`；`badgeText` 最长 16 个字符
  （界面按整段展示，不截断），`badgeIconText` 最长 6 个字符，超限返回 400（不静默截断）。
- 图标图片不走这个接口：`badgeIconUrl` 只由下面的上传/删除图标接口维护，请求体里
  带它也不会生效，避免破坏「有图标字节 ⇔ URL 指向它」的约定。

## 上传 / 替换集群图标

```http
POST /api/v1/admin/clusters/:id/badge-icon
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `file` | file | 图标图片，必填 |

示例：

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -F "file=@./icon.png" \
  https://kite.example.com/api/v1/admin/clusters/1/badge-icon
```

响应示例：

```json
{
  "message": "badge icon updated successfully",
  "badgeIconUrl": "/api/v1/clusters/1/badge-icon?v=8f14e45fceea167a"
}
```

说明：

- 只接受 **PNG / JPEG**，类型按**文件内容**判定（不看文件名与 `Content-Type`），
  SVG、GIF 等一律拒绝：`SVG` 可以内联脚本，内联返回等于存储型 XSS。
- 大小不超过 1 MiB，边长不超过 1024 像素。
- 图片保存在实例的数据库里（`cluster_badge_icons` 表），并顺带把
  `badgeIconEnabled` 打开。
- 上传成功会拿到新的 `badgeIconUrl`（`?v=` 是图片内容哈希）：内容变了地址就变，
  客户端缓存随之失效，因此取图接口可以开长缓存。
- 失败返回 400（类型 / 内容 / 尺寸不合法）或 413（体积超限），响应体形如
  `{"code":"cluster_icon_invalid_type","error":"...","params":{...}}`。
  失败**不会**落库，也不影响已经在用的图标。

## 移除集群图标

```http
DELETE /api/v1/admin/clusters/:id/badge-icon
```

示例：

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/clusters/1/badge-icon
```

响应示例：

```json
{
  "message": "badge icon deleted successfully"
}
```

说明：图片字节与 `badgeIconUrl` 会一起清掉，避免留下取不到的地址；集群图标回落到
图标文本或默认图标。`badgeIconText` 与 `badgeIconEnabled` 不受影响。重复删除是无操作，
同样返回 200。

## 获取集群图标

```http
GET /api/v1/clusters/:id/badge-icon
```

示例：

```bash
curl \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/clusters/1/badge-icon -o icon.png
```

- 返回图片字节，`Content-Type` 为 `image/png` 或 `image/jpeg`，并带 `ETag`
  （内容哈希）与 `Cache-Control: private, max-age=31536000, immutable`；配合
  `If-None-Match` 返回 304。
- 没有上传过、id 非法或集群不存在时返回 404，前端据此回落到图标文本或默认图标。
- 只要求登录，不要求管理员权限（图标会显示在集群切换器里，能切换集群的账号就能看到）。

## 删除集群

```http
DELETE /api/v1/admin/clusters/:id
```

示例：

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/clusters/1
```

响应示例：

```json
{
  "message": "cluster deleted successfully"
}
```

说明：默认集群不能被删除。

## 从 kubeconfig 导入集群

这个初始化接口位于：

```http
POST /api/v1/admin/clusters/import
Content-Type: application/json
```

它主要用于首次初始化，并且只会在系统里还没有任何集群时生效。

请求体：

```json
{
  "config": "<kubeconfig-yaml>",
  "inCluster": false
}
```

使用 in-cluster 导入时：

```json
{
  "inCluster": true
}
```
