# 方案：小 UX 组件（刷新反馈 / 前进后退 / 空态等）

- 对应总览报告中的第 **7** 项（P0 清单）
- 状态：**① ② 已实现**（2026-09-18）；③④⑤ 按本文结论暂缓 / 待调研
- 实现记录：
  - ① `ui/src/components/refresh-button.tsx` + `ui/src/components/refresh-button.test.tsx`；工具栏新增 `onRefresh` prop（`resource-table-toolbar.tsx`），`resource-table.tsx` 把数据层 `refetch` 透传下去，监听模式下文案为 `resourceTable.refreshWatch`
  - ② `ui/src/contexts/navigation-context.tsx` + `ui/src/contexts/navigation-context.test.tsx`、`ui/src/components/navigation-controls.tsx`；挂在 `App.tsx` 的 AppProviders 与 `site-header.tsx`（侧边栏开关之后），快捷键已登记到 `docs/dev/feature-code-index.md`
  - 两种组合都接受（`⌘/Ctrl+[`、`⌘/Ctrl+]` 与 `Alt+←`、`Alt+→`），提示按平台显示；待浏览器实测确认 `Alt+←/→` 在 Windows 上不会被浏览器自身后退抢走
- 结论先行：**先做 ①刷新按钮 与 ②前进后退**；③④⑤ 需要先满足前置条件，本文给出判断标准而不是直接开工

## 0. 候选与优先级

| # | 组件 | 建议 | 理由 |
| --- | --- | --- | --- |
| ① | RefreshButton（带最短旋转反馈） | **先做** | 工具栏目前只有"刷新间隔"，没有"立刻刷新"；数据层已暴露 `refetch`，改动小、体感明显 |
| ② | NavigationControls（历史前进/后退 + 快捷键） | **先做** | 控制台层级深（列表→详情→子资源），现在只能靠面包屑或侧边栏重走；需要在共享层做，晚做成本更高 |
| ③ | ColumnFilterPopover（列头筛选） | 缓 | 现有筛选已有一套（服务端参数 + 客户端 searchQueryFilter），列头筛选容易变成第二套语义 |
| ④ | PageFind（页内查找 ⌘F） | 缓 | 表格未虚拟化，浏览器原生查找可用；Monaco/xterm 自带查找。等虚拟滚动引入后再做 |
| ⑤ | EmptyState（无集群/无权限/空数据统一态） | 先调研 | 目前 UI 没有"无集群"文案（grep 无命中），需要先把真实表现盘出来，否则是"先做组件再找场景" |

---

## ① RefreshButton

### 现状（已核对）

- 工具栏只有刷新**间隔**：`ui/src/components/resource-table-toolbar.tsx` 的 `Select`（`onRefreshIntervalChange`，触发器里放了 `RefreshCw` 图标），没有手动触发入口
- 数据层已具备手动刷新能力：`ui/src/hooks/use-resource-table-data.ts:50` 暴露 `refetch`（SSE/watch 模式下为 `watch.refetch`）

### 设计

- 新建 `ui/src/components/refresh-button.tsx`：
  - props：`onClick: () => void`、`minSpinMs?: number`（默认 1000）、`disabled?`、`className?`
  - 行为：点击后立刻调用 `onClick`，并让图标至少旋转 `minSpinMs`（避免"刷太快看不出反馈"）；重复点击重置计时器；`disabled` 时不旋转
  - 无障碍：`aria-label` + `title` 走 i18n（`common.actions.refresh`），不使用仅图标无标签的写法
- 接入链路：
  1. `use-resource-table-data` 的 `refetch` 已在 `resource-table.tsx` 内部可取到
  2. 给 `resource-table-toolbar.tsx` 增加 `onRefresh?: () => void` prop，渲染在刷新间隔 Select 左侧
  3. `resource-table.tsx` 把 `refetch` 透传下去（**不要**在各列表页各接一遍）
- 语义细节：SSE/watch 模式下按钮文案与提示改为"重新连接并拉取"（`resourceTable.watch` 相关文案已在 toolbar 里出现过，沿用同一套 i18n）

### 测试

- 组件测试 `ui/src/components/refresh-button.test.tsx`：点击只调用一次回调；`minSpinMs` 内图标带旋转类名，之后消失（fake timers）；`disabled` 时不触发
- 回归：`resource-table.test.tsx` 继续通过；表格工具栏现有筛选不回归

### 风险

- 间隔刷新与手动刷新叠加会造成并发请求 → 在 `use-resource-table-data` 侧复用已有的 `refetch`（react-query 自带去重），不要在按钮里再开一条请求
- 若某页用的是本地 state 而非 react-query，接 `onRefresh` 时需明确它的"刷新"含义（本期只接统一数据层，其他页面不接）

---

## ② NavigationControls（应用内前进/后退）

### 现状（已核对）

- 前端**没有**导航历史设施：`ui/src` 内 `onContextMenu`、navigation context 均无命中；顶部右侧是 `ui/src/components/site-header.tsx` 的 `ml-auto flex items-center gap-2`（集群徽标 / 搜索 / 创建 / kubectl 入口）
- 面包屑是 `ui/src/components/dynamic-breadcrumb.tsx`（只表达层级，不能回到"上一页"）

### 设计与关键决定

**不要用 `window.history.back()`**：项目里大量导航是 `navigate(..., { replace: true })`（创建页切命名空间、设置页切 tab 等，见 `ui/src/pages/secret-create-page.tsx` 与 `ui/src/pages/configmap-create-page.tsx`），浏览器历史栈与应用语义不一致，会退到"看起来没动"的页面。

改为自维护应用内栈 `ui/src/contexts/navigation-context.tsx`：

- 用 `useLocation()` + `useNavigationType()` 监听；`PUSH` → 入栈，`REPLACE` → 替换栈顶，`POP` → 栈指针前移/后移
- 栈元素 `{ path, search }`，持久化到 `sessionStorage`（刷新页面不丢，关标签页即清）
- 暴露 `canGoBack`、`canGoForward`、`goBack()`、`goForward()`
- 前进/后退用 `navigate(target, { replace: true })` 执行，并**标记为"栈内移动"**，避免把移动本身再记成新条目
- 栈深度上限（如 50）与初始条目（`/` 或首个可访问页面）

`ui/src/components/navigation-controls.tsx`：

- 两个图标按钮（`ArrowLeft`/`ArrowRight`，项目内已有 lucide 用法），`disabled` 由 `canGoBack/canGoForward` 决定
- Tooltip 展示平台化快捷键（mac `⌘[` / `⌘]`，其他 `Alt+←` / `Alt+→`），与浏览器一致以减少学习成本
- 快捷键监听放在 context 内（只注册一次）：`window.addEventListener('keydown')`；当 `document.activeElement` 落在 `input/textarea/select/[contenteditable]`、或 Monaco/xterm 容器内时**不拦截**（参考 `ui/src/components/global-search-provider.tsx` 的 ⌘K 处理方式，避免与之冲突）

落点：`ui/src/App.tsx`（包 Provider）+ `ui/src/components/site-header.tsx`（渲染按钮）+ `ui/src/i18n/locales/{zh,en}.json`。

### 测试

- context 单测：PUSH/REPLACE/POP 的栈变化；`sessionStorage` 恢复；深度上限；`goBack` 后 `canGoForward` 为真
- 组件测试：快捷键在输入框聚焦时不触发（对照 global-search 的用例写法）
- e2e 可选：`resource-detail.spec.ts` 里加一段"从详情返回列表"的断言

### 风险

- 与浏览器自身前进后退的关系：应用内栈与浏览器栈并存，需在文档里写清"顶部按钮走应用内栈，浏览器按钮走浏览器栈"，避免用户困惑
- 重定向类路由（如 `ui/src/routes.tsx` 里的 `<Navigate replace>`）不应产生历史条目 → 依赖 REPLACE 处理即可
- 登录/初始化等未鉴权页面不应入栈（在 context 里按路径过滤）

---

## ③ ColumnFilterPopover（暂缓）

- 现状：筛选集中在 `ui/src/components/resource-table-toolbar.tsx`（若干 `MultiSelect` + 搜索框 + 命名空间选择），列头没有筛选入口
- 暂缓原因：现在有**两套筛选语义**——服务端参数（分页/时间窗/资源维度）与客户端 `searchQueryFilter`（`ui/src/components/resource-table.tsx` 内的本地过滤）。列头筛选必须明确挂在哪一套上，否则同一列会出现"看起来筛了但结果不对"
- 开工前置条件（满足其一再做）：① 某列表已有明确的服务端筛选字段却放在客户端过滤；② 列数 > 10 且已有用户反馈定位困难
- 若做：`ui/src/components/column-filter-popover.tsx` + 在 `resource-table-view.tsx` 的列定义里支持 `filterConfig`，且**只在服务端筛选语义下启用**

---

## ④ PageFind（暂缓，作为虚拟滚动的配套项）

- 现状：表格未做虚拟滚动（`resource-table-view.tsx` 直接渲染行），浏览器原生 ⌘F 可命中；YAML 编辑（Monaco）与终端（xterm）自带查找
- 何时需要：引入虚拟滚动后（行不在 DOM 里，原生查找失效）才值得自研页内查找
- 若做：`ui/src/components/page-find-provider.tsx` + 高亮当前匹配项 + ↑↓ 跳转；注意与 ⌘K 全局搜索的快捷键区分（⌘F 不要被全局搜索占用）

---

## ⑤ EmptyState（先调研，不先写组件）

现状缺口：UI 里没有"未添加集群"这类文案（本地 grep 无命中），零集群/无权限时的表现未验证。建议先产出一份核查清单（4 态 × 主要页面）：

| 状态 | 需要核实 |
| --- | --- |
| 零集群（新装未导入） | 概览页、侧边栏资源分组、集群选择器的表现是否自洽；是否引导到设置 |
| 无权限（角色不含该资源 read） | 列表是空表、403 提示还是隐藏入口（`useCan()` 的展示判定是否覆盖） |
| 加载中 | 是否统一 Skeleton（现有 `components/ui/*` 是否有 skeleton 原语） |
| 出错 | `ui/src/components/error-message.tsx` / `error-boundary.tsx` 的覆盖情况 |

核查完成后再决定是否抽 `ui/src/components/empty-state.tsx`（图标 + 标题 + 说明 + 可选操作按钮），并把上述页面统一接入。

---

## 共同约定（三个以上组件都要遵守）

1. **文案进 i18n**：`ui/src/i18n/locales/{zh,en}.json` 两处同步，且在调用处提供 `defaultValue`（现有代码风格）
2. **快捷键集中**：新快捷键必须在 `docs/dev/feature-code-index.md` 的"共享行为"里登记，避免与 ⌘K、终端、编辑器冲突
3. **组件放置**：`ui/src/components/` 下新建文件；只读展示组件不要碰 `components/ui/*`（shadcn 托管）
4. **可测**：每个新组件配一个 `*.test.tsx`（仓库已有 vitest + Testing Library 基建）

## 验收标准

- ①：工具栏出现"立刻刷新"，点击有可见反馈且只发一次请求；带组件测试
- ②：顶部出现前进/后退，快捷键可用；在输入框/编辑器内不误触发；带 context 单测
- ③④⑤：本文给出暂缓/调研结论与触发条件，**不实现**
- `pnpm run test`、`tsc`、`eslint`、`prettier` 全绿
