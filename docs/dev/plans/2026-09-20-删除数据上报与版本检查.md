# 方案：删除数据上报与上游版本检查

- 状态：**已实现**（后端 `pkg/common`、`pkg/model`、`pkg/settings`、`pkg/utils`、
  `pkg/version`、`pkg/middleware`、`static.go`，前端 `ui/src`，Helm chart / 部署清单，
  文档两侧同步）
- 触发：公司口径——上报功能**直接删除**；同口径要求把「提示新版本」的更新检查也一并删除。

## 1. 问题

实例原本有两处会主动访问外部服务，两处都带开关：

- **统计上报**：上游在 `static/index.html` 里注入 Umami 脚本，开关是环境变量
  `ENABLE_ANALYTICS` 与通用设置 `enable_analytics`。
- **版本检查**：`/api/v1/version` 查询 `api.github.com` 判断是否有新版本，开关是
  `DISABLE_VERSION_CHECK` 与通用设置 `enable_version_check`，前端在侧边栏顶一个
  「New」角标。

只把开关关掉（哪怕是默认关闭 + 环境变量优先）不够：开关、字段、界面条目都还在，
后人看到会以为它还能用；一个永远发不出请求的开关本身就是坑。

## 2. 新口径

**整体删除，不留开关。** 实例不再具备访问外部服务的能力：

- 没有统计注入点（`InjectAnalytics` 及其调用一并删除），没有 `ENABLE_ANALYTICS`；
- 没有更新检查（`update_checker.go` 整个删除），没有 `DISABLE_VERSION_CHECK`；
- 通用设置里既没有 `enableAnalytics` 也没有 `enableVersionCheck`，界面上没有对应条目，
  侧边栏也没有「New」角标；
- `Content-Security-Policy` 的 `script-src` / `connect-src` 只放行 `'self'`，并由测试守住。

## 3. 落点

| 位置 | 改动 |
| --- | --- |
| `pkg/utils/utils.go` | 删 `InjectAnalytics`、`AnalyticsScriptOrigin` |
| `static.go` | 删 index.html 的统计注入调用 |
| `pkg/version/update_checker.go` | **整文件删除**（`checkForUpdate`、`parseSemver`、结果缓存） |
| `pkg/version/version.go` | `VersionInfo` 只留 `version`/`buildDate`/`commitId`，删 `hasNewVersion`/`releaseUrl` |
| `pkg/common/common.go` | 删 `EnableAnalytics`、`EnableVersionCheck`、`AnalyticsConfigured()`、`VersionCheckConfigured()`、两个环境变量解析，以及随之无用的 `isBooleanEnv`/`parseBoolEnv` |
| `pkg/model/general_setting.go` | 删两个字段与默认值；`applyRuntimeGeneralSetting` 已无事可做，连同调用一并删除 |
| `pkg/settings/handler.go` | 删两个开关的读取、保存与「环境变量接管」校验，以及 `effectiveAnalytics`/`effectiveVersionCheck` |
| `pkg/middleware/security_headers.go` | CSP 不再随开关变化，第三方来源一律不放行 |
| `ui/src/lib/api/{admin,system}.ts` | 删对应类型字段 |
| `ui/src/components/app-sidebar.tsx` | 删「New」角标与 `useVersionInfo()` 调用 |
| `ui/src/components/settings/general-management.tsx` | 删两个表单字段与整个「运行时」区块 |
| `ui/src/i18n/locales/{zh,en}.json` | 删 `generalManagement.runtime` 整块与 `sidebar.updateAvailable` |
| `charts/kite/{values.yaml,templates/deployment.yaml}` | 删 `analytics.enabled`、`versionCheck.enabled` 与两个环境变量注入 |
| `deploy/*.yaml`、`dev.env` | 删两个环境变量 |
| 文档与 e2e | `README*`、`docs/{,en/}faq.md`、`docs/{,en/}config/{env,chart-values}.md`、`charts/kite/README_zh.md`、`e2e/specs/backend-api.spec.ts` |

## 4. 取舍

1. **`/api/v1/version` 保留。** 它另外还返回版本号、构建日期与 commit，用于界面上的
   版本显示，属于本地构建信息而不是外部请求；只删掉更新检查相关的字段与分支。
2. **数据库的 `enable_analytics`、`enable_version_check` 两列不删。** GORM `AutoMigrate`
   不会删列，SQLite 删列需要重建表；它们现在是没有模型映射的孤儿列
   （`NOT NULL DEFAULT false` / `DEFAULT true`），新插入由列默认值兜底，不影响任何读写
   路径。要清理得单独写迁移，收益不值当。
3. **`github.com/blang/semver` 依赖保留。** 删掉更新检查后它仍有使用者
   （helm release 版本比较等），不要顺手挪进 `go.mod` 的删除清单。
4. **不靠配置兜底，但也不放松 CSP。** `script-src` / `connect-src` 维持只放行 `'self'`，
   并补了断言，防止将来为重新引入外部脚本而悄悄放宽白名单。

## 5. 验证

- `go build ./...`、`go vet ./...` 通过；`pkg/{version,common,model,settings,auth,users,utils,middleware}`
  与根包测试全绿
- `pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json` 通过
- `helm template t charts/kite` 不再注入这两个环境变量，且渲染正常
- `make pre-commit`（prettier / go vet / golangci-lint / eslint）全绿
- 回归测试：`pkg/version/version_test.go` 断言响应里不出现 `hasNewVersion`/`releaseUrl`；
  `pkg/middleware/security_headers_test.go` 断言 `script-src`、`connect-src` 不含任何
  第三方来源；`main_test.go` 断言 `index.html` 里不含统计脚本
