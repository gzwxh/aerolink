# 方案：发布自动化与归属/许可证

- 对应总览报告中的第 **8** 项（P0 清单）
- 状态：**基本实现**（2026-09-18）：阶段 1（A1-a）、2、3、4、5、6 均已完成；仅 **A3 的版本号规则**待决策
- 实现记录：
  - A1-a：`release.yaml` 的门禁由 `github.repository_owner == 'kite-org'` 改为 `vars.RELEASE_ENABLED == 'true'`；镜像目标改为 `vars.IMAGE_REPOSITORY`（默认 `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink`，与 charts 一致），registry host 由首段推导，登录步骤按 ghcr.io / Docker Hub / 其他 registry 条件执行；chart 的 OCI 目标为 `vars.CHART_OCI_REPOSITORY`（空则跳过）；gh-pages index 作业单独用 `vars.HELM_INDEX_ENABLED` 开关；CI 构建用 `make cross-compile VERSION=<tag>` 保证产物版本与 tag 一致，Release 正文改用 `scripts/changelog.sh` 的分类产物。`deploy-demo.yml` 仍属上游专用，保留门禁并在文件头注明
  - A2 改用 `scripts/changelog.sh`（只用 git + sh，不依赖 `git-cliff`，内网可直接跑）+ `make changelog` + 生成的 `CHANGELOG.md`；若以后要用 git-cliff，把它换成 `cliff.toml` 即可
  - A3/A4：新增 `docs/dev/release-checklist.md`（含 CI 变量表）；`scripts/release.sh` 去掉 `set -x`、参数化 `CHART_DIR` / `TAG_PREFIX`、增加“工作区必须干净”前置检查；`.gitignore` 增加 `charts/*.tgz`
  - B1/B2：新增 `NOTICE`（不可核实的条目一律标 `待确认`，不作推测）与 `licenses/Apache-2.0.txt`（与 `LICENSE` 字节一致）；`README.md` / `README_en.md` 增加归属段并互相链接
  - B3：`ui/src/assets/login-banner.svg` 已重画为自研素材（900×320、同一 `bg-cover bg-right-bottom` 构图契约），并在画面右侧加入公司/部门竖排品牌底纹；已核验渲染结果（主体不被登录卡片遮挡、右侧水印在 16:9 桌面下完整可见），`NOTICE` 同步改为「自研 / Apache-2.0」
  - B5：约束已写入 `AGENTS.md` 的 `Licensing and attribution`
  - 仍待决策：A3 的版本号规则二选一（`Makefile` 的 `VERSION` vs `scripts/get-version.sh`）
- 本方案基于对当前仓库的实际核对，**包含一个必须先处理的状态性问题**（见 §1.1）

## 1. 现状核对

### 1.1 结论：现有发布流水线在本仓库不会执行

`.github/workflows/release.yaml` 的两个作业都带组织门禁：

```yaml
# release.yaml:18
if: ${{ github.repository_owner == 'kite-org' }}
# release.yaml:122
if: ${{ github.repository_owner == 'kite-org' && startsWith(github.ref, 'refs/tags/v') }}
```

而本仓库：`origin = ssh://git@10.10.11.151:20222/teg/support-department/operation_rd_dept/kite.git`（内网 GitLab），module 为 `github.com/zxh326/kite`。也就是说 **`release.yaml`（构建/推送镜像、打包 Helm、创建 Release）与 `deploy-demo.yml` 在本仓库恒不执行**。当前处于"看起来有 CI/CD，实际靠手工发布"的状态——这是本方案要解决的第一个问题（要么让它能跑，要么明确删掉/标注，避免误导）。

### 1.2 其余事实

| 关注点 | 现状 |
| --- | --- |
| 版本号 | `Makefile` 的 `VERSION`（当前 `v1.0.0`）+ `scripts/get-version.sh`（从 git tag 推导）+ 构建时 ldflags 注入，前端侧边栏通过 `/api/v1/version` 展示；本机覆盖走 gitignored 的 `Makefile.local` |
| 发布脚本 | `scripts/release.sh` 只做一件事：bump `charts/kite/Chart.yaml` + `README.md` 版本 → commit → `git tag`（`set -x`，硬编码 `CHART_DIR`） |
| 发布说明 | `softprops/action-gh-release` 的 `generate_release_notes: true`（GitHub 自动生成"What's Changed"），**无分类聚合**，无 release-drafter |
| 其他工作流 | `ci.yml`（build + golangci-lint + pre-commit + test）、`e2e.yml`、`docs-ci.yml`、`build-preview-docker-image.yml` 可用（无组织门禁） |
| 产物卫生 | `charts/kite-1.0.0.tgz` 已从工作区删除、**未入库**（2026-09-18 复核：`git ls-files '*.tgz'` 无命中，`charts/` 下只有 `charts/kite/`）；`dev.db`、`bin/`、`tupian/` 未入库（已核对） |
| 归属文件 | 根目录**无 `NOTICE`**、**无 `licenses/`**；`LICENSE` 为 Apache-2.0；已有 `SECURITY.md`、`CONTRIBUTING.md` |
| 第三方资产 | `ui/src/assets/login-banner.svg` 来自 `eryajf/kite-desktop`，该仓库为 **AGPL-3.0-only**（其 README 与 `NOTICE` 明确）；`ui/src/assets/fonts/*`、`ui/src/assets/{icon,github}.svg` 来源未标注 |

---

## 2. A 部分：发布自动化

### A1. 先决定 `release.yaml` 的去留（三选一，必须选）

| 方案 | 说明 | 适用 |
| --- | --- | --- |
| A1-a 改造成本仓库可用 | 门禁改为 `${{ vars.RELEASE_ENABLED == 'true' }}`（或 `github.repository == 'zxh326/kite'` 之类），镜像目标改公司 registry；Docker Hub 登录步骤改为条件执行 | 如果确实希望用 GitHub Actions 出包 |
| A1-b 保持不动 + 加注释 | 最小改动，但仍是"死流水线"，后人会再次被误导 | **不推荐** |
| A1-c 删除 GitHub 侧发布流程 | 改用内网 GitLab CI / 本地 Makefile 流程，`scripts/release.sh` 扩展为完整发布脚本 | 内网交付为主时的推荐路径 |

### A2. 分类化发布说明（不依赖托管平台优先）

**路线 1（推荐）**：`git-cliff` + Conventional Commits

- 新增 `cliff.toml`，按类型分组（示例分组：`feat` 新功能 / `fix` 修复 / `perf` 性能 / `refactor` 重构 / `docs` 文档 / `chore` 杂项 / `BREAKING` 不兼容变更）
- `Makefile` 增加 `changelog` 目标（生成/更新 `CHANGELOG.md`），发布时可作为 Release 说明正文
- 优点：完全本地可跑（内网无外网也能用）、无需 PR 标签纪律，只需要 commit message 规范
- 前置：团队接受 Conventional Commits（若暂不接受，可先用 `git log --pretty` 生成按目录/模块分组的粗略说明作为过渡）

**路线 2（备选）**：`release-drafter`（仅当确认发布走 GitHub 且愿意维护 PR 标签体系）

- 需要 `feature`/`fix`/`docs`/`chore`/`breaking` 等标签 + PR 标题规范；配置 `.github/release-drafter.yml` 与对应 workflow
- 优点：草稿可人工审校后再发布；缺点：依赖托管平台与标签纪律

### A3. 版本与产物清单（与 A1 决策配套）

无论走 A1-a 还是 A1-c，都应固定为一条可执行清单（当前 `scripts/release.sh` 只覆盖了其中一步）：

1. `make pre-commit` + `make test`（含 `go test` 与 `pnpm test`）
2. 更新 `Makefile` 的 `VERSION`（或由 tag 推导，二选一并写死规则）
3. `make cross-compile` → `make package-binaries`（产物落 `bin/`）
4. 构建并推送镜像（`Dockerfile.binary`，目标 registry 用公司仓库，参考 charts 里已出现的 `swr.cn-south-1.myhuaweicloud.com/gzwxh/...`）
5. `helm package charts/kite` → 推送 chart（OCI 或 oss/内网仓库）
6. 打 tag、写发布说明（A2 产物）、附上二进制与 chart
7. 发布后核对：`/api/v1/version` 返回值与 tag 一致（ldflags 是否真的注入）

### A4. 产物卫生

- `charts/*.tgz` 不再入库：加入忽略规则，改由 Release 附件/OCI 承载（当前 `charts/kite-1.0.0.tgz` 已入库，需要一次清理提交）
- 确认 `dev.db`、`bin/`、`tupian/`、`static/` 的政策不变（前三个不入库，`static/` 由 `make frontend` 生成）
- `scripts/release.sh` 加固：去掉 `set -x`（会把凭据类参数打出来）、`CHART_DIR` 参数化、加"工作区必须干净"的前置检查

---

## 3. B 部分：归属与许可证

### B1. 新增 `NOTICE`

内容结构建议：

1. **上游归属**：本仓库基于 [kite-org/kite]（Apache-2.0），保留原始版权与许可声明
2. **本仓库改动说明**：内部二开（鉴权/审计/等保相关加固、MySQL 支持等），以及与原项目的差异声明
3. **第三方资产清单**（逐项列出：资产路径 → 来源 → 许可证）
4. **不构成背书的声明**：项目名与 LOGO 归属

### B2. 新增 `licenses/`

- 放 Apache-2.0 全文（`licenses/Apache-2.0.txt`）+ 其它第三方许可证全文
- `NOTICE` 里指向该目录；`README` 里也链一次

### B3. 资产核查（这是当前最大的合规缺口）

必须逐个确认来源与许可证，尤其是这两类：

| 资产 | 现状 | 处理建议 |
| --- | --- | --- |
| `ui/src/assets/login-banner.svg` | 取自 `eryajf/kite-desktop`，该仓库 **AGPL-3.0-only** | **建议替换为自研素材**（见下）；保留则需评估 AGPL 义务，对本项目（Apache-2.0 + 对外提供服务）不建议 |
| `ui/src/assets/fonts/*`（JetBrains Mono、Maple Mono） | 未标注来源 | 确认字体许可证（两者均为开源字体，需在 `NOTICE` 里标注字体名与许可证） |
| `ui/src/assets/icon.svg`、`github.svg` | 未标注 | 确认是否原创/来自上游；来自上游则随 Apache-2.0 声明 |
| `docs/src/*`、`charts/*` 内的图片 | 未标注 | 同上 |

**`login-banner.svg` 的自研替代方案（推荐）**：登录页只需要一层氛围背景，可以用现有 `ui/src/assets/icon.svg` 的图形语言 + 纯 CSS 渐变（天空蓝 → 浅色）+ 矢量化风筝剪影实现，产出 4–6 KB 的 SVG，**零许可风险**，且与站点视觉一致（当前 `LoginBackground` 的取景/蒙层逻辑无需改动，只换文件）。

### B4. README 与文档

- `README.md` / `README_en.md` 各加一段 "Acknowledgement / 归属"（上游项目、衍生关系、许可），并链接 `NOTICE`、`LICENSE`、`SECURITY.md`、`CONTRIBUTING.md`
- 不要在项目自述里使用对方的项目名/LOGO 作为自家品牌标识

### B5. 硬约束（写进 `AGENTS.md`，避免后续再引）

- **不要把 AGPL 项目的代码/组件文件复制进本仓库**（许可证不兼容）
- 新增第三方资产（图片/字体/图标）必须同时在 `NOTICE` 登记来源与许可证
- 修改许可证相关文件（`LICENSE`/`NOTICE`/`licenses/*`）需要显式评审，不允许顺手改

---

## 4. 实施清单

| 阶段 | 事项 | 产出 |
| --- | --- | --- |
| 1 | ~~决定 `release.yaml` 去留（A1）~~ | ✅ 采用 A1-a：门禁改 `vars.RELEASE_ENABLED`，镜像/chart 目标可配置，登录按目标仓库条件执行；`deploy-demo.yml` 保留门禁并注明上游专用 |
| 2 | 固定发布清单（A3）+ 加固 `scripts/release.sh`（A4） | 更新后的脚本 + `docs/dev/` 里的发布 checklist（可直接放本文档 §2 的清单） |
| 3 | 分类化发布说明（A2 路线 1） | `cliff.toml` + `make changelog` + `CHANGELOG.md` |
| 4 | 资产核查（B3） | ✅ `login-banner.svg` 已重画为自研素材（含公司/部门品牌底纹）；其余字体/图标仍待核（`NOTICE` 已逐项列出） |
| 5 | `NOTICE` + `licenses/`（B1/B2） | 两个文件 + README 链接 |
| 6 | 把 B5 的硬约束写进 `AGENTS.md` | 约定更新 |

## 5. 验收标准

1. 发布流程只有一条路径且**在本仓库真的能跑通**（或在文档中明确标注"仅上游仓库使用"并说明本仓库走什么流程），不再存在"看起来有但不会执行"的流水线
2. 一次发布能产出分类清晰的发布说明（不依赖人工回忆 commit）
3. `NOTICE` 覆盖仓库内所有第三方资产（含字体与图片），每项都有来源与许可证
4. `login-banner.svg` 的许可证状态明确（推荐自研替换）
5. `charts/*.tgz` 不再进版本库
6. `SECURITY.md` / `CONTRIBUTING.md` / `NOTICE` / `LICENSE` 在 README 中互相可达

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| 误删上游流程导致上游同步困难 | 删除前确认与上游的分叉策略（本仓库已经是内部二开，非镜像同步） |
| release notes 规范推行阻力 | 先用 A2 的过渡方案（按模块分组），不强制一次到位 |
| 替换登录页素材影响既有视觉 | 只替换 SVG 文件，保留 `LoginBackground` 的取景与蒙层参数；改完在深浅色两种主题下各看一次 |
| 归属文件写错反而引入风险 | 逐项核对来源；不确定的资产宁可不使用 |
