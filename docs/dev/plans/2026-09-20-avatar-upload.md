# 头像上传（存库）方案

- 状态：**已实现**
- 背景：账号页（`/account` → `ui/src/components/account/profile-section.tsx`）目前只能填**头像 URL**（外链），
  内网用户没有可用的图床，实际体验是「想换头像但没地方放图」。需求是支持直接上传，图片存进数据库。

## 1. 存储与读取口径

**新表 `user_avatars`（一个用户最多一行），图片字节存在库里。**

为什么不直接把 `data:image/...` 写进 `users.avatar_url`：
`users` 行会被高频整行读取（每次认证/会话心跳、用户列表、目录同步），把最大 1 MiB 的 blob
混进去，会让这些路径全部变慢；`avatar_url` 是 `text` 列且现有校验只允许 2048 字符，也放不下。

`users.avatar_url` 仍然是**「显示什么」的唯一事实来源**：

| 用户做了什么 | `users.avatar_url` 的值 | `user_avatars` 行 |
| --- | --- | --- |
| 上传图片 | `/api/users/<id>/avatar?v=<version>`（服务端写入） | 存在（含内容类型/字节/大小/版本） |
| 填外链地址 | 用户填的 URL（原样保留） | 不存在 |
| 点「恢复默认」 | 空 | 删除 |

**不变式：`user_avatars` 行存在的当前提是 `avatar_url` 正指向它。** 因此任何一处把
`avatar_url` 改成别的值（自服务 `PUT /api/users/me`、管理员 `PUT /admin/users/:id`）都会顺手
删掉那张行，不留孤儿 blob。

## 2. 限制（服务端强制，前端同时给说明）

| 项 | 取值 | 理由 |
| --- | --- | --- |
| 大小 | ≤ **1 MiB** | 头像最大显示 64px，1 MiB 已经非常宽松；库里按用户数线性增长，需要硬上限 |
| 格式 | **PNG / JPEG**（按内容嗅探，不看扩展名与客户端声明的 Content-Type） | 只留两种可安全内联渲染的位图格式 |
| 尺寸 | ≤ **1024 × 1024** | 只读图片头（`image.DecodeConfig`），不解码全图 |
| 拒绝 SVG | — | SVG 是脚本载体，内联返回等于存储型 XSS |
| 拒绝 GIF | — | 头像位置是静态缩略图，动图只会被截成第一帧，不如直接说明 |

前端在上传前做一次**统一化**，让「几乎任何图片」都能用：

1. `<input type="file" accept="image/*">`（浏览器能解码的都收：PNG/JPEG/WebP/GIF/AVIF…）；
2. 居中裁成正方形 + 缩放到 ≤ 512×512；
3. 重新编码为 PNG（有透明通道）或 JPEG 0.9，通常 20–80 KB。

于是服务端那三种限制基本不会被用户撞到；撞到时用错误码返回可读原因（见 §4）。
超出限制的**请求体**在 `http.MaxBytesReader` 处就被挡掉，不会读进内存。

## 3. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/users/me/avatar` | multipart 字段 `file`；校验→落库→版本 +1→写回 `avatar_url`；返回更新后的用户 |
| `DELETE` | `/api/users/me/avatar` | 删行 + 清空 `avatar_url`（即恢复首字母占位） |
| `GET` | `/api/users/:id/avatar` | 返回图片字节；`Content-Type` 取白名单值，`Cache-Control: private, max-age=31536000, immutable` + `ETag`；无头像 404 |

- **路径不带 base path**：库里存 `/api/users/...`，前端用 `withSubPath()` 补前缀（与
  `apiClient` 的做法一致），这样改 `KITE_BASE` 不会让库里存的历史 URL 失效。
- **`?v=<version>`** 用于缓存失效：每次上传版本 +1，URL 变了，浏览器不会拿旧图。
- **鉴权**：三者都只要登录。头像本身不敏感（用户列表里所有管理员都能看到），
  而按「只能读自己」判定会让用户列表里的头像全部 404，收益也不存在。
- **不做审计**：与昵称/邮箱等资料字段一致（它们也不进审计），避免在审计日志里制造噪音。
  真要审计时，触发点在 `pkg/users/avatar.go` 的两个写接口。

## 4. 错误码（前端按 `code` 本地化）

| code | HTTP | 含义 |
| --- | --- | --- |
| `avatar_file_missing` | 400 | 请求里没有 `file` 字段 |
| `avatar_too_large` | 413 | 超过 1 MiB（含请求体超限） |
| `avatar_invalid_type` | 400 | 不是 PNG/JPEG（含 SVG/GIF/其它） |
| `avatar_invalid_image` | 400 | 扩展名对但内容损坏、解不出图片头 |
| `avatar_dimensions_too_large` | 400 | 超过 1024×1024，`params` 带宽高上限 |

响应体沿用现有形状：`{"error": "<英文兜底>", "code": "...", "params": {...}}`，
前端 `translateError` 增加 `avatar_` 前缀分支 → `avatarUpload.errors.<code>`。

## 5. 涉及文件

- 后端：`pkg/model/user_avatar.go`（新）、`pkg/model/model.go`（注册，`tools/dbmigrate` 自动跟随）、
  `pkg/users/avatar.go`（新：校验 + 三个 handler）、`pkg/users/handler.go`（改 `avatar_url` 时清理字节行）、
  `routes.go`
- 前端：`ui/src/lib/avatar-url.ts`（加 `resolveAvatarSrc`，处理内链/外链两种值）、
  `ui/src/lib/avatar-upload.ts`（新：裁方 + 缩放 + 重编码，纯函数可单测）、
  `ui/src/lib/api/auth.ts`（两个新接口）、`ui/src/components/account/profile-section.tsx`（上传/移除 UI + 说明）、
  4 处头像渲染点改用 `resolveAvatarSrc`、两个 locale、`ui/src/lib/utils.ts`（错误码分支）
- 文档：`docs/dev/feature-code-index.md`

## 6. 未做 / 边界

- 管理员不能替别人上传头像（仍只能填 URL）。要加的话复用 `pkg/users/avatar.go` 的校验与落库函数，
  再挂一条 `POST /api/v1/admin/users/:id/avatar` 即可。
- 不做服务端重编码（需要 `golang.org/x/image`）：本仓库的依赖全部走 vendor/模块缓存，
  为头像引入一个新依赖不划算；统一化的活儿交给浏览器（前端 canvas）更省事。
- 不做 EXIF 方向纠正：手机上竖拍的照片在浏览器里已经由 canvas 按渲染方向重绘，
  这一步实际上顺带解决了。

## 7. 验证

**单测**

- Go：`pkg/users/avatar_test.go`（格式/大小/尺寸/损坏图片的拒绝、内容哈希、删除、
  改 `avatar_url` 时清理字节行、取图的头与 304、404 路径）、
  `pkg/model/user_avatar_test.go`（upsert 只留一行、删除幂等、哈希按内容寻址）
- 前端：`ui/src/lib/avatar-upload.test.ts`（裁剪取景与缩放、错误码前缀、常量与服务端一致）、
  `ui/src/lib/avatar-url.test.ts`（`resolveAvatarSrc` 的内链/子路径/外链/空值）
- `pnpm --dir ui test`：274 passed / 49 files；`tsc` / `eslint` 干净

**真机功能验证**（临时实例 + curl，未碰线上 8080）

三种数据库各起一个一次性实例（sqlite / PostgreSQL 18 / MySQL 8.4），走同一条链路：

| 检查 | 结果 |
| --- | --- |
| 上传后 `avatar_url` | `/api/users/1/avatar?v=<内容哈希>` |
| 取图 | 200，`Content-Type: image/png`、`nosniff`、`Cache-Control: ... immutable`、ETag |
| 二次上传（不同图） | URL 变化、字节替换、库里仍只有一行（upsert） |
| SVG / 文本 / 假 PNG / 2000×2000 / >1 MiB | 400 `avatar_invalid_type`、400 `avatar_invalid_image`、400 `avatar_dimensions_too_large`、413 `avatar_too_large` |
| 改成外链 | `user_avatars` 变成 0 行（不变式生效），取图 404 |
| 表结构 | PG：`bytea` + `content_hash varchar(64)`；MySQL：`longblob` + `datetime(3)`；均无自增序列 |

**过程中改掉的一个设计错误（值得记）**：最初用「自增版本号」拼 `?v=`，实测发现
「删除头像 → 再上传另一张」时版本号会从 1 重新开始，于是新图复用了历史 URL，
而那个 URL 带一年强缓存，浏览器会继续显示旧图。改成**内容哈希**后：内容变 ⇒ URL 变，
内容不变 ⇒ URL 不变（复用缓存是正确的）。`TestAvatarURLChangesAfterDeleteAndReupload`
锁住这条语义。

**未验证**：浏览器里 canvas 的实际解码/编码路径（jsdom 没有 canvas，按本轮要求也没有跑
e2e）。纯计算部分（取景、缩放）已单测覆盖，真机上服务端链路已验。
