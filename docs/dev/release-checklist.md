# 发布检查清单（release checklist）

本文把 [发布自动化与归属/许可证方案](./plans/2026-09-18-release-automation-and-attribution.md) §2 A3 的发布清单固化为可执行步骤，并收录 §2 A4 的产物卫生规则。工程内文档，不随文档站发布。

使用方式：发版时复制一份逐项勾选；未完成项不得打 tag。本仓库有两条路径——本地流程（§1）与 GitHub Actions（§2，**默认关闭**，需显式开启）。

## 1. 本地发布清单（A3）

- [ ] **1. 跑完整检查**：`make pre-commit` + `make test`（含 `go test` 与 `pnpm test`），全部通过。
- [ ] **2. 确定版本号规则**：二选一并写死规则——改 `Makefile` 的 `VERSION`（当前 `dsy-v1.0.0`），或完全由 git tag 推导（`scripts/get-version.sh`）。不要两种并存。**（该二选一仍未定，见 §5）**
- [ ] **3. 交叉编译并打包**：`make cross-compile` → `make package-binaries`，确认产物落在 `bin/`。
- [ ] **4. 构建并推送镜像**：使用 `Dockerfile.binary`，目标 registry 用公司仓库（参考 `Makefile` 的 `IMAGE`，如 `swr.cn-south-1.myhuaweicloud.com/dsy/...`）。`make image` / `make push`。
- [ ] **5. 打包并推送 chart**：`helm package charts/kite`，推送 chart（OCI 或内网/oss 仓库）。注意打包产物不得入库（见 §3）。
- [ ] **6. 打 tag 并写发布说明**：`scripts/release.sh <version>` 完成 bump + commit + tag；发布说明用 `make changelog` 的产物，并附上二进制与 chart。
- [ ] **7. 发布后核对**：确认 `/api/v1/version` 返回值与 tag 一致（验证 ldflags 是否真的注入了版本号）。

## 2. CI 发布（可选，默认关闭）

`release.yaml` 已改成本仓库可用：推送 `v*.*.*` tag 触发，但**必须显式打开开关**，否则作业整体跳过（原来写死 `github.repository_owner == 'kite-org'`，本仓库恒不执行）。

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 变量 | `RELEASE_ENABLED` | 设为 `true` 才会跑（默认不跑，避免误触发发布） |
| 变量 | `IMAGE_REPOSITORY` | 目标镜像，默认 `swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite`（与 `charts/kite/values.yaml` 的 `image.repository` 一致）；例如 `ghcr.io/<owner>/kite` |
| 变量 | `CHART_OCI_REPOSITORY` | chart 的 OCI 目标，留空则不推 chart；例如 `oci://swr.cn-south-1.myhuaweicloud.com/dsy/devops/charts` |
| 变量 | `HELM_INDEX_ENABLED` | 是否更新 gh-pages 上的 Helm index（上游的分发方式），本仓库默认关 |
| Secret | `IMAGE_REGISTRY_USERNAME` / `IMAGE_REGISTRY_PASSWORD` | 非 ghcr.io 目标仓库的推送凭据（ghcr.io 用内置 `GITHUB_TOKEN`） |

镜像 host 由 `IMAGE_REPOSITORY` 首段推导（带点/端口的是 registry，否则按 Docker Hub 处理），登录方式据此选择，换仓库不用改工作流。

与本地流程的两处差异，需要留意：

- CI 用 `make cross-compile VERSION=<tag>` 覆盖 Makefile 的默认版本号，产物版本与 tag 天然一致；本地仍按 Makefile 的 `VERSION`。
- CI 的 Release 正文由 `scripts/changelog.sh` 生成（上一个 tag..当前 tag 的分类聚合），不再是托管平台自动汇总的 commit 列表。

## 3. 产物卫生（A4）

- [ ] `charts/*.tgz` 不入库：`.gitignore` 已忽略 `kite-*.tgz` 与 `charts/*.tgz`；打包产物改由 Release 附件 / OCI 承载。
- [ ] `dev.db`、`bin/`、`tupian/` 不入库的政策不变；`static/` 是 `make frontend` 的生成物，不得手工提交。
- [ ] `scripts/release.sh` 的约束保持有效：
  - 不使用 `set -x`（避免把凭据类参数打进日志）；
  - `CHART_DIR` 已参数化（默认 `charts/kite`，可用第二个参数或环境变量覆盖）；
  - 打 tag 前要求工作区干净，存在未提交改动时直接失败。

## 4. 相关命令速查

```bash
make changelog                    # 生成 CHANGELOG.md（分类发布说明）
sh scripts/changelog.sh --from v0.15.0 --to HEAD   # 只生成某个区间的发布说明
sh scripts/release.sh 1.0.1       # bump chart 版本 → commit → tag v1.0.1
```

## 5. 仍待决策

- **版本号规则二选一**（§1 第 2 步）：`Makefile` 的 `VERSION` 与 `scripts/get-version.sh` 的 tag 推导目前并存，需要选一条写死。
- **`ui/src/assets/login-banner.svg`**：✅ 已处理——2026-09-18 重画为自研素材（不再引用 AGPL 项目图纸，并在图内加入公司/部门品牌底纹），`NOTICE` 已改为「自研 / Apache-2.0」。
- **`deploy-demo.yml`**：上游专用（把 demo 分支推到 ghcr.io 并重启上游的演示实例），保留 `kite-org` 门禁并在文件头注明；若要改成公司演示环境，需另立方案。
