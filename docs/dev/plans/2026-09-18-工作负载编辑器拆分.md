# 方案：工作负载编辑器拆分（可测试 + 创建/编辑复用）

- 对应总览报告中的第 **9** 项（P0 清单）
- 状态：**待实施**（方案已定；影响范围核对见 §9，其中有 4 处需修正）
- 目标一句话：把 5600 行的"容器表单"变成**一组纯受控编辑器 + 一个只做编排的页面**，让创建与编辑用同一套组件，并且每块都能单测

## 1. 现状（已核对）

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `ui/src/pages/deployment-create-page.tsx` | 2258 | 表单状态、Tab（deployment / pod / container-N）、校验、YAML 预览、提交 |
| `ui/src/components/editors/deployment-form.ts` | 1219 | 类型、默认值、build（表单 → 容器数组）、parse（YAML → 表单） |
| `ui/src/components/workload-container-sections.tsx` | 671 | `PortsEditor`(L32)、`CommandEditor`(L351)、`ProbesEditor`(L639) |
| `ui/src/components/workload-container-security.tsx` | 490 | `GpuEditor`(L33)、`SecurityContextEditor`(L110)、`StorageMountsEditor`(L268)、`LifecycleEditor`(L380) |
| `ui/src/components/container-edit-dialog.tsx` | 107 | 只挂 `EnvironmentEditor` / `ImageEditor` / `ResourceEditor` |

两个关键发现（决定了拆分的价值）：

1. **创建与编辑能力不对称**：上面这些 sections 只被 `deployment-create-page.tsx` 引用（已 grep 确认），而列表页的"编辑容器"对话框用的是另一套（只有 环境变量 / 镜像 / 资源）。也就是说：**创建时能配端口、命令、探针、生命周期、存储挂载，编辑时配不了**。这不是重构洁癖，是功能缺口。
2. **依赖方向是反的**：`workload-container-sections.tsx` 反过来从 `editors/deployment-form.ts` 导入 `PortForm` / `PortServiceType` 类型。如果只是把编辑器挪进 `components/editors/`，会形成 `editors/container/* ↔ editors/deployment-form.ts` 的类型循环，先要把公共类型下沉。

## 2. 目标与非目标

**目标**

- 每个关注点一个编辑器组件，对外只暴露 `value` + `onChange`，不接触页面状态
- 创建页与编辑对话框复用同一批组件（补上编辑能力缺口）
- 每个编辑器有组件测试；页面只剩编排与校验
- **生成的 YAML 逐字节不变**（这是重构的硬约束）

**非目标**

- 不改交互设计与文案（i18n key 一个都不动）
- 不改提交路径（仍走 `applyResource`）
- 不引入表单库（保持现有 `useState` + 受控组件风格）
- 不顺手改校验规则（校验抽取放到最后阶段，且行为不变）

## 3. 目标结构

```
ui/src/lib/workload/                 # 纯数据层（无 React）
  container-types.ts                 # ContainerForm / PortForm / ProbeForm … 及 k8s 类型映射
  container-defaults.ts              # 新建容器/端口的默认值
  container-build.ts                 # 表单 → Container[]
  container-parse.ts                 # Container[] / YAML → 表单
  container-validation.ts            # （Phase 5）校验规则

ui/src/components/editors/container/ # 编辑器（每个 = 一个关注点）
  ports-editor.tsx
  command-editor.tsx                 # 内部继续用 components/command-list-input.tsx
  env-editor.tsx
  resources-editor.tsx
  image-editor.tsx
  probes-editor.tsx
  lifecycle-editor.tsx
  security-context-editor.tsx
  gpu-editor.tsx
  storage-mounts-editor.tsx
  index.ts                           # 统一导出

ui/src/pages/deployment-create/      # 页面按区拆（Phase 4）
  index.tsx                          # 编排：状态、Tab、提交
  deployment-section.tsx
  pod-section.tsx
  container-section.tsx              # 组合上面 9 个编辑器
```

## 4. 关键约束（不遵守就会引入隐性回归）

1. **只暴露 `value` + `onChange(patch)`**：编辑器不得 import 页面、不得读写 `formData`；这样它才能在创建页与对话框里同时成立
2. **空值语义保持不变**：现在 build 端用 `...(extra.ports?.length && { ports: extra.ports })` 这类判断——"空数组不写字段"、"空字符串不写字段"必须逐条保持（Phase 0 的快照测试就是防这个）
3. **类型下沉，消灭反向依赖**：`PortForm` 等表单类型移到 `ui/src/lib/workload/container-types.ts`；`editors/deployment-form.ts` 只作为兼容出口（重新导出），避免一次性改几十处 import
4. **i18n key 原样搬**：文案不动，避免中英两处漏改
5. **命令/参数/探针输入必须继续用 `CommandListInput`**：它修的就是"空格打不出来"（`value={arr.join(' ')}` 直连写法会复发），并在组件测试里覆盖"能输入空格"
6. **权限语义不动**：编辑路径走 update 权限（`useCan('...','update')`），创建走 create；复用时不要把两者的权限判定混在一起

## 5. 分阶段实施（每阶段可独立合并、独立验证）

**Phase 0 · 护栏（先合，纯新增）**

- 给 build 逻辑加纯函数快照测试：同一组表单输入 → 输出 YAML/Container[] 快照（若 build 函数当前未导出，先导出；这是本阶段唯一的生产代码改动）
- 跑一次 e2e 基线：`make e2e-test`（重点 `e2e/specs/resource-creation.spec.ts`、`resource-lifecycle.spec.ts`）

**Phase 1 · 纯搬移（无行为变化）**

- 类型下沉到 `ui/src/lib/workload/container-types.ts`；在 `editors/deployment-form.ts` 里重新导出，保持现有 import 可用
- 两个 `workload-container-*.tsx` 里的编辑器逐个搬到 `components/editors/container/`，**只改 import 路径，不改实现**
- 验证：`tsc` + `eslint` + Phase 0 快照不变 + e2e 通过

**Phase 2 · 编辑器单测**

- 每个编辑器一个 `*.test.tsx`：渲染给定值、交互后 `onChange` 载荷正确、空集合不写字段、`CommandListInput` 能输入空格
- 验证：`pnpm run test` 增量通过（这也是本轮"补前端组件测试"的落点之一）

**Phase 3 · 编辑侧复用（补齐能力缺口）**

- `container-edit-dialog.tsx` 的页签接入 ports / command / probes / lifecycle / security / storage / gpu，复用同一批编辑器
- 保持"对话框内是本地草稿，点保存才回写"的现有模式（`ContainerEditDialogContent` 已有该结构）
- **写回路径不变（已核对）**：`ui/src/pages/deployment-detail.tsx:294` 的 `handleContainerUpdate` 是"克隆整个容器 → 替换该容器 → `updateResource` 整对象 PUT"；因为是在克隆体上打补丁，**当前没建模的字段不会被丢掉**，所以补齐编辑器是**纯新增能力**，不会顺手清掉用户已有的探针/端口
- **同构实现要一起接**：`ui/src/pages/statefulset-detail.tsx`、`ui/src/pages/daemonset-detail.tsx` 也各有同样的 `onContainerUpdate` 写法
- 顺带修一个既有体验问题（建议）：整对象 PUT 依赖 `metadata.resourceVersion`，并发修改时 API Server 会拒（409），而前端目前把错误统一吞进站内信 → 保存失败时显式提示"资源已被修改，请刷新后重试"
- 验证：手动核对"编辑容器改端口 → 保存 → 详情正确"；补一个对话框的组件测试（打开→改端口→保存载荷）
- 风险：对话框变长 → 页签分组；若某编辑器依赖只在创建时存在的上下文（如 workloadName），需通过 props 显式传入或降级隐藏

**Phase 4 · 页面瘦身**

- `deployment-create-page.tsx` 按区拆到 `pages/deployment-create/`，页面只留状态编排、Tab 与校验调用
- `editors/deployment-form.ts` 拆为 `lib/workload/` 下的 types / defaults / build / parse（`deployment-form.ts` 保留为兼容出口）
- 验证：快照 + e2e + 页面行数目标（< 800 行）

**Phase 5 · 可选：校验抽取**

- 把散在页面里的校验抽到 `lib/workload/container-validation.ts` 并补单测（错误文案 key 不变）

## 6. 测试与回归闸门

| 闸门 | 手段 |
| --- | --- |
| YAML 输出不变 | Phase 0 的纯函数快照（每次改结构后对比） |
| 交互不回归 | 每个编辑器的 `*.test.tsx`；`CommandListInput` 的空格用例 |
| 端到端不回归 | `make e2e-test`（创建 + 生命周期 spec） |
| 类型与风格 | `pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json`、`eslint`、`prettier` |

## 7. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 搬移时悄悄改了行为（最常见） | Phase 1 严格"只改 import"；用快照 + e2e 做闸门；一次只搬一个编辑器，小步提交 |
| 反向依赖没拆干净导致循环 import | Phase 1 先下沉类型，再搬组件；构建期就能暴露（Vite/tsc 会报） |
| 编辑侧补齐后权限口径变化 | 明确编辑走 update 权限，并在 Phase 3 单独核对 RBAC 判定不变 |
| 对话框变复杂影响可用性 | 编辑器按页签分组；必要时模板/存储这类低频项折叠 |
| 大文件拆分后 git blame 变难 | 接受（用 `git log --follow` 追历史），换来可测试性 |

## 8. 验收标准

1. `components/editors/container/` 下的 9 个编辑器各自有测试；页面里不再有"某关注点的表单实现"
2. `container-edit-dialog.tsx` 与创建页使用**同一套**编辑器，编辑容器可改端口/命令/探针/生命周期/安全上下文/存储
3. `pages/deployment-create-page.tsx` < 800 行；`editors/deployment-form.ts` 只做导出转发
4. 同一组表单输入的 YAML 输出与拆分前**逐字节一致**（快照对比通过）
5. `tsc` / `eslint` / `prettier` / `pnpm test` / `go test ./pkg/...` / `make e2e-test` 全绿

---

## 9. 影响范围核对（2026-09-18 逐条验证）

结论：方向成立，但有 4 处需要修正，另有 2 项建议单独决策。

### 9.1 与代码一致的判断

- §1 行数核对一致（2258 / 1219 / 671 / 490）；`container-edit-dialog.tsx` 现为 **155** 行（后来加了未保存草稿拦截）。
- 两个 `workload-container-*.tsx` 确实只有 `deployment-create-page.tsx` 一个引用者，搬移不会牵动其它页面。
- 反向依赖确实存在：`workload-container-sections.tsx` 从 `editors/deployment-form.ts` 取 `PortForm` / `PortServiceType`。
- §5 Phase 3 的写回判断成立：`deployment-detail.tsx:294`、`statefulset-detail.tsx:156`、`daemonset-detail.tsx:112` 都是「克隆 → 替换该容器 → 整对象 PUT」，在克隆体上打补丁不会清掉未建模字段。
- §4 约束 5 落地：创建页仍在用 `CommandListInput`；e2e 的 `resource-creation.spec.ts` / `resource-lifecycle.spec.ts` 都在。

### 9.2 需要修正的地方

1. **`editors/deployment-form.ts` 的兼容出口要处理两类符号，且引用者不止创建页**。除创建页外还有 5 个：
   - 只用**调度**那一半：`node-scheduling-section.tsx`、`node-scheduling-parts.tsx`、`create-resource-dialog.tsx`（`SchedulingConfig` / `defaultSchedulingConfig` / `emptySchedulingTerm` / `emptyToleration` / `genSchedulingId` / `SCHEDULING_OPERATORS` / `TolerationForm` / `SchedulingOperator`）；
   - 用**容器/表单**那一半：`editors/deployment-create-dialog.tsx`（`ContainerConfig` / `createDefaultContainer` / `DeploymentFormData` / `generateWorkloadYaml` / `initialFormData` / `validateStep` / `VolumeForm` / `WorkloadResourceType`）。

   所以 §3 的 `lib/workload/` 要么把调度也收进来（`scheduling-types.ts` / `scheduling-yaml.ts`），要么兼容出口同时保留两类 re-export；否则会漏改。

2. **Phase 3 的「编辑容器可改端口」不是纯容器编辑**。`PortForm` 带 `serviceType` / `servicePort` / `nodePort` / `clusterIP`，build 时同时写进容器 `ports`（`deployment-form.ts:353`）与 Service 的 `spec.ports`（`:497`）；而详情页的写回只替换 Pod 模板里的容器，**碰不到 Service**。因此要么做「只改容器端口」的降级版编辑器，要么把写回扩展到 Service（会牵动 3 个详情页与对应 RBAC 判定）。这一条必须在开工前选定。

3. **Phase 3 有两个编辑器需要额外上下文**：`PortsEditor` 需要 `workloadName`，`StorageMountsEditor` 需要 `volumes`（Pod spec 级）。当前对话框只接 `container`，要改 `ContainerEditDialog` 的数据契约，并同步 `container-info-card.tsx` / `container-table.tsx` 两个调用点。

4. **Phase 4 的「三段拆」不够**：`deployment-create-page.tsx` 里还有 10 个页面内局部组件（KVEditor、SectionMenu、SuffixedNumberField、QuantityField、StrategyFormView、BoxedInput、BoxedSelect、NetworkFormView、StorageFormView、PullSecretSelector）和 2 个页面组件（`DeploymentFormPage:226`、`DeploymentEditPage:1430`），只按 deployment/pod/container 拆达不到 <800 行目标，需要额外给这些字段组件一个落点（如 `pages/deployment-create/fields/`）。

### 9.3 两个额外事实（影响排期，建议单独决策）

- **这个页面不是「部署创建页」而是 6 种工作负载的共用表单**：`routes.tsx` 里有 **13 条路由**引用 `DeploymentCreatePage`（deployments / cronjobs / jobs / pods / daemonsets / statefulsets 的创建与编辑）。Phase 4 拆页面时，回归面是这 6 类 × 创建/编辑，不只是 Deployment。
- **`editors/deployment-create-dialog.tsx` 是死代码**：1000+ 行的另一套创建工作负载表单，目前**没有任何页面引用**，只在 `editors/index.ts` 里被 re-export。它与创建页职责重叠，建议先定它的去留（删或明确入口），否则 Phase 1/4「只改 import」会因为「不知道该不该同步改它」反复纠结。
- 另：调度相关的 YAML 读写（`applySchedulingToYaml` / `parseSchedulingFromYaml`）现在放在 `node-scheduling-section.tsx` 组件文件里，与 §1 发现 2 属同类问题，可一并下沉。

### 9.4 执行闸门：e2e 可以直接打真实集群（不需要 kind）

仓库已有「已有集群」模式，spec 也已按真实集群适配：资源建在 `default`、命名带 `zz-e2e-` 前缀、用例内自清理；工作负载用节点上已缓存的 SWR 镜像，不依赖外网。

```bash
make e2e-run-existing KUBECONFIG=~/.kube/config \
  E2E_CLUSTER_NAME=<context> E2E_CONTEXT_NAME=<context> E2E_NODE_NAME=<node> \
  SPEC="specs/resource-creation.spec.ts"
```

`AEROLINK_E2E_CONTEXT_NAME` 就是 Kite 导入后的集群名（spec 用它拼 API 路径）；节点名给 `node-operations` 用。**注意 `node-operations.spec.ts` 会 cordon/drain 节点，单节点集群上不要随手跑。**

**2026-09-18 实测基线**（对单节点 v1.32 真实集群，本轮变更的工作区）：

| spec | 结果 | 结论 |
| --- | --- | --- |
| `specs/resource-creation.spec.ts` | 4 通过 / 3 失败 | 3 个失败同源：helper `fillWorkloadForm` 用 `getByRole('button', { name: 'container-1' })`，而页面上它是 `role="tab"` → 容器面板没被展开，接着等「Container Name」输入框超时。**用例选择器过期，与应用代码无关**：Phase 0 需先修这一行（改为 `tab`）或把这三个用例排除在闸门外 |
| `specs/resource-lifecycle.spec.ts` | 10 通过 / 1 失败 | 稳定复现于 `:261`：YAML 页签 → Edit → 粘贴 → Save 之后，`env` 仍是旧值（期望 `two`，实得 `one`）。失败现场已留在 `e2e/test-results/…/error-context.md`（含截图与 trace）。该路径（`deployment-detail.tsx` 的 YAML 页签与编辑器）**不在本次改动范围内**，需要人看一眼截图/trace 定位，再判断是环境竞态（滚动更新期间页面每 1s 自动刷新）还是缺陷 |

也就是说：**Phase 0 的 e2e 闸门可用，但要先把这两处（3+1 条）弄绿或明确排除**，否则 Phase 1 的“纯搬移”无法判定是否回归。

### 9.5 其它约束

- `components/editors/*` 目前**零测试**（首批测试由 Phase 0/2 引入），所以 Phase 0 是先补地基再搬砖，顺序不能反。
- Phase 3 补齐编辑器后，对话框会明显变长，页签分组是必需项而不是可选项。
