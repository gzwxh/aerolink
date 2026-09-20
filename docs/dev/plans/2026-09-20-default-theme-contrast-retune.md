# 默认配色主题的对比度与填充层次调整

- 状态：**已完成**
- 触发：用户反馈「部分字体颜色和背景」需要调整，并给了 kkRepo
  （`github.com/klboke/kkRepo`，Apache-2.0）的 `admin-ui` 产物路径作参考。
- 结论：只调 `ui/src/styles/themes/default.css` 里的语义 token 取值，不动任何组件、
  不动 shadcn 原语（`ui/src/components/ui/**`）、不改品牌色相。

## 参考对象是什么

kkRepo 的 `admin.css` 首行注释写明「Theme tokens come from the selected shared CSS
template linked before this file」，即 admin 控制台、browse UI、登录弹窗三处共用同一套
token 契约（`browse-ui/.../browse/assets/themes/default.css`）；`admin.css` 里
`body { background: #ffffff; color: var(--text) }`，`--text` 就是该契约的 `--ink-2`。
所以直接对照的标的物是那份 token 契约，而不是打包产物本身。

它值得抄的不是具体色值（墨绿 `#0e7c6f` 那套已经由 `themes/emerald.css` 承担了），而是
**三个分层口径**：

1. 文字分三层：`ink-1` 标题 / `ink-2` 正文 / `ink-3` 次要（`#5a6a64`，约 5.7:1），
   另有 `ink-4` 占位符。Kite 只有 `--foreground` + `--muted-foreground` 两层，够用，
   但次要那层原来只有 4.83:1。
2. 填充分三层：`surface`（白）/ `surface-muted`（斑马行）/ `surface-sunken`（表头、
   chip）；hover 另用 `brand-tint`（品牌浅色底）而不是灰色。
3. 描边分两层：`line`（分隔线）与 `line-strong`（表单控件边界）。Kite 原来
   `--border` 与 `--input` 是同一个值，输入框边框几乎看不见。

## 改了什么

取值按上面的口径重新落在 Kite 自己的色相家族上（中性 286、品牌 235），不是照搬色值。

| token | 改前 | 改后 | 依据 |
| --- | --- | --- | --- |
| `--foreground` 等 | `oklch(0.141 0.005 285.823)` | `oklch(0.235 0.007 286)` | 19.9:1 偏硬，降到 16.6:1，接近 kkRepo `ink-2` 的 13.4:1 手感 |
| `--muted-foreground` | `oklch(0.552 0.016 285.938)` | `oklch(0.51 0.013 286)` | 4.83:1 → 5.78:1。全仓 816 处引用，是本次影响面最大的一项 |
| `--primary` / `--ring` / `--sidebar-primary` / `--sidebar-ring` | `oklch(0.55 0.22 235)` | `oklch(0.52 0.21 235)` | 白字压在按钮上 4.03:1 → 4.63:1，过 WCAG AA 4.5 |
| `--secondary` / `--muted` | `oklch(0.967 0.001 286.375)` | `oklch(0.957 0.003 286)` | 沉底填充（表头、斑马行、二级按钮）略沉，与白卡片分层 |
| `--accent` + `--accent-foreground` | 灰 `0.967` + 深灰 `0.21` | 品牌浅蓝 `oklch(0.962 0.013 241)` + `oklch(0.42 0.13 235)` | hover / 选中改带品牌色（kkRepo 的 `brand-tint` 口径）；原来 250,250,250 的白底上几乎看不出来 |
| `--border` | `oklch(0.92 0.004 286.32)` | `oklch(0.905 0.005 286)` | 分隔线略实 |
| `--input` | 与 `--border` 同值 | `oklch(0.865 0.008 286)` | 拆出第二层描边，输入框边界可见 |
| `--sidebar` | `oklch(0.985 0 0)` | `oklch(0.983 0.003 286)` | 侧边栏与内容区微微分层 |
| 暗色 `--muted-foreground` | `oklch(0.705 0.015 286.067)` | `oklch(0.745 0.013 286)` | 7.59:1 → 8.73:1 |
| 暗色 `--accent` | 灰 `0.274` | `oklch(0.269 0.045 246.6)` | 与浅色同一口径，hover 带品牌色 |
| 暗色 `--border` / `--input` | `10%` / `15%` 白 | `14%` / `18%` 白 | 描边同样分两层 |

刻意不动的部分：

- **品牌色相**：`--primary` 仍是蓝色（235），没有换成 kkRepo 的墨绿。若要整体换品牌
  色相，那是另一个决定，墨绿已由 `emerald.css` 作为可选主题提供。
- **`--background` 保持纯白**：kkRepo 默认皮肤的 `--canvas` 也是 `#ffffff`，且
  `bg-background` 在仓库里有 38 处引用（含输入框、面板底），改它牵连面大。分层靠
  `--muted` / `--accent` / `--sidebar` 的微差表达。
- **`--sidebar-accent` 保持中性灰**：侧边栏选中项用的是 `bg-primary/10`
  （`app-sidebar.tsx`），若 hover 也用品牌浅蓝，hover 与选中会撞色。保持「hover 灰 /
  选中蓝」。
- 其余 5 套主题（`claude` / `clean-slate` / `darkmatter` / `notebook` / `eye-care`）
  未动。`emerald.css` 是仓库里未跟踪的他人 WIP，本次既未修改也未纳入提交。

## 实测对照

`default.css` 只含 CSS 变量，没有可断言的数据结构，所以验证方式是**真机量计算样式**：
把 `vite build` 产到临时目录（不覆盖 `static/`），用一次性静态服务托管，在 Chromium 里
渲染与真实组件同名的 class（`bg-muted` 表头、`border-input` 输入框、`bg-accent` 选中项、
`hover:bg-muted/50` 表格行等），读 `getComputedStyle` 再算对比度。同一套脚本分别跑
HEAD 与改动后的构建产物，得到下表：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 正文文字 / 页面底 | 19.90 | 16.63 |
| 次要文字 / 页面底 | 4.83 | **5.78** |
| 次要文字 / 沉底填充 | 4.39 | **5.08** |
| 表头文字 / 表头底 | 18.10 | 14.62 |
| 选中项文字 / 选中底 | 16.12 | 7.09 |
| 主按钮文字 / 主按钮底 | **4.03** | **4.63** |
| 输入框边框 / 页面底 | 1.269 | **1.505** |
| 卡片描边 / 页面底 | 1.269 | 1.329 |
| 行悬浮底色 | `250,250,250` | `248,248,249` |
| 侧边栏 hover / 侧边栏底 | 1.053 | 1.082 |
| 侧边栏选中 / 侧边栏底 | 1.136 | 1.144 |

暗色：次要文字 7.59 → 8.73（叠卡片 6.75 → 7.77，叠沉底填充 5.68 → 6.54），卡片描边
1.246 → 1.416，输入框边框 1.466 → 1.632。

注意「表头文字 / 表头底」与「选中项文字 / 选中底」两个数字是下降的：前者是 18.1 降到
14.6（仍然远超 AA），正是「不要那么刺眼」那一项的效果；后者是从深灰字压灰底换成蓝字压
品牌浅底，属于换色而非退化。

## 复现验证

```
# 1. 构建（不要用默认 outDir，避免覆盖 static/）
cd ui && node_modules/.bin/vite build --outDir /tmp/kite-css-check --emptyOutDir
# 2. 静态托管 + Chromium 量测脚本按上面口径跑一遍
#    （脚本里要处理 __KITE_BASE__ 前缀：产物 index.html 里的资源路径带该占位符，
#      由二进制在托管时替换，静态服务器需要自行去掉它）
```

只改这一个文件，不重新生成 `static/`——仓库惯例是 `static/` 由 `make frontend`/`make build`
单独产出，UI 提交里不带它。
