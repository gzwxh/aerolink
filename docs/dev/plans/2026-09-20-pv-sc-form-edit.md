# 方案：PersistentVolume 与 StorageClass 的表单编辑（只放行真正可变的字段）

- 状态：**已实现**
- 前置：`docs/dev/plans/2026-09-20-service-form-edit.md`（Service 的编辑模式与「不可变字段」处理）
- 用户口径：这两类「都需要实现」，并且**只放行真正可变的字段**——不可改的字段在界面上置灰，
  而不是让人白填一遍再被 API 拒绝。

## 1. 先做了一件事：实测哪些字段真能改

这两类资源的不可变面比 Service 大得多，而文档（包括本仓库之前的假设）与实际**不一致**。
所以先用 `kubectl patch` 在真实集群（k8s 1.32）逐字段试了一遍，结论以 API 的答复为准：

| StorageClass 字段 | 结果 |
| --- | --- |
| `provisioner` | ❌ `Forbidden: updates to provisioner are forbidden` |
| `parameters` | ❌ `Forbidden: updates to parameters are forbidden` |
| `reclaimPolicy` | ❌ `Forbidden: updates to reclaimPolicy are forbidden`（**与直觉相反**） |
| `volumeBindingMode` | ❌ `Invalid value ...: field is immutable` |
| `allowVolumeExpansion` / `mountOptions` / `allowedTopologies` / 元数据（含默认类注解） | ✅ |

| PersistentVolume 字段 | 结果 |
| --- | --- |
| 卷来源（`hostPath` / `nfs` / `csi` / …） | ❌ `spec.persistentvolumesource: Forbidden` |
| `volumeMode` | ❌ `field is immutable` |
| `capacity`（1Gi→2Gi 实测通过）/ `accessModes` / `persistentVolumeReclaimPolicy` / `mountOptions` / `nodeAffinity` / 元数据 / `claimRef` / `storageClassName` | ✅ |

## 2. 因此界面上的可变集合（比 API 允许的更窄，理由都在下面）

| 资源 | 可编辑 | 置灰（创建后不可变） |
| --- | --- | --- |
| StorageClass | 允许扩容、默认类标记、挂载选项、允许的拓扑 | Provisioner、参数、回收策略、卷绑定模式 |
| PersistentVolume | 容量（可增）、访问模式、回收策略、挂载参数 | 卷来源、卷模式、存储类、预绑定（claimRef） |

**刻意没有放行** `storageClassName` / `claimRef` / `nodeAffinity`（PV）——虽然 API 允许改。
理由是它们属于**绑定语义**而不是「卷的参数」：改 `claimRef` 等于预绑定/解绑（卷会变成
Bound/Released），改 `storageClassName` 会让卷与 SC 的归属错乱，改 `nodeAffinity` 会影响
调度可达性。在列表页顺手改这几个东西的风险远大于收益。要改仍然走详情页的 YAML 标签页
（界面上有提示），而 `accessModes` / `capacity` / 回收策略 / 挂载参数这些「静态卷常见的手工修正」
留在表单里。

## 3. 实现

- 路由：`persistentvolumes/:name/edit`、`storageclasses/:name/edit`（集群级，没有命名空间段）。
- 入口：列表页最右列的「操作」菜单 → 编辑。这两类的详情页是通用页（`SimpleResourceDetail`，
  没有 header 按钮），所以列表菜单是主入口；`resource-row-actions.tsx` 里给集群级资源的
  路径去掉了命名空间段（靠 `metadata.namespace` 是否为空判断）。
- 表单复用创建页：同一个组件靠 `:name` 切模式（读回线上对象预填、名称锁定、按钮变「保存」、
  权限看 `update`）。
- **置灰用 `<fieldset disabled={isEdit}>` 包住不可变字段所在的区块**：一处开关管住里面所有
  输入（含 Radix 的 Select 触发器与 Checkbox），比逐字段加 `disabled` 少漏、少改。
  可变的字段必须放在 fieldset 外面——PV 页因此有两个 fieldset（存储类/卷模式、卷来源/预绑定），
  挂载参数夹在两者之间。
- 提交时只取可变字段：`pvUpdateFromForm` / `storageClassUpdateFromForm` 把表单值叠到
  **线上对象**上（PUT 是整体替换，漏一个字段就等于删掉它）。

## 4. 容易踩的边界（都写了用例）

1. **`mountOptions` 清空要真的删掉**：沿用线上对象的话用户永远删不掉。
2. **`capacity` 不能整段替换**：里面可能还有 `iops` 这类扩展资源，只覆盖 `storage` 一项。
3. **卷来源不在表单支持范围时**（rbd、iscsi、gcePersistentDisk…）：表单那四个输入框显示不出来，
   编辑页给一条红色提示并指向 YAML 标签页，而不是渲染一堆空值让人误以为卷没有来源。
4. **allowedTopologies 一个 term 多个表达式**：表单那行 `key=v1,v2` 的简写表达不出来。
   解析结果为空时**保持线上原值**（`keepExistingTopologies`），并提示去 YAML 改；不能因为
   「表单里没有」就把线上拓扑清掉。
5. **默认类注解**是元数据而不是 spec：勾选框要显式加/删这条注解，不能只做「有就写」。
6. **标签/注解**不是表单字段，合并时整体从线上对象带过去（否则保存一次会把标签清空）。

## 5. 测试

- 单元（`ui/src/lib/pv-yaml.test.ts` 15 条 / `storageclass-yaml.test.ts` 18 条，含本次新增）：
  - 预填不丢信息（含 nodeAffinity 里的本地卷节点名）；
  - **不可变字段一个字都不动**（SC 那条甚至故意把 provisioner/parameters/回收策略/绑定模式
    在表单里改成别的值，断言提交结果仍是线上原值）；
  - 可变字段按表单生效、清空即删除；`capacity` 的 `iops` 保留；复杂拓扑保持原值；
  - `volumeSourceOf` 对不支持的来源返回 null。
- e2e（`e2e/specs/storage-creation.spec.ts`，本地集群实跑，7 passed）：种一个把不可变字段都设成
  非默认值的对象 → 进编辑页 → 改容量/回收策略（PV）与扩容/挂载选项（SC）→ 保存，
  断言可变字段变了、**不可变的四项与自定义标签都还在**；顺带断言不可变输入真的 `toBeDisabled()`、
  可变的可以输入。
- 列表入口 e2e（`e2e/specs/list-row-actions.spec.ts`）：PV / StorageClass 列表也有操作列，
  且「操作」是**最后一列**。
- 反证：去掉 fieldset 上的 `disabled={isEdit}` → e2e 的 `toBeDisabled()` 断言失败；
  把 `storageClassUpdateFromForm` 里的不可变字段改成跟随表单 → 「不可变字段一个字都不动」失败。

## 6. 后续

- PV / SC 的详情页仍是通用页，没有详情页上的「编辑」按钮；要补的话得给
  `SimpleResourceDetail` 加一个「当前资源支持表单编辑」的判定。
- PVC（PersistentVolumeClaim）没有做编辑：它的 `spec` 几乎全部不可变（只有
  `resources.requests.storage` 能增、`volumeAttributesClassName` 可改），收益很小。
