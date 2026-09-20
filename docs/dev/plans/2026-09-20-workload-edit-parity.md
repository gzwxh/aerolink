# 方案：其余工作负载补齐「编辑」入口（与 Deployment 一致）

- 状态：**已实现**（路由 + 详情页入口 + 合并规则修复 + 单元/e2e 测试，e2e 已在本地集群实跑）
- 触发：用户指出「工作负载里 /deployments 能编辑，其他的也需要支持编辑功能」。
- 相关：`docs/dev/plans/2026-09-18-workload-editor-decomposition.md`（编辑器拆分）

## 1. 改前的差距

Deployment 有两条编辑路径，其余工作负载只有第一条的一半：

| 能力 | Deployment | StatefulSet / DaemonSet / Job / CronJob |
| --- | --- | --- |
| 详情页 YAML 标签页可改可存 | 有 | 有（`ResourceDetailShell` 的 `onSaveYaml`） |
| 表单编辑器（容器/探针/存储/调度…） | 创建 + **编辑**（`/deployments/:ns/:name/edit`，详情页有「编辑」按钮） | **只有创建**：路由里只有 `…/create`，详情页没有任何编辑入口 |

`DeploymentCreatePage` 本身是通用的（`resourceType` 决定资源类型，`:name` 参数存在时切到编辑模式
`DeploymentEditPage`），所以缺的只是路由和入口。

## 2. 改动

1. **路由**：给 `statefulsets` / `daemonsets` / `jobs` / `cronjobs` 各补一条
   `:namespace/:name/edit`，都渲染同一个 `DeploymentCreatePage`（带对应 `resourceType`）。
2. **入口**：四个详情页的 `headerActions` 增加「编辑」按钮，跳到自己类型的编辑路由，
   门禁与其它写操作一致（`<资源>.update`，没有权限就不渲染）。Job 详情页此前没有任何写操作，
   顺手把 `jobs.update` 的判定加上了。
3. **合并规则修复**（`ui/src/components/editors/deployment-form.ts` 的 `mergeEditedManifest`）：
   见下一节 —— 不修的话 Job 根本存不回去。

## 3. 顺手修掉的真问题：Job 编辑保存必失败

编辑页保存前会把「表单生成的 manifest」叠加到线上对象上，目的是保留表单没建模的字段
（`serviceAccountName`、`topologySpreadConstraints` 等），并且从线上对象恢复不可变的
`spec.selector`。

但生成 batch 模板（Job / CronJob）时，表单**固定写 `restartPolicy: OnFailure`**
（Job 的 Pod 模板不接受 `Always`，所以创建时必须给一个值），而表单里没有 restartPolicy 这一栏。
于是编辑一个 `restartPolicy: Never` 的 Job 时，即使一个字都没改，提交上去的模板也从 `Never`
变成了 `OnFailure` —— Job 的 Pod 模板不可变，API 直接以
`spec.template: Invalid value: ... field is immutable` 拒绝。实测报错：

```
Failed to update resource: Job.batch "zz-e2e-jobedit-…" is invalid:
spec.template: Invalid value: core.PodTemplateSpec{… RestartPolicy:"OnFailure" …}: field is immutable
```

修法：编辑模式下按线上对象恢复模板的 `restartPolicy`（`spec.template.spec` 与
CronJob 的 `spec.jobTemplate.spec.template.spec` 两条路径都覆盖）。表单没有该输入项，
就不该替用户改它；要改仍可在 YAML 标签页里改（YAML 标签页不走这条合并逻辑）。

## 4. 测试

- 单元（`ui/src/components/editors/deployment-form.test.ts`）：未建模字段保留 / selector 与模板标签
  从线上对象恢复 / status 与 managedFields 不回写 / **Job 与 CronJob 的 restartPolicy 恢复**。
- e2e（`e2e/specs/workload-edit.spec.ts`，本地集群实跑，对象由 API 种好、用例自清理）：
  StatefulSet 改镜像、DaemonSet 改镜像且保留 `nodeSelector`、CronJob 改调度周期、
  Job 改标签且 Pod 模板原样（保存成功本身即证明模板没被改写）。
  用例刻意不产生真实运行的 Pod：`replicas: 0`、命中不了的 `nodeSelector`、不触发的调度。
- 反证：去掉 restartPolicy 恢复 → 单元测试 2 条失败（`OnFailure` vs `Never`），
  e2e 的 Job 用例失败于 `field is immutable`（修复前的首次运行就是这个报错）。

## 5. 边界与后续

- **Job 的可编辑范围**是受限的：Pod 模板不可变，而表单是模板中心的（没有
  `backoffLimit` / `parallelism` / `completions` 这类 Job 级字段），所以目前能改的主要是
  元数据（标签/注解）与 YAML 标签页。要让它真正好用，得在表单里补 Job 级字段 —— 本次没做。
- **Pod 没有加编辑入口**：Pod 规格基本不可变，已有的手段够了（YAML 标签页、
  容器卡片里的编辑容器、就地调资源、debug）。要做的话得先确认表单对这些不可变字段的处理。
- **Service / ConfigMap / Secret** 等其它资源同样只有创建页或 YAML 编辑，本身不在「工作负载」范围内，
  本次未动。

## 6. 列表页的「操作」列（2026-09-20 追加）

**问题**：`/deployments` 最右列的操作菜单里**没有「编辑」**——想改一个 Deployment 只能先点进
详情页，再用详情页上的编辑按钮；而工作负载分组下的其余五类（StatefulSet / DaemonSet / Job /
CronJob / Pod）列表**连操作列都没有**，只能靠点进详情页。

**改动**：

- 把原来 Deployment 专用的 `deployment-row-actions.tsx` 泛化成
  `ui/src/components/resource-row-actions.tsx`（props：`resourceType` + `resource`），
  工作负载六类与 Service 共用（Service 那部分是后补的，见文末）。
  菜单第一项是新增的「编辑」，直达 `/{type}/{namespace}/{name}/edit`（六类的编辑路由在第 1、3 节已经补齐）。
- 各类型的差异全部收敛在文件内的 `resourceTraits`（容器在哪个 spec 路径下、支持哪些菜单项），
  其余菜单项对所有类型的行为一致。
- i18n 命名空间 `deploymentActions` → `resourceActions`（文案本来就与类型无关），两个语言包同步改名。
- 六个列表页（工作负载分组，见 `ui/src/lib/resource-catalog.ts` 的 `sidebar.groups.workloads`）
  与 `/services` 各加一列 `columnHelper.display({ id: 'actions' })`。

能力矩阵（`✓` = 该类型的菜单里有这一项）：

| 类型 | 编辑 | 查看 YAML | 终端 | 修改镜像 | 暂停/恢复 | 滚动重启 | 回滚 | 标签/注解 | 删除 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deployment | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| StatefulSet | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| DaemonSet | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Job | ✓ | ✓ | ✓ | — | — | — | — | ✓ | ✓ |
| CronJob | ✓ | ✓ | — | ✓ | — | — | — | ✓ | ✓ |
| Pod | ✓ | ✓ | ✓ | ✓ | — | — | — | ✓ | ✓ |
| Service | ✓ | ✓ | — | — | — | — | — | ✓ | ✓ |

每一项都有原因，不是随意取舍：

- **Job 不给「修改镜像」**：`spec.template` 创建后不可变（`field is immutable`），改镜像只能重建 Job。
- **CronJob 不给终端**：它不直接拥有 Pod，容器在 `spec.jobTemplate.spec.template` 里；
  CronJob 详情页本身也没有终端页签。
- **Pod 不给滚动重启/回滚**：没有控制器，没有历史版本；它的镜像是少数可变字段之一，所以保留改镜像。
- **暂停/恢复只有 Deployment**：只有它（和 CronJob 的 `suspend`）有这个语义，本次没有为 CronJob 造入口。
- **Service 只留元数据相关的四项**（编辑 / YAML / 标签注解 / 删除）：它没有容器、没有历史版本、
  也没有终端（`containers: null` 同时关掉了「修改镜像」）。

## 7. 测试（第 6 节）

- 组件（`ui/src/components/resource-row-actions.test.tsx`，14 条）：七类的「编辑」都能跳到
  `/{type}/{ns}/{name}/edit`；各类型的菜单项与上表一致（Job 无改镜像/重启/回滚、CronJob 无终端、
  Pod 无重启、Service 只有四项）；没有 `update` 权限时不出编辑与标签/注解；一条权限都没有时整列不渲染。
- e2e（`e2e/specs/list-row-actions.spec.ts`，本地集群实跑，10 passed）：七类列表都有操作列，
  以及从 Deployment / Service 列表的操作菜单进编辑页（进的是编辑模式，身份字段来自线上对象且被锁定）。
- 反证：去掉「编辑」菜单项 → 6 条用例失败（每条对应一个类型）；把 Job 的改镜像打开 →
  「Job 不提供改镜像」失败；给 Service 打开终端 → 「Service 只保留编辑、YAML、标签注解与删除」失败。
- **一条容易踩的坑**：列表为空时页面渲染的是空态，**整张表（含表头）都不出现**，
  所以 e2e 里断言「有操作列」必须先种一个对象；反过来，只断言表头而不种对象会得到假失败。
  （六类对象的种法都刻意让负载跑不起来：命中不了的 `nodeSelector`、`replicas: 0`、
  永不触发的 cron 表达式、立刻失败退出的 Job。）
