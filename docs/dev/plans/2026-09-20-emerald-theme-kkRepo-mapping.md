# 墨绿主题与 kkRepo 的语义 token 对齐

- 状态：**已完成**
- 触发：用户指出 `ui/src/styles/themes/emerald.css` 参考的 kkRepo 源码，要求「颜色的配置数字
  尽量保持一致」。
- 结论：**色值本身早就逐项取自 kkRepo，本次补的是没落地的语义 token**——kkRepo 在组件层
  直接引用的 `--table-head-ink` 与 `--row-hover`，Kite 里没有入口。

## 1. 参考对象到底是什么

用户给的路径是 `admin-ui/.../META-INF/resources`（打包产物）。该目录下 `admin.css` 首行写着
「Theme tokens come from the selected shared CSS template linked before this file」，文件内
`body { color: var(--text) }`，`--text` 就是共享契约里的 `--ink-2`。也就是说 **admin 控制台、
browse UI、登录弹窗三处共用同一套 token**，真正的标的是
`browse-ui/.../browse/assets/themes/default.css`（Apache-2.0）。所以对齐的标的是那份契约，
不是产物里的 CSS。

## 2. 映射表（kkRepo → Kite）

Kite 用 shadcn 的变量名，kkRepo 用自己的语义名，逐一对应如下（暗色无 kkRepo 参考，按第 4 节派生）：

| kkRepo | 值 | Kite |
| --- | --- | --- |
| `--canvas` | `#ffffff` | `--background` |
| `--surface` | `#ffffff` | `--card` / `--popover` |
| `--ink-2` | `#24322e` | `--foreground`（含 `*-foreground`） |
| `--ink-3` | `#5a6a64` | `--muted-foreground` |
| `--ink-1` | `#12211d` | `--secondary-foreground` |
| `--brand` | `#0e7c6f` | `--primary` / `--ring` / `--chart-1` |
| `--active-ink` | `#ffffff` | `--primary-foreground` |
| `--surface-sunken` | `#eef3f1` | `--secondary`、`--muted` |
| `--brand-tint` | `#e6f4f0` | `--accent` |
| `--brand-strong` | `#0a6055` | `--accent-foreground` |
| `--danger` | `#a63a26` | `--destructive` |
| `--line` / `--line-strong` | `#dbe2de` / `#c3cec8` | `--border` / `--input` |
| `--topbar` | `#16191b` | `--sidebar`（Kite 没有独立顶栏，深色顶栏映射到侧边栏） |
| `--topbar-ink` | `#f4f7f6` | `--sidebar-foreground` / `--sidebar-accent-foreground` |
| `--brand-bright` | `#2fbfa4` | `--sidebar-primary` / `--sidebar-ring`（kkRepo 的 `--topbar-active` 就是它） |
| `--topbar-hover` | `rgba(255,255,255,.09)` | `--sidebar-accent` |
| `--topbar-line` | `#2a2f31` | `--sidebar-border` |
| `--info` / `--success` / `--warning` | `#2c5686` / `#0f6d47` / `#8a5a12` | `--chart-2` / `--chart-3` / `--chart-4` |
| `--shadow-sm` / `--shadow-soft` / `--shadow-pop` / `--shadow-modal` | | `--shadow-*` 系列 |
| `--accent` | `#b8623f` | `--chart-5`（注意同名不同义：kkRepo 的 `--accent` 是暖色签名色，Kite 的 `--accent` 对应的是它的 `--brand-tint`） |

## 3. 本次补的三处

kkRepo 的 `.nx-table` 规则是 `.nx-table th { background: var(--header); color:
var(--table-head-ink) }`、`.nx-table tbody tr:hover { background: var(--row-hover) }`。
Kite 的表格原语把它们写死成 `bg-muted` / `text-foreground` / `hover:bg-muted/50`：

1. **表头底色**：把 `--muted` 从 `--surface-muted`(#f7faf9) 改指向 `--header`
   （= `--surface-sunken` #eef3f1）。token 级改动，只有本来就画底色的表头会变；
   显式写 `bg-background` 的表格（如 `workload-pods-card`）不受影响。
   这里**没有**用「给所有 `[data-slot=table-header]` 上底色」的规则：`<TableHeader>`
   在仓库里共 9 处，多数没带 `bg-muted`，一刀切会误伤它们。
2. **表头文字色**：`--table-head-ink`(#5a6a64 = `--ink-3`)，用主题作用域规则落到
   `[data-slot='table-head']`。
3. **行悬浮底色**：`--row-hover`(#e6f4f0 = `--brand-tint`)，用主题作用域规则落到
   `[data-slot='table-row']:hover`。

第 2、3 条必须落到组件层，是因为 Kite 的这两处写法没有 CSS 变量入口。规则只带
`.color-emerald` 前缀（也就是只影响墨绿主题），没有改 `ui/src/components/ui` 下的
shadcn 原语。

行悬浮那条加了 `:has([data-slot='table-cell'])` 限定：`resource-table-view.tsx` 里展开的
行详情用原生 `<td>` 且刻意写成 `hover:bg-muted/20`（悬浮不变色），不能被覆盖。

## 4. 暗色（kkRepo 没有暗色 token）

kkRepo 只提供浅色契约，暗色变体按其深色系 token 派生，不引入契约外的色值：
`--topbar`/`--topbar-line`/`--topbar-ink`/`--topbar-muted`/`--ink-1`/`--ink-2`/`--brand-bright`
以及 `-line` 系（`--danger-line`、`--info-line` 等）。

本次暗色补的两项也照这个规则取：`--table-head-ink` 取 `--topbar-muted`(#b4bfba)，
`--row-hover` 取 `--topbar-hover`(rgba(255,255,255,.09))。后者是修正：原来 `--ink-2`
(#24322e) 与暗色卡片 `--topbar-line`(#2a2f31) 的对比度只有 **1.01**，悬浮根本看不出来；
`--topbar-hover` 也是 kkRepo 契约里唯一的「深底悬浮填充」，且与 Kite 默认暗色主题
「悬浮变亮」的用法一致。

## 5. 刻意不映射的 kkRepo token

照抄过来都是死变量（Kite 里没有消费方）：

| token | 值 | 不映射的原因 |
| --- | --- | --- |
| `--surface-muted` | `#f7faf9` | kkRepo 只给偶数行斑马纹（`--row-alt`）用，Kite 的表格不做斑马纹 |
| `--brand-tint-strong` | `#d4ebe4` | 按下态填充，Kite 没有 pressed token |
| `--accent-soft` | `#f8ede6` | 页面标题的暖色图标底，Kite 没有这个结构 |
| `--ink-4` | `#8b968f` | 占位符文字；Kite 统一走 `--muted-foreground` |
| `--success\|warning\|info` 的 `-bg`/`-line` | | Kite 只有 `--destructive` 一个语义色变量，状态色在组件里直接写 tailwind 色阶 |
| `--account-avatar-*` | 渐变 / `#51d29d` | 头像由 Kite 自己那套（`resolveAvatarSrc` + 首字母兜底）绘制 |
| `--focus` / `--focus-ring` | `rgba(15,124,111,.22)` | Kite 用 `--ring` + 组件的 `ring-ring/50` |
| `--topbar-selection` | 渐变 | 深色顶栏上「选中的工作区标签」；Kite 侧边栏选中项走 `--sidebar-primary` 实底 |
| `--r-*` / `--s-*` / `--fs-*` / `--fw-*` / `--lh-*` | | 圆角只映射了 `--r-md`→`--radius`；其余 Kite 用 tailwind 默认刻度 |

## 6. 实测（真机量计算样式）

`vite build` 到临时目录（不覆盖 `static/`），静态托管后在 Chromium 里渲染与真实原语同名的
class（含 `bg-muted` 的 `thead`、`[data-slot=table-head]`、`hover:bg-muted/50` 的行、以及一行
刻意不带底色的 `thead`），读 `getComputedStyle`：

| 项 | 浅色 | 暗色 |
| --- | --- | --- |
| 表头底色 | `rgb(238,243,241)` = `#eef3f1` ✅ | `rgb(36,50,46)` = `#24322e` |
| 无底色的表头 | 透明 ✅（未被规则误伤） | 透明 ✅ |
| 表头文字色 | `rgb(90,106,100)` = `#5a6a64` ✅ | `rgb(180,191,186)` = `#b4bfba` |
| 数据行悬浮 | `rgb(230,244,240)` = `#e6f4f0` ✅ | `rgba(255,255,255,0.09)` ✅ |
| 行详情悬浮 | 保持不变 ✅ | 保持不变 ✅ |
| 侧边栏选中底 / 字 | `rgb(47,191,164)` / `rgb(22,25,27)` ✅ | `#2fbfa4` / `#12211d` ✅ |

对比度：表头文字 / 表头带 **5.09**（暗色 7.07），表头带 / 白卡片 1.12（与 kkRepo 自身的
`--surface-sunken` 一致），行悬浮 / 白卡片 1.13，侧边栏选中字 / 选中底 7.66（暗色 7.22）。

单测 `vitest run` 313 项通过；`tsc --noEmit -p tsconfig.app.json` 通过（本次只动 CSS）。

## 7. 复现验证

```
cd ui && node_modules/.bin/vite build --outDir /tmp/kite-css-emerald --emptyOutDir
# 静态服务器需去掉产物里的 __KITE_BASE__ 前缀（由二进制在托管时替换）
# 把 html 的 class 置为 color-emerald / "dark color-emerald" 后量 [data-slot=...] 的计算样式
```

行悬浮的读取要 `waitForTimeout`：表格行带 `transition-colors`，hover 后立刻读会拿到过渡起点的
透明值（第一次跑就被这个骗过，误判成规则没生效）。
