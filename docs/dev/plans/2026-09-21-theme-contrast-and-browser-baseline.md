# 配色主题的 P0 修复、对比度回归测试与浏览器基线登记

- 状态：**已完成**
- 触发：用户要求评估「配色方案还能不能优化 + 多浏览器兼容性」，随后指定做三件事：
  P0 修正、对比度回归测试、登记浏览器基线。
- 结论：7 套配色里只有 `default` 在上一轮校过对比度，其余 6 套仍是模板原值。本次把
  各主题的语义 token 按同一套口径复核并修正，把口径落成静态测试，并显式登记前端
  浏览器基线。只动 `ui/src/styles/**`、`ui/vite.config.ts`、本方案与索引/规则文档。

## 1. 量法与口径

`src/styles/themes/*.css` 只有 CSS 变量，没有可断言的数据结构，所以先把上一轮
`plans/2026-09-20-default-theme-contrast-retune.md` 的「真机量计算样式」口径做成
**纯静态计算**：读 CSS 变量 → `culori` 转 sRGB → 算 WCAG 对比度。

两个必要的细节：

1. **超出 sRGB 色域要截断**。`oklch(0.577 0.245 27.325)`（默认主题的 `--destructive`）
   转换后有个负分量，不截断会算出偏高的对比度：同一个红对暖白字，截断后是 4.45（不达标），
   不截断会算成 4.64（看起来达标）。测试与本次所有取值都按截断模型计算，阈值另留余量。
2. **半透明 token 要先合成**。`emerald` 暗色的 `--sidebar-accent` 是
   `rgba(255,255,255,.09)`，各暗色主题的 `--border` / `--input` 是按百分比的白色，
   都要先叠到所在表面（侧边栏 / 卡片）上再算。

## 2. P0：修掉的缺陷（按类）

| 类别 | 位置 | 问题 |
| --- | --- | --- |
| 死工具类 | `base.css` 的 `@theme inline` 少 `--color-destructive-foreground` | 组件里 3 处 `hover:text-destructive-foreground`（AI 面板、历史面板、浮动终端）在 Tailwind v4 下不生成规则；红底上的字仍是 `--foreground` 深灰（浅色 3.50:1、暗色 2.77:1）。`default` / `eye-care` 也从未定义该 token。 |
| 语义 token 取错值 | `claude` 浅色 `--destructive: rgb(20,20,19)` | 近黑，错误提示与危险按钮都不显红。换成同族深红 `rgb(220, 38, 38)`。 |
| 同上 | `darkmatter` 暗色 `--destructive` 等于它的 `--secondary`（青色） | 危险色变成青色。换成中性色阶里同位置的暗色红（与 default/eye-care 暗色同值）。 |
| 暗色没跟着回退 | `claude` 暗色 `--sidebar-border: rgb(235,235,235)`、`--sidebar-ring: rgb(181,181,181)`、`--secondary: rgb(250,249,245)` | 亮灰描边压在近黑侧边栏上 13.96:1，像一条白线；`--secondary` 暗色下变成白块（与卡片 14.39:1）。描边回落到本配色的暗色描边值，`--secondary` 换成暗色填充 + 亮字。 |
| 反相的选中填充 | `notebook` 暗色 `--accent` / `--sidebar-accent: oklch(0.9067 0 0)` | 照搬了浅色的近白值，而 `--accent` 是 shadcn 原语的 hover / 选中填充，暗色下菜单一悬停就闪白底；`--accent-foreground` 又等于卡片色，字与底同亮。改成深一档填充 + 亮字。 |
| 描边同色（看不见） | `emerald` 暗色 `--card`/`--border`/`--input` 都是 `#2a2f31`；`notebook` 浅色 `--input` 是纯白（=卡片）、暗色 `--input` = `--card` | 卡片描写与表单边界 1.00:1，输入框看不出边界。 |
| 描边过重 | `notebook` 浅色 `--border: oklch(0.5538 …)` | 分隔线对白卡片 4.78:1（其余 6 套 1.2~2.0），比分隔线该有的权重重得多。 |
| 对比度不到 AA | 见下表 | 主按钮白字、说明文字压沉底填充、错误提示色三类。 |
| 首帧跳字号 | `base.css` 的 `html { font-size: var(--app-display-scale) }` | 变量由 `display-scale-provider` 在 mount 后才写入，没有兜底值时整条声明失效，首帧按 16px 排一遍再跳到 95%。补 `var(--app-display-scale, 95%)`。 |

对比度修正（全部按 AA 4.5 目标重取，只调明度、不动色相）：

| 主题 | token | 改前 | 改后 |
| --- | --- | --- | --- |
| eye-care 浅 | `--primary` / `--ring` / `--sidebar-primary` / `--sidebar-ring` | `0.55` | `0.53` |
| eye-care 浅 | `--destructive` | `0.577` | `0.539` |
| clean-slate 浅 | `--primary` 系 | `0.5854` | `0.568` |
| clean-slate 浅 | `--destructive` | `0.6368` | `0.577` |
| clean-slate 浅 | `--muted-foreground` | `0.551` | `0.535` |
| clean-slate 暗 | `--destructive` | `0.6368` | `0.68` |
| darkmatter 浅 | `--destructive` | `0.6368` | `0.575` |
| darkmatter 浅 | `--muted-foreground` | `0.551` | `0.535` |
| darkmatter 浅 | `--primary-foreground` / `--sidebar-primary-foreground` | 白 | 本主题的深墨色（橙底压白字只有 3.12:1） |
| darkmatter 暗 | `--muted-foreground` | `0.6268` | `0.635` |
| notebook 浅 | `--destructive` | `0.6627` | `0.562` |
| notebook 暗 | `--muted-foreground` | `0.7058` | `0.77` |
| notebook 暗 | `--secondary-foreground` | `0.8078` | `0.8945` |
| claude 浅 | `--primary` / `--ring` / `--sidebar-primary` / `--sidebar-ring` | `rgb(201,100,66)` | `rgb(187,87,54)` |
| claude 浅 | `--muted-foreground` | `rgb(131,130,125)` | `rgb(105,104,99)` |
| claude 暗 | `--primary-foreground` / `--sidebar-primary-foreground` | 白 | `rgb(38,38,36)`（保留亮赤陶色，压深字） |
| claude 暗 | `--destructive` | `rgb(239,68,68)` | `rgb(248,113,113)` |

`--destructive-foreground` 的取值口径按仓库已有的暗色惯例（`darkmatter` / `clean-slate` /
`notebook` 暗色都取 `--background` 那类深墨色）：浅色主题取白或近白，暗色主题取深墨色。

### 2.1 偏离既有约定的一处

`emerald.css` 的注释写明暗色 token「不引入 kkRepo 之外的色值」，但 kkRepo 的暗色系里
**没有任何用作描边的色值**——原先拿 `--topbar-line` 同时当卡片、描边、输入框边界，三者
同色。这里改用本仓其余 6 套暗色主题一致的半透明白描边（`--border` 14% / `--input` 22%），
并在文件头注明了这个例外。

## 3. 测试

`ui/src/styles/themes/theme-contrast.test.ts`（43 个用例，纯 node + `culori`，不需要浏览器）：

1. `base.css` 必须把 `--destructive-foreground` 映射进 `@theme`（漏了就是死类）。
2. 每套配色的浅/暗都必须定义 `--destructive-foreground`。
3. 13 组文字类 token 对（正文、说明文字、按钮、选中态、侧边栏、错误提示、危险底）都要 ≥ AA 4.5。
4. 描边两层：`--border` 与卡片底的对比度落在 1.1~2.6，`--input` 落在 1.3~3.2，且
   `--input` 必须比 `--border` 更实。区间同时挡住「与卡片同色看不见」和「比表单边界还重」。

反向验证：把 `notebook` 暗色 `--input` 改回 `0.3211`、把 `base.css` 的映射删掉，
测试分别以「--input 与卡片底的对比度 1.00 不在 1.3~3.2」与「expected … to match」失败。

## 4. 浏览器基线登记

基线：**Chrome / Edge 111、Firefox 128、Safari / iOS 16.4**。

依据（都是读依赖源码/产物得到的，不是估的）：

- 产物 CSS 含 `oklch()` 393 处、`color-mix()` 180 处、`@property` 89 处（Tailwind 给
  `--tw-*` 注册的属性）、`:has()` 9 处、`@container` 39 处。`oklch` / `color-mix` 的下限是
  Chrome 111 / Safari 16.4 / Firefox 113，`@property` 把 Firefox 抬到 128。
- `:has()` 落在承载布局的地方（`ui/components/ui/sidebar.tsx` 的折叠宽度、
  `card.tsx` 的 `has-data-[variant=inset]`、`table.tsx` 的首列内边距），Firefox 要 121，
  低于它的表现是布局错位而不是样式细节。
- Vite 8.2.2 的默认 `build.target` 是 `'baseline-widely-available'`，源码里等于
  `chrome111 / edge111 / firefox114 / safari16.4 / ios16.4`——**firefox114 是低估**，所以
  `ui/vite.config.ts` 改成显式声明，并在注释里写明依据。
- Tailwind v4 不读 `browserslist`（在 `node_modules/tailwindcss` / `@tailwindcss/vite`
  里搜不到该字段），前缀由它自带的 Lightning CSS 按固定口径产出（产物里确实有
  `-webkit-backdrop-filter` 等），所以**没有**加 `browserslist` 字段——那是死配置。

登记位置：`ui/vite.config.ts`（机器可读的那份）、`AGENTS.md`「界面（UI）」（规则）、
`docs/dev/feature-code-index.md`（导航）。

## 5. 本次未做（留给后续决定）

1. **硬编码色阶用具**：全仓 369 处、48 个文件，其中 208 处没有 `dark:` 同族变体
   （`initialization.tsx` 51、`types/themes.ts` 29、`container-table.tsx` 24 …）。它们不跟随
   7 套配色。正解是补一组语义状态 token（success/warning/info 及 `-bg`/`-line`）再替换，
   改动面跨 40+ 组件，需要单独一轮。
2. **`emerald` 暗色的 `--accent` 仍等于 `--card`**，hover / 选中填充看不出变化；同类问题在
   其浅色侧不存在。改它要引入 kkRepo 之外的色值，建议与第 1 条一起定。
3. **`--secondary` 与卡片的分离度**：`emerald` 文档里已记为遗留项（暗色徽标只剩文字），
   本次沿用其结论未动。
4. **`color-scheme` / `prefers-reduced-motion` 全仓缺位**：前者影响暗色下的原生滚动条与
   表单控件（Firefox 尤其明显），后者影响 `breathing-indicator`、`ai-thinking-dots`、
   `animate-spin` 等动画。都与配色相邻但独立，未纳入本次。
5. **e2e 只有 chromium 一个 project**（`e2e/playwright.config.ts`），跨浏览器回归没有覆盖；
   `:has()` 这类问题正好是 webkit/firefox 才暴露的类型。
6. 图表侧的两处硬编码（`chart/disk-io-usage-chart.tsx`、`chart/network-usage-chart.tsx`
   的 `oklch(...)` 与 `stroke="#666"`）与 `lib/monaco-theme.ts` 写死的
   `#18181b` / `#ffffff` 不跟随配色。

## 6. 复现验证

```
# 对比度契约（不需要浏览器）
cd ui && node_modules/.bin/vitest run src/styles/themes/theme-contrast.test.ts

# 前端类型
cd ui && node_modules/.bin/tsc --noEmit -p tsconfig.app.json

# 端到端确认 @theme 映射真的生成了工具类（构建到临时目录，不动 static/）
cd ui && node_modules/.bin/vite build --outDir /tmp/kite-css-check --emptyOutDir
grep -c 'text-destructive-foreground' /tmp/kite-css-check/assets/*.css
```
