# AGENTS.md

Kite 是单二进制的 Kubernetes 控制台：Go 后端、`ui/` 下的 React/Vite 前端，前端
产物从 `static/` 嵌入到二进制里。

本仓库是上游 [kite-org/kite](https://github.com/kite-org/kite)（Apache-2.0）的
**公司内部二开分支**：只在公司内网部署，不对外分发。下面的约定按这个前提裁剪——
只服务于「对外发布 / 开源协作」的流程尽量不作要求，但安全边界、数据一致性与
许可证合规的部分不放宽。

## 范围（Scope）

- 只做被要求的、或明确必要的改动。改动保持局部；不要顺手重构、加功能，也不要写
  投机性的抽象。
- 安全边界、数据一致性与脱敏相关的显式校验（fail-closed、越权判定、错误显式返回）
  属于「明确必要」，不算投机兜底，该加就加。
- 修缺陷或改变既有行为时，补一条聚焦的回归测试（覆盖该行为、跑得起来即可）。不要
  写与本次改动无关的测试，也不要为了覆盖率凑测试。
- 让代码自己解释自己。只有需要说明不显然的意图或约束时才写注释，并保持简短。

## 命令与验证（Commands and verification）

- 本地开发：`make dev`；完整构建：`make build`。
- Go：对受影响的包跑既有测试，例如 `go test ./pkg/resources`。
- 前端：`pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json`。`ui/vite.config.ts`
  用 `tsconfig.node.json`。`type-check` 脚本指向的根配置里没有源文件，所以请用上面
  这两条显式命令。
- 提交前跑 `make pre-commit`（它格式化并 lint 整个仓库）。仓库基线未必全绿，它可能
  报出与本次改动无关的既有告警：只处理你改到的部分，其余列出来报给用户决定，不要
  顺手扩大改动范围。若它自动改写了你并未碰过的文件，检查后回退。

其它命令见 `Makefile` 与 `ui/package.json`。挑选与本次改动相关的检查，跑过即止。
只改文档时，复核 diff 及其中引用的路径或命令，跳过应用测试与构建。

## 项目约定（Project conventions）

- 复用既有的 Kubernetes 资源处理器与客户端。保持集群作用域、命名空间作用域与 `_all`
  行为不变，包括既有的鉴权、RBAC 与 AI 工具授权路径。
- 新增或重命名资源面时，同步 `pkg/common/resource.go`、`pkg/resources/handler.go`、
  `ui/src/lib/resource-catalog.ts`，以及相关路由/页面/组件。
- 需要持久化的敏感值一律用 `model.SecretString` 存储；任何情况下都不要把密钥写进日志。
- 改动运行时环境变量时，同时检查 `pkg/common/common.go` 与 `charts/kite` 下对应的
  values/模板。由 `internal/config.go` 管理的设置在界面上必须保持只读。
- 提交信息用中文描述，但保留 Conventional Commits 的英文类型前缀（`feat` / `fix` /
  `chore`…）：`scripts/changelog.sh` 按前缀分类，写成中文前缀会全部落到「未分类」。
  例：`feat(ui): 给 ValueRows 加显示/隐藏切换`。

## 许可与归属（Licensing and attribution）

- 绝不把 AGPL / SSPL 等强传染性许可证的代码或组件文件复制进本仓库（与 Apache-2.0
  不兼容）。这条不放宽：混进来之后，将来任何一次对外交付都会变成许可证问题。
- 新增第三方素材（图片、字体、图标）：纯内网自用不必走 `NOTICE` 流程，但须在提交
  信息里写明来源与许可证；一旦要对外交付（客户环境、公司外镜像仓库），必须在同一
  次改动里登记到 `NOTICE`。
- 对 `LICENSE`、`NOTICE`、`licenses/*` 的修改需要显式评审，不得顺手改动。

## 界面（UI）

- 界面保持简单，并与既有的视觉与交互模式一致。
- 复用既有组件；可复用的功能组件放在 `ui/src/components` 下。
- `ui/src/components/ui` 是 shadcn 管理的原语；只有原语本身必须改时才动它。
- 用户可见文案一律走 i18n，不要硬编码英文。本项目面向内网中文用户：`ui/src/i18n/
  locales/zh.json` 是唯一事实来源，必须完整（`t()` 引用的键都要在）；`en.json` 是
  可选翻译，允许滞后、缺失时回落中文。不要出现「两种语言都没有、只靠 `defaultValue`
  兜底」的键——中文界面会因此显示英文原文。
- 承载可编辑草稿的弹窗，遮罩 / Esc / 关闭按钮这三条关闭路径必须统一走
  `useUnsavedChangesGuard`（`ui/src/hooks/use-unsaved-changes-guard.ts`），并在旁边
  渲染 `UnsavedChangesConfirmDialog`，避免关闭时静默丢弃已填内容。
  `ui/src/components/ui/dialog.tsx` 里的原语要保持对此无感知。
- 前端浏览器基线：**Chrome / Edge 111、Firefox 128、Safari / iOS 16.4**（依据与登记位置见
  `ui/vite.config.ts` 的 `build.target` 注释，改动沿革见 `docs/dev/plans/2026-09-21-
  theme-contrast-and-browser-baseline.md`）。低于基线的浏览器不保证效果，相关兼容问题不
  当作缺陷；新引入的 CSS/JS 特性落在基线内即可，不必为更旧的浏览器加兜底。
- 配色主题（`ui/src/styles/themes/*.css`）只改语义 token：文字类 token 之间的对比度要过
  AA 4.5，描边保持「`--border` 是分隔线、`--input` 是表单边界且更实」的两层口径。这两条
  由 `ui/src/styles/themes/theme-contrast.test.ts` 断言，改色后先跑它。
- 状态色一律用语义 token（`success` / `info` / `warning` / `attention` / `destructive`
  及其 `-foreground`）与中性 token，不要再写 Tailwind 色阶用具（`text-green-600`、
  `bg-blue-50 dark:bg-blue-950/50` 这类）——它们不跟随配色主题，也躲过对比度断言。
  软底/软描边用透明度修饰表达（`bg-success/10`、`border-success/25`），
  语义与取值口径见 `docs/dev/plans/2026-09-21-semantic-status-color-tokens.md`。
  例外：日志/终端主题（`ui/src/types/themes.ts`、`log-viewer-content.tsx` 的浮层 chrome）
  跟随的是用户选的终端主题，不改。

## 生成文件（Generated files）

- 不要手工编辑 `static/`、`aerolink`、`bin/` 或依赖/缓存目录。前端产物用 `make frontend`
  重新生成。
- 只有在依赖确实变化时才改 `go.sum`、`ui/pnpm-lock.yaml`、`e2e/pnpm-lock.yaml`。

## 文档（Docs）

- 工程与开发文档的正文用中文（`README_en.md`、`docs/en/**` 是刻意保留的英文版，不在其列）；
  代码块、命令、路径与标识符保持原样。
- 本文件放的是**规则**；`docs/dev/feature-code-index.md` 负责「功能 → 文件」的
  **导航**（核心入口、前后端共用约定、分功能索引、how-to 清单）。新增或迁移功能面时
  同步更新它。
- 非平凡改动（新功能面、跨前后端改动、涉及授权或数据模型的取舍）先写方案到
  `docs/dev/plans/YYYY-MM-DD-<topic>.md`；小修和缺陷修复不必写方案文档。
- `docs/dev/**` 仅供工程使用，不进入发布的文档站（`docs/.vitepress/config.mts` →
  `srcExclude`）。
