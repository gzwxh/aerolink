# 集群徽章（自定义说明 + 颜色 + 图标）与集群切换器优化

## 背景与目标

多集群部署下，集群名（`dev`、`devops-wxh`、`in-cluster`）本身看不出用途，切换器里
只有名字 + `description`，一眼分不清「这是测试环境还是生产」。目标：

1. 给集群加一个**徽章**：一段用户自定义的说明（如「测试环境」）、一个背景色；展示在
   顶栏 / 创建页的「当前集群」标签与集群管理列表上，说明文本上限 **16 个字符**、
   整段显示不截断。
2. 给集群加一个**自定义图标**：可以上传图片（与用户头像同一套处理链路，落库），
   也可以只写**图标文本**（最多 6 个汉字，显示时整段展开、不截断）。
3. 优化侧边栏集群切换器的呈现：**只显示集群名称 + 描述**（两行），徽章不在这里出现。

## 数据模型

`clusters` 表新增 6 列（`pkg/model/cluster.go`），由 `AutoMigrate` 加列，
旧行落零值 = 「未启用徽章 / 未自定义图标」，因此升级后行为不变：

| 列 | 类型 | 含义 |
| --- | --- | --- |
| `badge_enabled` | boolean, default false | 是否展示该集群的徽章（说明 + 颜色） |
| `badge_text` | varchar(32)，口径 16 个字符 | 徽章文本（「自定义说明」，如 测试环境） |
| `badge_color` | varchar(16) | 徽章背景色，`#RRGGBB` |
| `badge_icon_enabled` | boolean, default false | 是否用自定义图标替换默认集群图标 |
| `badge_icon_text` | varchar(8) → 实际按 6 个字符校验 | 图标文本（如 测试环境） |
| `badge_icon_url` | varchar(255) | 上传图标的地址，`/api/v1/clusters/<id>/badge-icon?v=<哈希>` |

`badge_text` 的列宽留 32 只是容量余量，口径由校验收到 16：收窄列宽不会带来好处，
反而会让老数据在 `AutoMigrate` 时出错。

图标图片的字节单独成表 `cluster_badge_icons`（`pkg/model/cluster_badge_icon.go`），
以 `cluster_id` 为主键，存 `data` / `content_type` / `content_hash`：

- **不把图片塞进 `clusters` 行**。集群列表每次都会全量查询，几百 KB 的 blob 会让
  列表接口跟着变重；分表之后列表只带一个 URL 字符串。
- **`content_hash` 参与 URL**。图标按内容哈希破缓存（`?v=<hash>`），重新上传会换 URL，
  因此可以给取图接口开很长的 `Cache-Control` / `immutable`。
- **「有字节行 ⇔ `badge_icon_url` 指向它」**。URL 只由上传/删除图标的接口维护，
  `PUT /admin/clusters/:id` 刻意不接收该字段；`DeleteCluster` 一并删图标行，
  避免留下取不到的孤儿 blob。

取舍：

- **不复用 `description`**。`description` 是完整描述（列表里第二行、切换器里作为
  兜底文案），徽章是短标识；两者语义与长度约束不同，合并会让「备注太长」更难处理。
- **图标保留独立开关**（而不是「图标文本为空即默认」）。参考稿里复选框未勾选时
  「图标文本」仍然保留内容，独立开关才不会在切换勾选状态时丢掉已填文本。
- **图标与徽章开关解耦**。图标是集群自己的标识，只换图标不显示说明的集群同样要能
  看到它；`badgeIconEnabled` 单独控制图标，徽章开关只控制说明与颜色。徽章关着时
  `/clusters` 不下发徽章字段，但图标字段照常下发。
- **不给 `CreateCluster` 加徽章字段**。徽章是创建之后的展示偏好，走同一个
  `PUT /admin/clusters/:id`（该 handler 的可选字段一律用指针，只改徽章的请求不会
  碰到 `in_cluster` / `is_default` / `enable`）。少一个写入面就少一处要维护的语义。
- **图标上传复用头像链路**。服务端把「嗅探类型 + 尺寸校验」抽到 `pkg/imageupload`，
  前端把「裁方 + 缩放 + 重编码」抽到 `ui/src/lib/square-image.ts`；两侧只有参数与
  错误码前缀不同，避免复制粘贴后两边行为漂移。

## 校验（fail-closed）

`pkg/cluster/cluster_handler.go` 里集中一个 `validateClusterBadge`，创建/更新共用语义：

- `badgeColor` 非空时必须匹配 `^#[0-9a-fA-F]{6}$`，否则 400。颜色会进前端 `style`，
  只放行严格十六进制是为了不把任意字符串带进样式。
- `badgeText` 去掉首尾空白后按 rune 计 ≤ 16；`badgeIconText` ≤ 6。超限 400，不静默截断。
- 前端渲染时再兜一层：颜色不合法就回落默认色（历史数据 / 手工写库都不至于渲染出
  非法样式）。

图标上传（`pkg/cluster/cluster_badge_icon.go` + `pkg/imageupload`）：

- 只接受 **PNG / JPEG**，并按**内容嗅探**判定而不是文件名或 `Content-Type`
  （伪装成 `.png` 的文本、SVG 都会被挡）。SVG 能内联脚本，属存储型 XSS，明确拒绝。
- `image.DecodeConfig` 只读文件头判尺寸，边长 > 1024 直接拒，不把大图整个解码进内存。
- 请求体上限（`http.MaxBytesReader`）与 `MultipartForm` 上限对齐 1 MiB，超限 413。
- 所有失败路径都**不落库、不动 `badge_icon_url`**：一次失败的替换不能把在用的图标弄没。

## 落点

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 模型 | `pkg/model/cluster.go` | 新增 6 个字段；`DeleteCluster` 顺带删图标行 |
| 图标模型 | `pkg/model/cluster_badge_icon.go` | 图标字节表（`cluster_id` 主键 + `content_hash`）与增删查 |
| 图片校验 | `pkg/imageupload/imageupload.go` | 共享的 MIME 嗅探 + 尺寸/体积上限（头像复用同一套） |
| 图标接口 | `pkg/cluster/cluster_badge_icon.go` | 上传 / 删除 / 取图三个 handler，`BadgeIconPath` 生成带哈希的 URL |
| 路由 | `routes.go` | `POST\|DELETE /api/v1/admin/clusters/:id/badge-icon`、`GET /api/v1/clusters/:id/badge-icon` |
| 接口类型 | `pkg/common/types.go` | `ClusterInfo` 带上 6 个徽章/图标字段（`omitempty`） |
| 集群 handler | `pkg/cluster/cluster_handler.go` | `GetClusters`/`GetClusterList` 回填展示信息；`UpdateCluster` 接收 + 校验徽章；`validateClusterBadge` |
| 后端测试 | `pkg/cluster/cluster_handler_test.go`、`pkg/cluster/cluster_badge_icon_test.go` | 徽章往返 + 非法颜色/超长文本（17 字拒、16 字收）被拒 + 图标独立下发；图标上传/替换/删除/拒绝路径 |
| 前端类型 | `ui/src/types/api.ts` | `Cluster` 加 6 个可选字段 |
| 前端 API | `ui/src/lib/api/admin.ts` | 徽章字段更新请求；`uploadClusterBadgeIcon` / `deleteClusterBadgeIcon` |
| 图片处理 | `ui/src/lib/square-image.ts`、`ui/src/lib/cluster-icon-upload.ts` | 裁方/缩放/重编码管线（与头像共用）与图标侧参数、错误码 |
| 展示组件 | `ui/src/components/cluster-badge.tsx` | `ClusterBadge`（文本徽章，整段展示）、`ClusterBadgeIcon`（图片 > 文本 > 默认）、颜色兜底、`CLUSTER_BADGE_TEXT_MAX_LENGTH` |
| 切换器 | `ui/src/components/cluster-selector.tsx` | 触发器：图标 + 名字 + 描述（两行）；下拉项：图标 + 名字 + 描述。都不显示徽章 |
| 当前集群标签 | `ui/src/components/current-cluster-badge.tsx` | 徽章（图标 + 说明）排在最前，集群名以加大字号的徽章跟在后面（不写「当前集群：」前缀，前缀只在 title 上） |
| 集群管理 | `ui/src/components/settings/cluster-management.tsx` | 名称列：徽章（图标 + 说明）+ 名称，描述跟在名称下方（原独立描述列并入）；行操作加「自定义徽章」 |
| 徽章弹窗 | `ui/src/components/settings/cluster-badge-dialog.tsx` | 预览 + 显示开关 + 说明 + 背景色 + 图标上传/移除 + 图标文本 |
| 前端测试 | `ui/src/components/cluster-badge.test.tsx`、`ui/src/lib/cluster-icon-upload.test.ts` | 颜色兜底、图片优先级、6 字 / 16 字不截断、错误码前缀 |
| i18n | `ui/src/i18n/locales/{zh,en}.json` | `clusterBadge.*`（含 `errors.*`）、`clusterManagement.actions.badge` |
| 文档 | `docs/api/cluster-management.md`、`docs/en/api/cluster-management.md`、`docs/dev/feature-code-index.md` | 接口与导航 |

## 展示规则

- 徽章文本：`badgeEnabled && badgeText.trim()` 才渲染；否则不占位。
- 自定义图标：`badgeIconEnabled` 单独决定是否替换默认 `IconServer`，优先显示上传的
  图片，其次是图标文本。不要求徽章开关也打开。
- 图标文本与徽章文本都**必须整段显示**、不 `truncate`：上限分别是 6 个汉字与 16 个
  字符，容器只锁高度、宽度按文本撑开（固定宽度会把末尾几个字切掉）。
- 徽章（图标 + 自定义说明）与集群名**同一行**，徽章排在最前面。
- 展示位置：顶栏与创建页的「当前集群」标签、集群管理列表的名称列显示徽章；集群切换器
  （侧边栏触发器的「名称 + 描述」两行、下拉项的名称 + 描述）**不显示徽章**。两处宽度
  预算不同——切换器要同时放下集群名和描述，页面里才有富余。
- 图片加载失败（404 / 损坏）回落到图标文本或默认图标：组件记住失败的地址而不是
  一个布尔值，重新上传换过 URL 后会再试一次。

## 验证

- `go test ./pkg/cluster/...`、`go build ./...`、`go vet ./...`
- `pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json`、`eslint`、`vitest`
- `make pre-commit`
- 本次相关的前端用例：`ui/src/components/cluster-badge.test.tsx`（图片优先级 / 6 字与
  16 字不截断 / 图标独立于徽章开关）、`ui/src/lib/cluster-icon-upload.test.ts`（错误码
  前缀与上限常量）、`ui/src/lib/avatar-upload.test.ts`（共享管线，头像侧不回归）。
