# 创建/编辑对等（ConfigMap、Secret）与列表列宽收敛

- 状态：**已实现**
- 背景：需求是「系统里所有能创建的都要能改，列表页要有操作列」。逐页核对后发现只有
  ConfigMap / Secret 两个列表既没有操作列，详情页也没有「编辑」入口以外的问题；同时
  这两个列表的「键」列内容不受控，能把表格撑宽。

## 1. 编辑对等：现在覆盖哪些资源

有独立创建表单的资源一共 12 类，全部具备「列表操作列 → 编辑」与「详情页 → 编辑」：

| 资源                                                       | 列表操作列                  | 详情页编辑按钮                               | 编辑路由                               |
| ---------------------------------------------------------- | --------------------------- | -------------------------------------------- | -------------------------------------- |
| Pod / Deployment / StatefulSet / DaemonSet / Job / CronJob | `resource-row-actions.tsx`  | 各自详情页                                   | `…/:namespace/:name/edit`              |
| Service                                                    | 同上                        | `service-detail.tsx`                         | 同上                                   |
| ConfigMap / Secret                                         | 同上（**本次补齐**）        | `configmap-detail.tsx` / `secret-detail.tsx` | 同上                                   |
| PersistentVolume / StorageClass                            | 同上                        | 通用详情页标题栏（**本次补齐**）             | `…/:name/edit`（集群级，无命名空间段） |
| Namespace                                                  | `namespace-row-actions.tsx` | `EditNamespaceDialog`                        | 弹窗（不是独立页面）                   |

编辑页路径不再各写一份：`ui/src/lib/resource-catalog.ts` 的
`formEditableResourceTypes` / `getResourceFormEditPath` 是唯一来源，行操作菜单与详情页
标题栏都从它取路径。`ui/src/lib/resource-catalog.test.ts` 会读 `routes.tsx` 核对每一类
都有对应的 `…/edit` 路由——漏登记的表现是「点了编辑没反应」（404），手工点一遍很容易漏。

「能创建」还有一条通用出口：顶栏的「创建资源」（`create-resource-dialog.tsx`，从资源模板
生成 YAML apply），它可以创建任意 Kind。那条路径上的改动方式是详情页的 YAML 标签页
（本就提供保存），不是本次的表单编辑。

## 2. 列宽收敛：ConfigMap / Secret 的「键」列

集群实测（1280×720 视口，容器宽 982px，种一个 32 个长键的 ConfigMap / 8 个键的 Secret）：

| 页面       | 修复前表格宽                          | 修复后                |
| ---------- | ------------------------------------- | --------------------- |
| Secrets    | 1930px（键列 1463px，容器内横向滚动） | 982px（键列 344px）   |
| ConfigMaps | 982px（键列两行换行）                 | 982px（键列单行截断） |

做法：`ui/src/components/data-keys-cell.tsx`——两个页面共用同一个单元格：只显示一行、
`truncate` 截断（`max-w-72`），完整列表放 tooltip（`common.fields.keys` 列头，
tooltip 里带 `resourceTable.keyCount` 的数量）。ConfigMap 列表原先的内联实现已换成它，
Secret 列表从「最多显示 5 个键、无 tooltip」改为同一套。

## 3. 未做 / 边界

- 其余资源（Ingress、NetworkPolicy、HPA、CR 等）没有创建表单，也就没有表单编辑页；
  要改只能走详情页 YAML。真要给它们做表单，按 `feature-code-index.md` §5 的
  「给某类资源加编辑」清单走一遍即可。
- PVC 仍未做表单编辑（`spec` 几乎全不可变，见 `2026-09-20-pv-sc-form-edit.md` §6）。
- `columnSizing`（`table-fixed` + 每列固定宽度）只在 Secret / ConfigMap 之外的地方用过
  （审计日志）；这两个页面靠单元格截断收敛宽度，没启用固定列宽，改动面更小。

## 4. 验证

- 单测：`pnpm --dir ui test`（`resource-catalog.test.ts` 路由覆盖、`data-keys-cell.test.tsx`
  截断与 tooltip、`resource-row-actions.test.tsx` 里 ConfigMap/Secret 的菜单项与编辑路径）
- e2e（真实集群）：
  - `specs/list-row-actions.spec.ts`：12 类资源的操作列在最后一列、从列表菜单进编辑页
  - `specs/list-cell-truncation.spec.ts`：表格不宽于容器、内容被截断、悬浮显示完整键列表
  - `specs/resource-detail.spec.ts`：PV / StorageClass 详情页标题栏直达编辑页
- 反证：去掉单元格的 `truncate max-w-72` 后，`list-cell-truncation` 两个用例在
  「表格不宽于容器」这条断言上失败（Expected false / Received true）；去掉两个列表的
  操作列后，`list-row-actions` 里对应的 4 个用例失败。
