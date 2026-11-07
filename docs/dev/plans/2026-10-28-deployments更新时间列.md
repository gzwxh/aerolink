# Deployments 的更新时间（列表列 + 详情页摘要卡）

日期：2026-10-28
状态：已实现

## 1. 背景与口径

Deployment 页面上只有「创建时间」（`metadata.creationTimestamp`，列表里是「存活时间」列与
默认隐藏的「创建时间」列）。用户想知道「这个部署最近什么时候被更新过」。

Kubernetes 本身不给对象记「最后修改时间」：`metadata` 只有 `creationTimestamp`；能反映写入时刻的
`managedFields[].time` 在列表/详情接口里被后端统一裁掉了（`SetManagedFields(nil)`），而且
kube-controller-manager 会随 status 同步不断刷新它，当「更新时间」用并不可靠。所以这件事只能选口径，
并把口径写在界面上，不能让人读成「这个对象从未被改过」。

最终同时呈现两个口径：

| 界面名称 | 取数 | 覆盖 | 边界 |
| --- | --- | --- | --- |
| 平台操作时间 | 审计表 `resource_histories` 里该对象最近一次**成功**的写操作 | 通过 AeroLink 的创建 / 更新 / patch / apply / 回滚 | kubectl、CI 直接改集群不会留下记录；审计保留策略清理后变空；sink≠database 时整列不可用 |
| 最近发布 | `status.conditions[type=Progressing].lastUpdateTime` | 所有来源的滚动发布推进 | 纯扩缩容、只改标签不会刷新它 |

## 2. 后端

### 2.1 接口

`pkg/resources/generic_resource_handler_last_updates.go`，挂在通用资源 handler 的自定义路由上
（`registerCustomRoutes`）：

```
GET /api/v1/deployments/:namespace/last-updates          # 单个命名空间
GET /api/v1/deployments/_all/last-updates                # 全部命名空间
→ { "data": [ { "resourceName": "nginx", "namespace": "default", "lastUpdatedAt": "..." } ] }
```

路由形态与既有子路由（`/:namespace/:name/history`、pods 的 `/:namespace/watch`）一致，因此沿用
`middleware.RBACMiddleware` 的资源级 `get` 判定，不新增授权路径。两点后果要认：

- 对象名恰好是 `last-updates` 的 Deployment，其单对象 GET 会让位给这条静态路由（与 pods 的 `watch`
  同名冲突同一取舍）；这类名字在本项目里视为不可用。
- `_all` 子路由按既有规则需要显式的 `_all`/`*` 命名空间授权，限定命名空间的角色拿不到——这与
  `/history` 完全一样，不是这次引入的例外。

### 2.2 聚合口径

按对象取「最后一次成功写入」，只算 `create / update / patch / apply / rollback`（`delete` 不算：
对象已经不在列表里，同名新对象会另起一条 create）。集群名、资源类型、`success` 的过滤写法与
`ListHistory` 保持一致，保证列表上的时间与详情页「历史」tab 看到的是同一批记录。

分两步查：

```sql
-- 1) 每个对象取最大 id（同一秒内的多次写入也能取到最后一条）
SELECT MAX(id) AS id FROM resource_histories
WHERE cluster_name = ? AND resource_type = ? AND success = ? AND operation_type IN (...)
  [AND namespace = ?]
GROUP BY resource_name, namespace;

-- 2) 回表按具名列取时间
SELECT resource_name, namespace, created_at FROM resource_histories WHERE id IN (子查询);
```

不写成 `MAX(created_at)`：那是个表达式列，驱动不知道它的类型，SQLite（glebarez 纯 Go 驱动）上直接报
`unsupported Scan, storing driver.Value type string into type *time.Time`。回表取具名列 `created_at`
三库都能正常解析。第二步用子查询而不是把 id 拼成参数列表，避开 SQLite / MySQL 的占位符数量上限。
`GROUP BY resource_name, namespace` 与复合索引
`idx_resource_histories_lookup_with_time`（cluster_name, resource_type, resource_name, namespace, created_at）
的列顺序对齐；涉及的列名都不是三库保留字。

跨命名空间时处理器里逐条 `rbac.CanAccess(user, type, "get", cluster, ns)` 过滤，与 `list` 同一规则：
中间件只确认用户拿得到 `_all` 子路由的请求权，能看到哪些命名空间由处理器决定。

### 2.3 sink≠database

复用 `rejectUnsupportedResourceHistory`：审计不落库时返回 501 + `resource_history_requires_database_sink`，
前端按「取不到」处理，不是返回空列表。

## 3. 前端

- 取数：`ui/src/lib/api/core.ts` 的 `useResourceLastUpdates(resourceType, namespaces)`，返回
  `"<namespace>/<name>" -> ISO 时间` 的映射，staleTime 30s。多选命名空间时逐个请求再合并（`_all`
  要显式授权，限定命名空间的角色拿不到）；单个命名空间失败（含 403、501）不影响其余结果。
- 列表页：`ui/src/pages/deployment-list-page.tsx` 新增 `platform_updated`、`rollout_updated` 两列，
  都进 `HIDDEN_BY_DEFAULT_COLUMNS`（参考版式里没有的列保留但默认隐藏），单元格是「相对时间 +
  tooltip 里给完整时间与口径」。命名空间选择由表格内部状态持有，页面按同一口径初始化并在
  `onNamespaceChange` 里跟进，否则列会停在旧命名空间的时点；重启 / 扩缩容完成后额外 invalidate
  `resource-last-updates`（平台时间来自审计表，不随 K8s watch 刷新）。
- 详情页：`ui/src/components/deployment-overview.tsx` 的摘要卡在「创建时间」后加两张更新时间卡，
  标签上挂口径说明的 tooltip；`@4xl` 栅格从 6 列改 4 列，让 8 张卡排成两行。
- 共用取值：`ui/src/lib/k8s.ts` 的 `getDeploymentRolloutTime()`，列表与详情同一口径，避免两处漂移。
- 文案：`common.fields.platformUpdated` / `common.fields.rolloutUpdated` 与
  `common.messages.platformUpdatedHint` / `common.messages.rolloutUpdatedHint`（zh 为准，en 同步）。
- 已知成本：列默认隐藏，但取数在页面挂载时就会发生（一次聚合查询）——列可见性由
  `ResourceTable` 内部状态持有，页面拿不到，没有为了懒加载去改通用组件；因此列表页把
  staleTime 放到 60s。写操作后的 invalidate 不受 staleTime 影响，仍会立即重取。

## 4. 已知边界

- 「平台操作时间」不是集群里对象真实的修改时刻：外部写入看不到。UI 的 hint 已写明。
- 审计被保留策略滚动清理后，很久没在平台上改过的对象会显示「-」。
- 「最近发布」在只改副本数或标签时不刷新；这属于口径本身，不做兜底猜测。
- 只对走 `GenericResourceHandler` 的资源类型注册了该路由；Pod 有自己的 `registerCustomRoutes`，
  本次不做 pods / statefulsets 的列（只按需求做 deployments）。

## 5. 验证

- `go test ./pkg/resources -run TestListLastUpdates`：单命名空间聚合口径、`_all` 逐条鉴权、
  sink≠database 的 501。`go test ./pkg/resources`（含 `RegisterRoutes` 全量注册，验证路由不冲突）。
- `pnpm --dir ui exec vitest run src/lib/k8s.test.ts`：`getDeploymentRolloutTime` 的取值口径。
- `pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json`、改动文件的 eslint 与 prettier。
- 手工：deployments 列表打开两列、切命名空间/多选、在平台上改一次镜像后看时间是否推进；
  详情页摘要卡与「历史」tab 的时间是否一致。
