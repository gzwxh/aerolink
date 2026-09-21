# 顶部通知栏（管理员公告，滚动输出）

需求：**在页面顶端出一条通知栏，滚动输出管理员设置的通知消息，消息要支持颜色与加粗等样式。**

本文件只做方案，未写代码。§2 的 6 个决策点需要你拍板，其余按既有约定执行。

## 1. 现状

- **没有公告/横幅能力**：全仓搜 `公告` / `announcement` / `banner` 无命中。
- **已有的通知能力都不是这个**：
  - 站内信（`pkg/notification`）按用户投递、在铃铛里，不是常驻横幅；口径见
    `plans/2026-09-21-notification-recipient-and-failure-feedback.md`。
  - 品牌名/站点名（`ui/src/contexts/branding-context.tsx`）是静态文案，不能滚动、不能定时。
- **富文本渲染已有先例**：`react-markdown` + `remark-gfm` 已是依赖，用在
  `ui/src/components/ai-chat/ai-chat-messages.tsx:402` 与 `helm-chart-detail-page.tsx`。
  两处都**没有**用 `rehype-raw`（全仓搜 `dangerouslySetInnerHTML` 只有 `ui/chart.tsx`
  的图表样式），即：Markdown 里的 HTML 不会被执行。这是本次可以复用的安全基线。
- **动画先例**：`ui/src/styles/base.css` 里已有裸 `@keyframes` + 普通 class 的写法
  （`breathing`、`ai-dot-wave`），不是 Tailwind 的 `--animate-*`。全仓**没有**
  `prefers-reduced-motion` 处理，本次要引入。
- **布局落点**：`ui/src/App.tsx:72-73`，`<SidebarInset>`（滚动容器）里紧跟 `<SiteHeader />`。
  顶栏自身是 `sticky top-0 z-50`，高度取自 `--header-height: 3.5rem`（`base.css:134`）。
  `iframe=true` 的嵌入模式直接 `return <Outlet />`（`App.tsx:64-66`），天然不含顶栏。
- **权限与审计**：
  - 控制台设置按章节授权（`middleware.RequireSettingsSection`），章节清单在
    `pkg/common/rbac.go` 的 `SettingsSections`，前端镜像在
    `ui/src/lib/rbac-permissions.ts` 的 `SETTINGS_SECTIONS`。三员的允许/拒绝集合被
    `pkg/rbac/separation_of_duties_test.go` **逐项断言**——动章节清单的连带成本很高。
  - `/api/v1/admin/*` 的写操作由 `middleware.AdminAudit()` 自动记入操作日志；
    资源类型要登记在 `pkg/middleware/audit.go` 的 `adminAuditResourceTypes`，
    否则审计行显示不出类型；对象标识取自 `adminAuditIdentifierKeys`
    （`username`/`name`/`ip`/`event`/`subject`/`cluster`/`namespace`）。

## 2. 需要你拍板的 6 点

| # | 决策点 | 建议 | 理由 |
| --- | --- | --- | --- |
| 1 | 富文本格式 | **Markdown 子集 + 具名语义色标记**：加粗/斜体/行内代码/链接用标准 Markdown，颜色用 `{warning}文字{/warning}` 这类**具名**标记，只允许 `success`/`info`/`warning`/`attention`/`destructive`/`muted`/`primary` | 复用已有 `react-markdown`（默认不执行 HTML），不新增依赖、无 XSS 面；具名色映射到既有语义 token，**自动跟随 7 套配色主题与深浅色、并落在 `theme-contrast.test.ts` 的对比度断言内**。若允许自由色值（`#ff0000`）或原始 HTML，等于在主题体系外开一个不受对比度与暗色模式约束的口子，还要新增消毒器依赖 |
| 2 | 滚动行为 | 内容超宽才滚动；**鼠标悬停暂停**；`prefers-reduced-motion: reduce` 时静止显示（截断 + 悬浮看全文） | 短公告不必来回跑；悬停暂停是滚动信息栏的既定交互；静止分支是这个项目第一次做减弱动效支持，需要一个明确的兜底口径 |
| 3 | 多条公告 | 同一栏**顺序串联**（`公告一 ● 公告二 ● …`），按优先级降序、同优先级按创建时间降序；不做轮播 | 轮播要计时器 + 状态，且漏看一条就没有第二次机会；串联在一条 marquee 里一次性交代完，实现也简单 |
| 4 | 可见范围 | **全体登录用户**；不做按角色/权限绑定组定向 | 定向会与 RBAC 交叉（谁算「符合条件」要在后端算角色，还要解释给管理员），而横幅的典型用途（停服、维护、培训）本来就是全员 |
| 5 | 生效时间 | `enabled` + 可选 `startAt` / `endAt`（留空 = 立即 / 永久），到点自动消失由**服务端过滤** | 「忘了关」是公告最常见的翻车方式；两个时间戳的成本几乎为零，比事后补一个「手动下线」流程便宜 |
| 6 | 管理入口与权限 | 复用「系统设置 → **通知管理**」章节，加一个「通知栏」页签；接口门禁用既有的 `requireNotification`（`settings.notification`） | 横幅是「发给用户看」的投递面，与通知管理同域；**不新增设置章节**——那要同步 `common.SettingsSections`、前端 `SETTINGS_SECTIONS`、三员互斥测试的允许/拒绝清单，收益不成比例 |

## 3. 数据模型

新表 `announcements`（`pkg/model/announcement.go`，按惯例在
`pkg/model/model.go` 的 `Models()` 里登记）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ID` / `CreatedAt` / `UpdatedAt` | `Model` | 沿用内嵌模型 |
| `Title` | `varchar(255) not null` | 标题，列表与审计标识用 |
| `Content` | `text` | Markdown 子集 + 具名色标记（§5） |
| `Level` | `varchar(20) not null default 'info'` | `info`/`warning`/`danger`，只决定整条的左侧色条与图标 |
| `Priority` | `int not null default 0; index` | 越大越靠前 |
| `Enabled` | `bool not null default true; index` | 总开关 |
| `StartAt` / `EndAt` | `*time.Time; index` | 生效窗口，可空 |
| `CreatorID` | `uint; index` | 谁发的（审计另有一份，这里便于界面展示） |

排序：`priority DESC, id DESC`。不做软删除（删除即删除，审计日志留痕）。

## 4. 后端设计

新包 `pkg/announcement/handler.go`，路由分两处（与 `notification` 的现有形态一致）：

**登录用户可读**（`routes.go` 的 `registerProtectedRoutes`，与 `/api/v1/notifications` 并列）：

- `GET /api/v1/announcements` → `{ items: [...] }`，只返回**当前生效**的：
  `enabled = true AND (start_at IS NULL OR start_at <= now) AND (end_at IS NULL OR end_at > now)`。

**管理端**（`routes.go` 的 `registerAdminRoutes`，`adminAPI.Group("/announcements", requireNotification)`）：

- `GET /` 全部（含未生效/已停用/已过期），供管理页；
- `POST /` 新建、`PUT /:id` 修改、`DELETE /:id` 删除。

校验（fail-closed，错误显式返回，不用默认值兜底）：

- `title` / `content` 去空白后非空；长度上限（标题 255、正文 8192，超限报错而不是截断）；
- `level` 必须是枚举值之一；
- `startAt` / `endAt` 同时给且 `startAt >= endAt` 时报错；
- 生效中的公告条数上限（建议 20，超限报错）——防止有人一次插几百条把横幅撑爆。

审计同步点（**不改这三处就是一个查不出类型的审计行**）：

- `adminAuditResourceTypes` 加 `"announcements": "announcement"`；
- 对象标识：请求体字段是 `title`，不在 `adminAuditIdentifierKeys` 里 →
  建议把 `"title"` **追加到列表末尾**（最低优先级，只在前面的键都没命中时才生效，
  不影响既有接口的标识口径）；
- 响应体/请求体不落库（既有行为），正文里的内容不会进审计。

## 5. 富文本与颜色标记（安全边界）

渲染链：`react-markdown` + `remark-gfm`，**不引入 `rehype-raw`、不覆盖 `urlTransform`**，即保持两个默认保护：

- 默认的 `urlTransform` 只放行 `https?|ircs?|mailto|xmpp`（`react-markdown/lib/index.js` 的
  `safeProtocol`），所以 `[x](javascript:alert(1))` 这类链接会被清空；
- 没有 `rehype-raw` 时，正文里的 HTML 标签不会被当成元素渲染（按纯文本显示，
  这样管理员写错了能在预览里直接看见，而不是静默消失）。

元素范围用白名单收窄为一行的行内内容（横幅不是文档页，标题/列表/表格在 marquee 里没有意义）：

```jsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  allowedElements={['p', 'strong', 'em', 'del', 'code', 'a', 'br']}
  unwrapDisallowed
  components={{ p: 'span' }}
>
  {segment}
</ReactMarkdown>
```

`unwrapDisallowed` 是关键：不写它时 `# 标题`、列表、`![图](...)` 会**连文字一起消失**；
写上之后被拒的元素只丢标签、保留文字。

颜色标记自己解析，不经过 HTML：

```
{warning}今晚 22:00 起集群升级，期间控制台只读。{/warning}
**重要**：请提前保存 `kubectl` 会话。
```

- 解析规则：`{(色名)}(...){/(色名)}`，**只有白名单色名生效**，未闭合/色名不认识时
  按原文显示（不报错、不静默吞掉内容）；
- 色名 → class：`success` → `text-success`、`warning` → `text-warning`、
  `danger` → `text-destructive`、`attention` → `text-attention`、`info` → `text-info`、
  `muted` → `text-muted-foreground`、`primary` → `text-primary`；
  **不接受任意色值**，全部走语义 token（AGENTS.md 的状态色规则 + 主题对比度断言）。
  这些 `--color-*` 已在 `ui/src/styles/base.css` 的 `@theme inline` 里声明（`:87-117`），
  工具类会正常生成——不能只写进主题 CSS，否则工具类静默失效；
- 不支持嵌套色标记（内层按原文显示），且一个 Markdown 结构不能跨色标记边界
  （`**{warning}x{/warning}**` 里的 `**` 不会生效）——这两条写在界面提示里；
- 渲染成 React 元素（不做 `dangerouslySetInnerHTML`）：按标记切段，**每段各自**交给
  `ReactMarkdown`（`components={{ p: 'span' }}` 保持单行），外层包
  `<span className="...">`。

主色标记在横幅里只影响**文字颜色**；整条的强调（左侧色条 + 图标 + 淡底）由 `Level`
统一控制，软底一律用透明度修饰（`bg-warning/10`、`border-warning/25`）。

## 6. 前端设计

**位置与形态**（`ui/src/components/announcement-bar.tsx`）：

- 渲染在 `App.tsx` 的 `<SiteHeader />` **之后**、内容区之前，**非 sticky**（随内容滚走）：
  不挤占 `--header-height`、不改既有布局变量。若你希望常驻，改用
  `sticky top-(--header-height)` 即可，是一个独立的小改动；
- 无生效公告时**不渲染任何节点**（不能留一条空白的横线）；
- 左侧一条 `Level` 色条 + 喇叭图标，中间是滚动视口，右侧不设关闭按钮（§2 第 5 点靠
  `endAt` 收口；如果你要「用户可忽略」，再加一个按公告 id 记 localStorage 的关闭按钮）。

**滚动实现**（`ui/src/styles/base.css`，沿用既有的裸 keyframes 写法）：

```css
@keyframes announcement-scroll {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
.announcement-track { display: inline-flex; animation: announcement-scroll var(--announcement-duration, 30s) linear infinite; }
.announcement-viewport:hover .announcement-track { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  .announcement-track { animation: none; }
}
```

- 内容复制一份（克隆加 `aria-hidden`）实现无缝循环；
- 用 `ResizeObserver` 量「轨道宽 vs 视口宽」：**不超宽就不加动画**（左对齐静态显示）；
  超宽时按时长 = 宽度 / 60px 每秒（下限 15s）写进 `--announcement-duration`；
- `prefers-reduced-motion: reduce` 时不滚动，内容 `truncate` + `title` 全文。

**设置页**（复用既有形态，不新增原语）：

- `ui/src/components/settings/notification-management.tsx` 加「通知栏」页签，
  `settings-sections.tsx` 的 `settingsSubTabs.notification` 加一项；
- 列表：标题、级别、状态（未生效/生效中/已过期/已停用）、时间窗、操作；
- 编辑对话框：标题、内容（textarea）、级别、优先级、生效时间、启用开关 +
  **实时预览**（复用同一个渲染组件）与「可用标记」提示（照模板编辑器列「可用变量」的做法，
  `notification-management.tsx:494`）；
- 草稿关闭走 `useUnsavedChangesGuard` + `UnsavedChangesConfirmDialog`（AGENTS.md 约定）；
- 失败一律 `toast.error(translateError(error, t))`（同上一轮的统一口径）。

**不做**：不把公告同时写进站内信（横幅本身就是投递面，重复投递违背
`plans/2026-09-21-...-failure-feedback.md` §2.3 的口径）；不改铃铛。

## 7. 涉及文件

- 后端：`pkg/model/announcement.go`（新）、`pkg/model/model.go`（登记表）、
  `pkg/announcement/handler.go`（新）、`pkg/announcement/handler_test.go`（新）、
  `routes.go`（读 + 管理两组路由）、`pkg/middleware/audit.go`（资源类型 + 标识字段）
- 前端：`ui/src/components/announcement-bar.tsx`（新）、
  `ui/src/lib/announcement-markup.ts`（新，色标记解析）、
  `ui/src/lib/announcement-markup.test.ts`（新）、
  `ui/src/components/announcement-bar.test.tsx`（新）、
  `ui/src/lib/api/announcement.ts`（新）、`ui/src/lib/api/admin.ts`（管理接口）、
  `ui/src/types/api.ts`、`ui/src/App.tsx`（挂载）、`ui/src/styles/base.css`（动画）、
  `ui/src/components/settings/notification-management.tsx`、
  `ui/src/components/settings/settings-sections.tsx`、
  `ui/src/i18n/locales/{zh,en}.json`
- 文档：本文件、`docs/dev/feature-code-index.md`（通知栏一行 + 「新增设置页签」落点）

**不用动**（容易误以为要动）：`pkg/common/resource.go`、`pkg/resources/handler.go`、
`ui/src/lib/resource-catalog.ts`——公告不是 Kubernetes 资源面，只是控制台自己的一张表。

## 8. 测试计划

**后端**（`pkg/announcement/handler_test.go`）

- 生效窗口：未开始 / 已结束 / 已停用 的公告不出现在 `GET /api/v1/announcements`；
  边界（`startAt == now`、`endAt == now`）各一条；
- 排序：优先级降序，同优先级按 id 降序；
- 校验：标题/内容为空、级别非法、`startAt >= endAt`、超长、超条数上限 → 400；
- 权限：非管理员（含只持 `settings.notification` 读权限的账号）写操作 403；
  持 `settings.notification` 读权限但无写权限时 `GET /api/v1/admin/announcements` 可见、
  写被拒（与既有章节授权口径一致）。

**前端**

- `announcement-markup.test.ts`：`{warning}x{/warning}` → 带 `text-warning` 的 span；
  未知色名、未闭合标记按原文；嵌套按原文；色标记与加粗共存时的分段正确；
- `announcement-bar.test.tsx`：0 条不渲染；多条串联；不超宽时不加动画 class；
  `prefers-reduced-motion` 下不加动画 class（`matchMedia` 打桩）；
- i18n 键集合测试自动覆盖新增键（`ui/src/i18n/locales.test.ts`）。

## 9. 验证（真机）

| 检查 | 期望 |
| --- | --- |
| 管理员建一条立即生效的公告 | 所有登录用户页面顶端出现滚动横幅；`iframe=true` 的嵌入页不出现 |
| 悬停横幅 | 停止滚动 |
| 设 `endAt` 为 1 分钟后 | 到点后横幅消失（不刷新页面的下一次查询也会消失） |
| 建两条不同优先级的公告 | 高优先级在前，用分隔符串联 |
| 正文写 `{warning}停服{/warning}` + `**注意**` | 前者按 warning 语义色、后者加粗；切到另一套配色主题与深色模式后颜色跟着变 |
| 正文写 `<img src=x onerror=alert(1)>` | 原样当文本显示，不执行 |
| 正文写 `[x](javascript:alert(1))` | 链接不生效 |
| 停用公告 / 删除公告 | 横幅立即消失 |
| 非通知管理员账号打开设置页 | 看不到「通知栏」页签；直接调管理接口 403 |
| 操作日志 | 出现 `announcement` 类型的创建/修改/删除记录，且带标题 |

## 10. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| 横幅常驻挤占垂直空间，用户抱怨 | 非 sticky（§6）；要常驻就改成 sticky，是独立小改动 |
| `prefers-reduced-motion` 下内容被截断看不全 | 截断 + `title` 全文；后续可改成「分页静态轮换」 |
| 色标记语法被管理员写错 → 原样显示一屏花括号 | 规则是「不认识的标记按原文」，不会静默丢内容；编辑对话框提供实时预览与「可用标记」清单 |
| 公告变更的生效延迟 | 读取端用 react-query（`staleTime` 5 分钟 + 窗口 focus 重取），不做轮询；「到点消失」依赖下一次查询，不追求秒级 |
| 与站内信重复打扰 | 本次不把公告写进站内信（§6 末尾） |
| 回滚 | 新表 + 新路由 + 新组件，都是加法：删掉 `App.tsx` 的挂载点即横幅不再出现，数据保留 |

## 11. 本次不做

1. 按角色 / 权限绑定组定向投递；
2. 公告的已读统计、用户「已忽略」状态（localStorage 或落库）；
3. 富文本的 WYSIWYG 编辑器（本次是 Markdown + 预览）；
4. 公告写进站内信 / 邮件；
5. 横幅上的按钮与动作链接（如「查看详情」跳内部页）；
6. 历史公告归档页（过期的只在管理页可见）。

## 12. 实施结果（2026-09-21）

### 12.1 后端

- `pkg/model/announcement.go`（新）：`Announcement` + `AnnouncementLevels`/
  `IsAnnouncementLevel`、`ListActiveAnnouncements`（生效窗口过滤放在 SQL 里）、
  `ListAnnouncements`、`CountActiveAnnouncements`、`GetAnnouncement`；
  上限常量 `AnnouncementMaxActive = 20`、`AnnouncementMaxContentLength = 8192`。
- `pkg/model/model.go`：`Models()` 登记 `Announcement{}`（AutoMigrate 建表）。
- `pkg/announcement/handler.go`（新）：生效列表（登录可读）+ 管理端 CRUD；
  校验失败、上限超限、时间窗倒置、级别非法、标题/正文超长均显式 400。
- `routes.go`：`GET /api/v1/announcements`（受保护组）+
  `adminAPI.Group("/announcements", requireNotification)` 的 CRUD。
- `pkg/middleware/audit.go`：`adminAuditResourceTypes` 加 `announcements → announcement`；
  `adminAuditIdentifierKeys` 末尾追加 `title`（最低优先级，不影响其它接口的标识口径）。

### 12.2 前端

- `ui/src/lib/announcement-markup.ts`（新）：颜色标记解析 + 色名/级别到语义 token 的映射；
- `ui/src/components/announcement-content.tsx`（新）：Markdown 子集渲染（横幅与管理页预览共用）；
- `ui/src/components/announcement-bar.tsx`（新）：滚动横幅；
- `ui/src/hooks/use-prefers-reduced-motion.ts`（新）：减弱动效订阅；
- `ui/src/lib/api/announcement.ts`（新）：类型 + 读/写 hooks，并在 `api.ts` 导出；
- `ui/src/components/settings/announcement-management.tsx`（新）：列表 + 编辑对话框（带实时预览）；
- `ui/src/App.tsx` 挂到 `<SiteHeader />` 之后；`ui/src/styles/base.css` 加 marquee 关键帧；
  `settings-sections.tsx` 加「通知栏」子页签；`notification-management.tsx` 挂上该页签。
  （挂载点已在 §12.6 改到 `SiteHeader` 内部，不再在 `App.tsx` 里。）

### 12.3 与方案的差异

1. **`Enabled` 去掉了 gorm 的 `default:true`**：实测 GORM 对声明了 `default` 的字段会跳过零值，
   于是「新建一条停用状态的公告」落库变成 `true`（即上线就会出现在所有人的横幅里）。
   改为 `not null` 由入参决定，并加了回归测试 `TestCreateDisabledAnnouncementStaysDisabled`。
   这个问题在 `users.enabled` 上一直靠建号后显式回写绕过。
2. **横幅形态用「淡底 + 底部描边 + 图标」而不是「左侧色条」**：横幅是全宽的，左侧色条
   在视觉上没有落点；级别改为控制整条的底色与图标颜色，文字颜色仍由正文标记决定。
3. **标题会加粗显示在正文前**（方案里没写这条）：否则标题字段只服务于管理列表，
   在横幅上看不到，反而显得多余。编辑对话框的说明里写明了这一点。
4. **等级/颜色取值的映射放在 `lib/announcement-markup.ts`**（而非组件文件）：
   组件文件导出常量会触发 `react-refresh/only-export-components`，同时避免管理页预览
   与横幅各写一套取值。
5. **权限只做到了路由层**（§12.4）：章节门禁是中间件，路由表里看不到它的效果，
   也没有便宜的端到端路径（管理面要求真 JWT）；因此由既有的
   `pkg/middleware/system_settings_test.go` 按章节覆盖机制，加上路由存在性/未登录 401 的守卫。
6. **正文里的连续空行会被合并成单个空白**（在 `AnnouncementContent` 里做）：Markdown 的两个
   换行会切成两个段落，而段落被渲染成相邻的两个 `<span>`，不合并就会把
   「第一段第二段」粘成一个词。只合并空行、不裁段内空白（色段两端的空格是作者写的排版）。
7. **减弱动效做了两层**：组件层不开启滚动，CSS 层再兜一层 `animation: none` +
   隐藏第二份内容。后者是必要的——两边判断不一致时，只停动画会让第二份内容原地显形，
   文字看起来是重复的。

### 12.4 测试与验证

- `pkg/announcement/handler_test.go`（新，11 例）：生效窗口过滤与边界（`startAt` 刚到 /
  `endAt` 刚过）、优先级 + id 排序、9 类非法入参各报 400、生效条数上限对新建与
  「由未生效改为生效」的编辑分别生效、创建者不被编辑覆盖、删除后从横幅消失、
  404 / 非数字 id、管理列表包含未生效与已停用。
- `kite/main_test.go`：`TestAnnouncementRoutesAreRegistered` 守卫 5 条路由存在、方法正确，
  且未带凭据的管理接口返回 401。
- 前端 `ui/src/lib/announcement-markup.test.ts`（11 例）：分段、跨行色段、未知色名/未闭合/
  嵌套按原文保留、纯文本化；并断言色名与级别样式**只准映射到语义 token**（禁止
  `text-green-600` 这类不跟随主题的色阶用具）。
- 前端 `ui/src/components/announcement-bar.test.tsx`（7 例）：零公告不渲染、多条的标题/正文
  与「取最高级别」色调、颜色标记渲染、空行合并、不超宽不滚动、超宽滚动并算出时长、
  减弱动效时不滚动且只渲染一份内容。
- `go build ./...`、`go vet ./pkg/announcement/...`、
  `go test ./pkg/announcement/... ./pkg/middleware/... ./pkg/model/... ./pkg/rbac/... .` 全过；
  `tsc --noEmit`、`vitest run`（398 例）、`eslint`、`prettier --check` 全过。

### 12.5 真机待验

按 §9 的表格跑一遍，重点是：滚动速度是否合适（60px/s）、多条公告串联的观感、
换配色主题与深色模式后颜色是否跟着变、以及减弱动效下的截断显示。

### 12.6 修订：位置与日期选择器（同一日，按真机反馈）

§12.1–12.4 里写的是「顶栏之下一整条横幅 + 原生 `datetime-local`」。真机反馈两项都不行，
已改为：

1. **位置：从「顶栏之下一整条」改成「顶栏里的一小块」**。公告现在渲染在 `SiteHeader` 的右侧
   信息区里、**集群徽章之前**（`site-header.tsx`），宽度上限 12rem/16rem/24rem（sm/lg），
   小屏隐藏（小屏顶栏本来就把语言/主题/铃铛隐了）。因此它不再占一行、不再把内容往下推，
   也不需要「非 sticky」这个约定——它就在常驻的顶栏里。
2. **日期选择改用弹层月历**。原生 `<input type="datetime-local">` 在企业环境的浏览器/策略下
   会退化成纯文本框（只能手打、点不出日历），而审计页的日期框是可用的。新增共用组件
   `components/date-time-picker.tsx`（弹出面板 + 单月日历 + 日期/时刻输入 + 清空/确认），
   取值仍是本地字符串 `YYYY-MM-DD HH:mm:ss`，空串表示「立即生效 / 永不过期」。

配套改动：

- 新增 `lib/date-time.ts`（本地时间↔RFC3339 转换、月历网格）；月历网格从 `lib/audit-time-range.ts`
  抽到这里并由它再导出，两个选择器共用同一套口径，既有单测不改。
- 提交给服务端的时间改为**带偏移的 RFC3339**（浏览器与服务端时区不一致也不会存错）；
  后端本来就优先按 RFC3339 解析，补了一条用例锁住三种写法（RFC3339 / 不带秒 / 无时区）。
- 管理页的表单草稿改用本地时间字符串（`AnnouncementForm`），只在提交时转 RFC3339。
- i18n 新增 `common.dateTime.*`（占位、日期/时刻、清空、月份标题与星期、上下月/年）。

新增测试：`lib/date-time.test.ts`（7 例，含往返一致与时区无关断言）、
`components/date-time-picker.test.tsx`（4 例：占位、点日历回写、清空、关面板不回写）。

### 12.7 修订：去掉外框、加宽、总是滚动（同一日，第二次真机反馈）

1. **去掉外面的框**：通知栏不再是带描边/底色的圆角色块，只剩「级别色的喇叭图标 + 一行
   滚动文字」，直接坐在顶栏里（`ANNOUNCEMENT_LEVEL_STYLES.bar` 随之删掉，只留
   `ANNOUNCEMENT_LEVEL_ICONS` 一行图标色）。管理页的预览同步去框——预览与实际不一致
   比没有预览更糟。
2. **显示区域加宽**：上限从 12/16/24rem（sm/lg）改为 24/36/44rem（sm/lg/xl），仍带
   `min-w-0` 可收缩，不会把顶栏挤变形。
3. **总是横向滚动**：原来「内容不超宽就不滚」的规则取消——管理员要的就是「滚动输出」。
   但直接把两份内容平移 -50% 在内容比可视区窄时会露出空白，所以先算
   `repeat = ceil(可视区宽 / 内容宽)`，再渲染 `repeat * 2` 份：前 `repeat` 份铺满，
   后 `repeat` 份用于无缝循环；时长按 `repeat * 内容宽 / 60px 每秒` 算。
   只有「减弱动效」时例外：不滚，仍只渲染一份、截断显示。

受影响的测试已同步：级别只断言图标色且断言类名里没有 `bg-`/`border-`；
新增「内容比可视区窄时重复铺满并滚动」（断言 8 份 = ceil(400/100)×2）。

### 12.8 修正：滚动不再跟随 `prefers-reduced-motion`（同一日，第三次反馈）

现象：一次性改完后真机上仍然不滚。用 Playwright 拿真实 Chromium 跑了同一段 CSS，结果：

| 浏览器媒体特性 | `animation-name` | 1s 内位移 |
| --- | --- | --- |
| `no-preference` | `announcement-scroll` | −16.7px（正常） |
| `reduce` | `none` | 不动 |

即 **CSS 本身没问题**，是浏览器在报 `prefers-reduced-motion: reduce`（企业版 Windows 常把
「动画效果」关掉），而我在两层都尊重了它（JS 不加 `is-scrolling`，CSS 里还有一道
`animation: none`），于是它永远不会滚。

决定：**去掉这两层门禁，公告总是滚动。** 理由是「滚动」不是装饰效果而是这条消息的送达
方式：停掉动画后它在单行里只剩一段被截断的不可读文字，减速也换不回可读性。保留的
缓解手段是悬停暂停（想看清滚过的那句时停下来）。

改动：`announcement-bar.tsx` 不再读 `usePrefersReducedMotion`（该 hook 已删）、
`base.css` 去掉对应的 `@media` 分支，并给轨道加上 `will-change: transform`
（避免这行持续动画带动整个顶栏重绘）。测试里的「减弱动效」用例改为
「开启减弱动效时**照常**滚动」，用同一个 Chromium 探针复验两种设置都动。

如果以后要重新尊重该设置，不能只恢复 `animation: none`：那样文字会不可读，
得同时给出不靠横向位移的展示方式（已在 §12.10 补上：拖动 + 展开全文）。

### 12.9 「读全」的三种手段（同一日）

滚动只是读到内容的手段之一，而消息很长时用户往往来不及看完（也不该要求他反复等下一圈）。
因此在这一版补上两个手段，加上原有的悬停暂停：

| 手段 | 行为 | 面向 |
| --- | --- | --- |
| 悬停暂停 | 鼠标在通知栏上时 `animation-play-state: paused` | 所有人 |
| 按住拖动 | 按左键横向拖动改 `scrollLeft`（可视区是 `overflow: hidden`，无滚动条但仍可编程滚动），松手不回弹、移开后动画继续 | 鼠标用户 |
| 展开全文 | 右侧的箭头按钮弹出一块可换行的完整内容（标题 + 正文 + 级别图标），受顶栏单行与滚动速度限制 | 所有人（含键盘/读屏器） |

实现要点：拖动状态存在 `useRef` 里（不触发重渲染）；只认左键（`button !== 0` 直接返回）；
可视区加 `select-none`（拖动时不会顺带选中文字）与 `cursor-grab`/`active:cursor-grabbing`；
不捕获指针，拖出边界松开也不会粘住。

两个机制都另外用真实 Chromium 验过（与 §12.8 同一套 Playwright 探针）：
悬停时 `animation-play-state` 为 `paused`；按住左拖 80px 后 `scrollLeft` 0 → 64、
轨道的视觉左边界从 30px 移到 -34px（内容确实跟着走），松手不回弹，鼠标移开后
动画恢复运行。jsdom 没有布局，单测只能保留「偏移量写入」与「右键不进入拖动」两项断言。

### 12.10 定稿：减弱动效用户走「静止 + 拖动 + 展开全文」

§12.8 取掉的 `prefers-reduced-motion` 门禁现在恢复了，因为 §12.9 的两个机制已经把
「停下就不可读」这个反对理由消掉了：静止时仍然可以拖动看前后文、可以展开可换行的全文。

分工：

| 浏览器偏好 | 自动滚动 | 拖动 | 展开全文 |
| --- | --- | --- | --- |
| 未开启减弱动效 | ✓（内容窄时先重复铺满） | ✓（悬停时已静止，拖的就是静止内容） | ✓ |
| `reduce` | ✗ | ✓ | ✓ |

实现：组件重新读 `usePrefersReducedMotion`（hook 已恢复），`reduce` 时不加 `is-scrolling`
且只渲染一份内容（副本不会原地显形）；`base.css` 恢复 `@media` 分支作为首帧兜底——
首帧时 hook 的状态还没落地，`is-scrolling` 可能已加上，对应用 `animation: none`
+ 隐藏第一份以外的副本（现在用 `:not(:first-child)`，不再是只能盖住第两份的
`.announcement-run + .announcement-run`）。

三种组合都用真实 Chromium 探针（长文案，会溢出可视区）复验过：

| 场景 | 自动滚动 | `animation-name` | 布局中的份数 | 拖动 |
| --- | --- | --- | --- | --- |
| 正常（`is-scrolling`，4 份） | 是 | `announcement-scroll` | 4 | 0 → 100，松手不回弹 |
| `reduce`（组件分支，1 份） | 否 | `none` | 1 | 0 → 100 |
| `reduce`（首帧兜底：`is-scrolling` + 4 份） | 否 | `none` | 1（副本被 CSS 隐藏） | 0 → 100 |

注：内容短到完全不溢出时，`reduce` 下拖不出东西也**不需要**拖——它本来就全看得见。

### 12.11 管理页：行内操作 + 所见即所得编辑器（同一日）

两项真机反馈：

1. **启用与级别改到列表行内**。两者是最常调的开关，原来必须先点「编辑」才能动。现在行内直接给出
   一个 `Switch`（沿用原来只读状态的 `aria-label`「启用」）与一个 `Select`（当前用 Badge 只做展示，
   现改为可选的下拉）。接口是覆盖式的 PUT，所以行内改动会把整条公告回传（`announcementToPayload`），
   时间原样带回（服务端给的就是 RFC3339）；只锁当前那一行（`updatingId`），不做全局忙碌态。
2. **正文改为所见即所得编辑器**（`components/announcement-editor.tsx`）：选中文字点工具栏即可
   加粗 / 斜体 / 删除线 / 改颜色，输入区里直接看到效果，不再要求管理员手写 `**…**` 与
   `{warning}…{/warning}`。存储格式**一点没变**，仍是那套受控标记，展示仍走
   `announcement-content.tsx`：编辑器只是多了一个入口。

编辑器的几个关键决定：

- **不用 `document.execCommand`**（已废弃、行为随浏览器而异、jsdom 里没实现）：加粗/颜色
  都是自己对选区做 Range 包裹（`extractContents` + `insertNode`），取消格式则把匹配的包层
  `unwrap`；“选区全选”时靠一个额外分支判断（边界落在编辑器根上时，唯一匹配的子元素就当作已有格式）。
  好处是行为可控且可单测。按钮上 `onMouseDown` 阻止默认：否则点按钮会先把选区丢掉。
- **粘贴只取纯文本**：否则表格、字体、样式会先显示成一段无法解释的内容。
- **序列化走标签白名单**（`lib/announcement-editor.ts`）：不认识的元素只取文字，
  `<script>` 与各种属性一律丢弃，因此编辑器里怎么折腾，落库的都是那几个受控标记；
  未登记的 `data-announcement-color` 也不会变成标记。
- **DOM 的归属权归组件，不归 React**：首帧用 `useLayoutEffect` 命令式铺一次内容，
  不再用 `dangerouslySetInnerHTML`。用后者时父组件每次重渲染都会把编辑器重置回初值，
  表现就是「点加粗没反应」「粘贴没反应」——这两个都是实测出来的。

新增测试：`lib/announcement-editor.test.ts`（13 例：转义、各标记双向转换、未知标签只取文字、
回车块级元素当换行、未登记颜色属性不生效、五组往返幂等）、
`components/announcement-editor.test.tsx`（9 例：挂载铺样式、选中后加粗/取消/上色并回写标记、
从色板选色、「默认颜色」清除、色板开合、无选区不变、粘贴只取纯文本、只读禁用）、
`components/settings/announcement-management.test.tsx`（3 例：行内停用会回传整条公告、
级别为行内下拉、仍可打开编辑弹窗）。

编辑器另用真实 Chromium 验过一轮（鼠标**拖选**而不是程序化选区，这是 jsdom 验不出来的）：
拖选 → 点加粗得 `**今晚 22:00 停服**`；再点颜色得 `**{warning}…{/warning}**`（嵌套正确）；
回车后新行的格式被浏览器继承，序列化为 `\n` 加同样带格式的下一行。

### 12.12 取色板重设计（同一日）

**真机反馈**：平铺的 7 个「彩色 A」按钮不好用——工具栏被撑得很长、色相顺序也看不出来，
而且没有「清除颜色」的入口。改成常用文字处理器的做法：**一个「A + 色线」下拉按钮，点开是
色板**（4 × 2 网格 + 一行「默认颜色」，与 Word / Google Docs 的心智一致）。A 下面那条线就是
当前颜色，展开时色板里对应的色块带一圈高亮。

四个决定：

- **色板里仍是语义色，不是任意色值**。新增的只有一份「色名 → `bg-*`」映射
  （`ANNOUNCEMENT_COLOR_SWATCHES`），与正文上色用的 `text-*` 指向同一批 token，因此**色块
  与上色结果必然同色**，切配色主题 / 深浅色时也不会和正文对不上。这条不能松：放 `#ff0000`
  进来就等于在主题体系外开一个不受 `theme-contrast.test.ts` 约束的口子（见 §5）。
- **面板不能抢焦点**。编辑器是 contentEditable，弹层一旦把焦点移走，选区当场就没了、颜色
  无处可上。所以没用 Popover，而是一个绝对定位浮层：色块与触发按钮都 `onMouseDown` 阻止
  默认（与工具栏其他按钮同一手法），外部点击用 `pointerdown` 而不是 `click`（`click` 要等
  mouseup，中间选区已经变了），另加 Esc 收起。
- **「默认颜色」= 摘掉颜色标记**（`clearColor`），文字原样保留，而不是包一层「默认色」的
  span。再点当前色同样等于取消——与加粗/斜体「点当前样式即取消」保持同一套语义。
- **色板顺序另立一份**（`ANNOUNCEMENT_COLOR_PALETTE`，按色相排：暖 → 冷 → 中性，4 个一行），
  不用 `Object.keys` 的键序：那是「加一个色名」的历史顺序，不适合当界面顺序。

### 12.13 编辑区与展示必须一致（同一日）

**真机反馈**：编辑区里是彩色加粗的文字，右侧预览里却冒出成串的 `****` 与 `**`，两边对不上。
要求「输入区里什么样、展示就什么样」。

**根因不在预览，在序列化**：`serializeNode` 对文本节点是**原样输出**的，所以管理员在编辑区
敲的 `**`、`#`、`{warning}` 会原封不动落库；展示侧走 Markdown 与色标解析，又把这些字符
吃成了格式。于是同一段内容，编辑区显示星号、顶栏显示加粗——预览只是把这个矛盾提前暴露了。

**修法：出编辑器时转义、进编辑器时还原**（CommonMark 的反斜杠转义）：

| 方向 | 处理 |
|---|---|
| DOM → 标记 | 文本节点里的 反斜杠 / 反引号 / `*` `_` `~` `[` `]` `{` `}` `|` `#` 一律转义成 `\X` |
| 标记 → DOM | 标记正则加**负向后顾** `(?<!\\)`（`\*\*` 不是加粗），最后再把 `\X` 还原成字面量 |
| 色标解析 | `scanMarkers` 同样跳过 `\{`，否则字面花括号会被当成色标切段 |

落库内容因此**仍是可读文本**（只多几个反斜杠，不是 HTML 实体）。两条正则必须成对，
`lib/announcement-editor.test.ts` 的往返用例就是钉这个的。

**同一轮去掉预览区块**：它和输入区**必然对不上**——预览走最终渲染，输入区是受控子集的
所见即所得，两者并排放只会让人反复怀疑是不是自己写错了。现在弹窗改成单列、输入区独占整宽，
「编辑里什么样」本身就是唯一参照。

> 实测抓到的一个 bug：`escapeMarkdown` 的替换串写成 `'\\$1'`，但正则当时**没有捕获组**，
> `$1` 被原样输出，落库内容直接变成 `\$1`。往返用例当场失败——这类错误只看代码很难发现，
> 是「有对照的测试」抓出来的。

### 12.14 编辑区看不到颜色 / 孤儿标记（同一日）

**真机反馈**：顶栏里那段文字是警告色，编辑区里却是黑的，两个框内容对不上。

**根因一：颜色段没带 class。** `announcementMarkupToHtml` 铺出来的 span 只写了
`data-announcement-color`，没有 class；而工具栏手动上色那条路径（`applyFormat`）是**自己设
class** 的。于是「重新打开一条已有公告」时编辑区一律是黑字，只有当场点色块才有颜色——
两条路径都得上色，「编辑区所见即所得」才成立。

**根因二：配对失败的孤儿标记会以字面 `{danger}` 露出来。** `buildSegments` 只把配对成功的
标记切成色段，所以留在文本里的已登记标记必然是没配上的（交叉嵌套、反复上色又取消留下的）。
它们原本**按原文显示**，更要命的是编辑器再保存一次会把这个字面量**转义**成 `\{danger\}`，
数据越修越脏。现在 `parseAnnouncementMarkup` 出口统一剔除孤儿标记（**内容保留**），
**未登记的色名（如 `{rainbow}`）仍按原文显示**——那是管理员自己写错的，要让他看得见。

线上那条数据（空色段 + 交叉嵌套 + 裸露 `**`）已固化成回归用例：
`announcement-markup.test.ts` 的「真实畸形数据」。

**遗留数据的自愈路径**：正文里裸露的 `**` 是转义改造（§12.13）之前存下的。在编辑弹窗里
**重新保存一次**即可：DOM 里的加粗会序列化成正确的 `**…**`、字面星号会被转义，此后编辑区
与顶栏一致。

### 12.15 横向滚动改为可配置（同一日）

**需求**：通知栏一直默认横向滚动，但要能按公告配置是否需要滚。

**数据模型**：`announcements` 加一列 `scroll boolean`（沿用 `AutoMigrate`，没有独立迁移文件）。

**三个必须踩准的点**：

1. **默认必须是滚动**。`Scroll` 的零值是 `false`，而历史行为一直是滚动——直接用 `bool` 会让
   升级后所有老公告**突然停住**。所以在 `MigrateAnnouncementScrollBackfill` 里回填，且
   **必须在主 AutoMigrate 循环之前调用**：加列与「判断这列是不是刚加的」必须紧邻，主循环跑完
   就分不清了。判断用 `Migrator().HasColumn`，**只在列不存在的那一次**回填，因此管理员显式
   设的「不滚动」不会被每次启动改回去。
2. **模型上不能写 `gorm:"default:true"`**。声明了 default 的字段在 Create 时会被跳过零值，
   「显式设为不滚动」就永远写不进去（`users.enabled` 踩过同一个坑）。默认值改在请求解析层兜底：
   `announcementRequest.Scroll` 用 `*bool`，`nil` 当 `true`。
3. **覆盖式 PUT 不能丢字段**。行内改级别/启用会把整条公告回传，`announcementToPayload` 必须
   带上 `scroll`，否则一次点「启用」就把「不滚动」悄悄清掉。已有专门的回归用例，mock 里**特意**
   用 `scroll: false`——写成默认 true 或漏传都会当场失败。

**多条公告的取舍**：它们串成**一条**轨道输出，没法一半滚一半不滚，所以取「任一条要求滚动就
滚动」，与「级别取最高」同一套逻辑。前端用 `item.scroll !== false` 判断，老数据缺字段时按滚动
处理，与后端默认值一致。

**静态显示时的「读全」手段**：与 `prefers-reduced-motion` 复用同一条静止路径——仍是单行，
但拖动查看与「展开全文」都还在，不会退化成一段看不完的死文字。

**测试**：`pkg/model/announcement_test.go` 用「删掉列 → 回填 → 再跑一次」覆盖了上面第 1 条的
两个方向；`pkg/announcement/handler_test.go` 覆盖默认值与显式 false 落库（含回读校验）；
前端 `announcement-bar.test.tsx` 覆盖「关闭滚动时静止」与「任一条开启则整条滚动」。

### 12.16 滚动被客户端偏好否决 + 顶栏挤压（同一日）

**真机反馈**两条：公告勾了「横向滚动」却不滚；顶栏里的「系统设置」被压成竖排（一行一个字）。

**第一条：不是代码写错，是设计冲突。** 数据链路是通的（`/api/v1/announcements` 确实返回
`scroll: true`），但滚动被**两处** `prefers-reduced-motion` 静默否决：

| 位置 | 旧行为 |
|---|---|
| `announcement-bar.tsx` | `scrolling = autoScroll && !prefersReducedMotion`，系统开了减弱动效就不加 `is-scrolling` |
| `base.css` | `@media (prefers-reduced-motion: reduce) { .announcement-track.is-scrolling { animation: none } }` |

结果就是「没滚，而且没有任何解释」。现在**两处都去掉**：是否滚动只看公告自己的配置——
管理员已经按条决定过，这是**内容呈现要求**，优先级高于客户端偏好。动画本身很慢（60px/s），
配置为不滚动时也仍有拖动与「展开全文」。

**第二条：中文没有分词点，一被挤窄就逐字换行。** `DynamicBreadcrumb` 只有 `hidden md:block`，
没有 `whitespace-nowrap`；顶栏那一层容器也没有 `min-w-0`，于是右侧那组固定宽度的元素
（公告栏、集群徽章、搜索）不让步，压力全落在面包屑上，把它压到只剩几个字宽，
「系统设置」就被拆成了竖排。两头一起修：

- 面包屑：`hidden min-w-0 truncate md:block`（不换行；空间不够时宁可裁掉一部分）；
- 顶栏容器：补 `min-w-0`，让这一层真的能收缩；
- 公告栏宽度同时收窄：`sm:max-w-96 / lg:max-w-[36rem] / xl:max-w-[44rem]`
  → `sm:max-w-72 / lg:max-w-80 / xl:max-w-96`（288 / 320 / 384px）。

> 顺带记一个坑：**Tailwind 的任意值类没有进产物**。先改成 `lg:max-w-[26rem]`，构建后在
> CSS 里 grep 不到；换成标准刻度（`max-w-80` 等）就正常了。写任意值时最好在产物里确认一次。
