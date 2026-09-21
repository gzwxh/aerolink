# 语义状态色 token 与硬编码色阶的替换

- 状态：**已完成**（实现与验证均已跑过，遗留项见 §7）
- 触发：`2026-09-21-theme-contrast-and-browser-baseline.md` §5 第 1 条——全仓 369 处
  Tailwind 色阶用具、48 个文件，其中 208 处没有 `dark:` 同族变体。这些颜色不跟随 7 套
  配色：切到墨绿 / 护眼 / Claude 之后，状态色仍然是 shadcn 的蓝绿黄红，暗色下的对比度
  也没人校过。
- 结论：补一组**语义状态色 token**（每套配色 × 浅/暗各一份），把状态类用具换过去；
  结构类 / 装饰类用具换成已有的中性 token。**不加第二套“装饰调色板”**。

## 1. 为什么不逐处补 `dark:` 变体

逐处补 `dark:` 只是把同一份色值抄两遍，而且仍然不跟随配色主题——`color-emerald` 下
“运行中”的绿还是 Tailwind 的绿。只有把颜色收进主题 token，才可能同时解决「跟随配色」
和「暗色对比度」两件事，并把契约交给测试。

## 2. token 设计

在每套配色的浅色块与 `.dark` 块各加 4 组（共 8 个变量）：

| token | 语义 | 消费形态 |
| --- | --- | --- |
| `--success` / `--success-foreground` | 正常 / 就绪 / 成功（Running、Ready、Available、Active） | `text-success`、`fill-success`、`bg-success`（状态点）、`bg-success/10` + `border-success/25`（软徽标）、`text-success-foreground`（实底上的字） |
| `--info` / `--info-foreground` | 进行中 / 中性告知（Pending、ContainerCreating、Progressing、Normal 事件） | 同上 |
| `--warning` / `--warning-foreground` | 需留意但未失败（Unknown、NotReady、Unschedulable） | 同上 |
| `--attention` / `--attention-foreground` | 过渡 / 销毁中（Terminating、Paused） | 同上 |
| `--destructive` / `--destructive-foreground` | 失败 / 错误 | 已有，本次不改取值 |

刻意**不**新增 `--success-bg` / `--success-line` 之类的三件套：软底与描边用 Tailwind 的
透明度修饰（`bg-success/10`、`border-success/25`）表达，与仓库既有的
`bg-primary/10`、`ring-destructive/20`、`border-primary/20` 写法一致，少 6 个变量。

`-foreground` 沿用 `--destructive-foreground` 的既有口径：浅色取白或近白，暗色取
`--background` 那类深墨色（这样实底徽标在两种模式下都过 AA）。

## 3. 取值口径

每个 token 的取值由约束反解（明度二分 + sRGB 截断，与 `theme-contrast.test.ts` 同一套模型）：

1. 作为**文字/图标**（`text-success`）压在 `--background`、`--card`、`--muted` 上，
   以及压在自己的 10% 软底（`bg-success/10` 叠在 `--card` 上）≥ AA 4.5；
2. `--*-foreground` 压在自己的实底上 ≥ AA 4.5；
3. 色相按各配色的家族取（默认品牌 235 / 中性 286，护眼暖色低彩度，notebook 低彩度，
   墨绿直接取 kkRepo 的 `--success`/`--warning`/`--info`/`--accent`）。

明度在满足约束的前提下取「离底色最远但不过分」的一端：浅色取仍能达标的最亮值
（保持饱和度观感），暗色取刚好达标的最暗值（不洗白）。

## 4. 用具映射表（替换规则）

### 4.1 状态色 → token

| 原用具（Tailwind 色阶） | 替换 |
| --- | --- |
| `text-green-600 dark:text-green-400`、`text-green-500/400/900`、`text-emerald-600/500/700` | `text-success` |
| `fill-green-500 dark:fill-green-400`、`fill-green-400`、`fill-emerald-*` | `fill-success` |
| `bg-green-500/600/400`、`bg-emerald-500`（状态点、实底徽标） | `bg-success`；徽标内文字配 `text-success-foreground` |
| `bg-green-50 dark:bg-green-950(/50)`、`bg-green-100 dark:bg-green-900` | `bg-success/10` |
| `border-green-200 dark:border-green-800`、`border-green-500/30`、`border-emerald-500/30` | `border-success/25` |
| blue / sky / cyan / indigo 同上各形态 | `info` |
| yellow / amber 同上各形态 | `warning` |
| orange 同上各形态 | `attention` |
| red / rose 同上各形态（含 `border-red-500`、`ring-red-500`、`text-red-*`、`fill-red-*`） | `destructive` |
| `bg-yellow-500/5 border-yellow-500/30`（待确认动作块） | `bg-warning/5 border-warning/25` |
| `bg-yellow-100 text-yellow-800 border-yellow-300`（监控页告警条） | `bg-warning/10 text-warning border-warning/25` |

### 4.2 中性色 → 已有 token

| 原用具 | 替换 |
| --- | --- |
| `text-gray-500/600/700`、`text-slate-*`、`text-zinc-*` | `text-muted-foreground` |
| `text-gray-400`（未开始的步骤、次级说明） | `text-muted-foreground` |
| `text-gray-800/900` | `text-foreground` |
| `bg-gray-50/100/200`、`bg-slate-*` | `bg-muted` |
| `border-gray-300`（表单/按钮描边） | `border-input` |
| `border-gray-200`（分隔线、卡片描边） | `border-border` |
| `hover:bg-gray-100`、`hover:text-gray-700` | `hover:bg-accent`、`hover:text-foreground` |
| `border-t-blue-600` + `border-gray-300`（loading 圈） | `border-border` + `border-t-primary` |
| `bg-muted-foreground dark:bg-gray-400` | `bg-muted-foreground` |
| `bg-white/90 text-gray-600 border-gray-200` 等（日志查看器的浮层与主题配套 chrome） | **不动**（见 §4.4） |

### 4.3 装饰/分类色的处置（本节有可见视觉变化，需评审）

这些用色不表达状态，是作者用来区分「类别」的。逐点决定：

| 位置 | 原色 | 处置 | 理由 |
| --- | --- | --- | --- |
| `cluster-stats-cards.tsx` 四张卡 | 蓝 / 绿 / 紫 / 橙 | `info` / `success` / `warning` / `attention` | 保留四色区分（概览页的可扫读性依赖它），且四色都是主题 token |
| `settings/cluster-management.tsx` 徽标 | Cluster Agent=紫、In-Cluster=蓝、External=灰 | `success` / `info` / `muted` | 三个并列徽标必须互相可辨；「Agent 接入」用正色是合理语义 |
| `deployment-status-icon.tsx` `Paused` | 紫 | `warning` | 与同文件的 `Terminating`(attention)、`Unknown`(destructive) 区分开 |
| `container-table.tsx` 段落标题（Requests / Limits / EnvFrom…） | 绿 / 红 / 紫 | `text-muted-foreground` | 标题是结构不是状态；同卡片里已经有一堆颜色，收敛掉 |
| `container-table.tsx` 内联值（env 名、`(from secret)`） | 蓝 / 橙 | `info` / `attention` | 与值的语法高亮性质一致，保留 |
| `types/themes.ts` 日志/终端主题 | 各色 | **不动** | 独立子系统：它描述的是「终端配色方案」本身，不是界面配色 |

### 4.4 不动的部分

- `types/themes.ts`（日志/终端主题定义）与 `log-viewer-content.tsx` 里与日志主题配套的
  浮层 chrome：它们跟随的是用户选的**终端主题**，不是界面配色，换掉会让「GitHub Light
  日志主题」这类功能失真。
- `initialization.tsx` 的向导步骤色会替换（步骤态 = 状态），但它同时是登录前的页面，
  只走 token 不涉及配色切换之外的行为。

## 5. 落地步骤

1. `ui/src/styles/base.css`：`@theme inline` 里补 8 个 `--color-*` 映射（漏了就是死类，
   与 `--destructive-foreground` 同一个坑）。
2. 7 套主题各补 8 个变量（浅色块 + `.dark` 块）。
3. `theme-contrast.test.ts` 扩四组断言：16 个新 token 的存在性、状态色作文字/图标的
   四类底色、`-foreground` 压实底、软底（10%）与软描边（25%）的可辨识度。
4. 按 §4 的表替换 48 个文件里的用具。
5. 验证：`vitest`（含新断言）、`tsc`、`eslint`、`prettier`、`vite build` 后确认新工具类
   都在产物里（`bg-success\/10`、`text-attention` 等）。

## 6. 实测结果

- 硬编码色阶用具：**369 处 / 48 文件 → 39 处 / 2 文件**（`types/themes.ts` 29 处 + 
  `log-viewer-content.tsx` 4 行 10 处，两者都是 §4.4 里刻意保留的终端/日志主题子系统）。
- 新增工具类的实际使用量：success 56 处、info 47 处、warning 48 处、attention 9 处，
  配对的 `dark:` 变体一并删掉了（新 token 自己会随模式变）。
- `theme-contrast.test.ts`：43 → **65 例**（新增 4 组状态色断言 × 14 个模式块组合）。
- `vitest run`：378 例全通过；`tsc --noEmit -p tsconfig.app.json` 与 `eslint`（改动文件）均通过。
- `vite build` 产物里确认生成了 `bg-success/10`、`text-attention`、`border-warning/25`、
  `fill-muted-foreground`、`text-success-foreground`、`border-t-primary`、`file:text-info` 等。

## 6.1 迁移中顺带修掉的同类缺陷

替换过程中发现下面的颜色也属于「同一类缺陷」，一并改了（都很小，但都属“颜色不跟主题/不达 AA”）：

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| `ui/components/ui/button.tsx`、`badge.tsx` 的 destructive 变体 | `bg-destructive text-white` + `dark:bg-destructive/60`：暗色下 `--destructive` 是亮红，白字只有 2.77:1；再叠 60% 透明后只剩 **2.7~4.4:1**（7 套里 6 套不达 AA） | 改用 `text-destructive-foreground`，并去掉 `dark:bg-destructive/60`（改后 5.5~10.3:1）。这是本次唯一两处改动 shadcn 原语的地方。 |
| `notification-bell.tsx` 未读数徽标 | 同上：`bg-destructive … text-white` | `text-destructive-foreground` |
| `settings/user-management.tsx` 头像兑底 | `bg-muted-foreground text-white`：暗色下白字压亮灰只有 ~1.9:1 | `text-background` |
| `base.css` 的 `.breathing-indicator` 光晕 | `box-shadow` 写死 `rgba(74,222,128,…)` 绿色：连接指示灯的**红点（未连接）也盾绿色光晕** | 光晕色改走 `--glow`（默认 `--success`），红点的 `connection-indicator.tsx` 传 `[--glow:var(--destructive)]` |
| `namespace-detail-page.tsx` 的 `PHASE_STYLES` | `border-l-green-500` 等 4 个阶段色（首轮清单漏了 `border-l-*` 前缀） | `border-l-success` / `-info` / `-warning` / `-destructive` |
| `ui/components/ui/sonner.tsx` | toast 四种状态的图标色写死色阶 | 改 `!text-destructive` / `!text-success` / `!text-warning` / `!text-info` |
| `settings-hint.tsx` 图标底 | `bg-green-100` 与卡片底 `bg-green-50` 都归到 `bg-success/10`，两者叠成一样，层次消失 | 图标底用 `bg-success/20` |
| `initialization.tsx` 步骤按钮未选中态 | `bg-gray-100 … hover:bg-gray-200` 都归到 `bg-muted`，hover 失去反馈 | `hover:bg-accent` |

## 7. 遗留与已知取舍

1. **两处刻意的语义拉伸**（保留了原有视觉区分，代价是 token 名与用途不完美对应）：
   - `pod-status-icon.tsx` 把 `Succeeded`/`Completed` 归到 `info`（蓝），与 `Running`（`success`）区分。按 §4.1 的“蓝→info”规则是自洽的，但“已完成”在语义上更接近 success。
   - `resources-charts.tsx` 的 Limits 柱状图用 `bg-attention`（橙色系列色）。
   两条都建议将来要么改成 `success` / `chart-*`，要么给图表系列单独定义 token。
2. **daemonset-overview 的 switch 缺分支**：`Pending`/`Unknown` 落到 `default`，因此是灰色而不是 info/warning。属既有逻辑缺口，未动。
3. **`cluster-badge.tsx` 的 `text-white` 未动**：底色是集群配置里的用户自填十六进制，白字在浅色自选色上会不可读；需要单独的处理口径（例如按亮度选前景色）。
4. **日志/终端子系统不动**（`types/themes.ts`、`log-viewer-content.tsx` 里与日志主题配套的浮层 chrome、`terminal-content.tsx` 的 xterm theme 对象）：它们跟随的是用户选的**终端主题**，不是界面配色。
5. **图表系列色**：`--chart-*` 是唯一没有随本次收敛的语义色族（各主题取值差异较大，且作为图形填充需按 WCAG 1.4.11 的 3:1 单独校）。
6. **仓库既有 prettier 漂移**：`cluster-badge.test.tsx`、`cluster-badge-dialog.tsx`、`cluster-icon-upload.ts`、`square-image.ts` 与本次改动无关但 prettier 不干净（`git diff` 对 HEAD 无差异），按 AGENTS.md 未顺手格式化。

## 8. 复现验证

```
cd ui && node_modules/.bin/vitest run src/styles/themes/theme-contrast.test.ts
cd ui && node_modules/.bin/tsc --noEmit -p tsconfig.app.json
cd ui && node_modules/.bin/vite build --outDir /tmp/kite-css-check --emptyOutDir
grep -o 'bg-success\\/10' /tmp/kite-css-check/assets/*.css | head -1
```
