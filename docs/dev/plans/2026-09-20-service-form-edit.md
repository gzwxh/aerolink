# 方案：Service 的表单编辑

- 状态：**已实现**（表单编辑 + 详情页入口；PV / StorageClass 同样需要，见 §6，尚未做）
- 触发：用户要求「所有能创建的都要能改」。工作负载、Pod、ConfigMap、Secret 已在前几轮补齐，
  Service 只有创建页 + 详情页的 YAML 标签页，字段基本改不动。

## 1. 现状与缺口

`/services/:namespace/create` 的表单（`ui/src/pages/service-create-page.tsx`）只能创建；
详情页 `ui/src/pages/service-detail.tsx` 没有编辑入口。改一个 Service 只能去 YAML 标签页手写。

## 2. 做法（与 ConfigMap / Secret 的编辑模式对齐）

- 路由 `services/:namespace/:name/edit` 复用同一个组件：有 `:name` 就是编辑
  （读回线上对象预填、身份字段锁定、权限改看 `update`、按钮变「保存」、保存后回详情页）。
- 详情页加「编辑」按钮（`canUpdate` 时才出现）。
- 表单数据层从页面抽到 `ui/src/lib/service-yaml.ts`（`ServiceFormData` / `initialData` /
  `generateServiceYaml` / `formFromService` / `mergeServiceUpdate` / `allowedServiceTypes`）：
  一是与 `pv-yaml.ts`、`storageclass-yaml.ts` 的既有约定一致，二是这些转换只有脱离页面才好单测。

## 3. 两个必须处理的坑（否则编辑会改坏线上对象）

### 3.1 不可变字段与「表单没建模的字段」要保住

表单只拥有 `type` / `selector` / `sessionAffinity` / `ports` / `externalName`，其余
（`clusterIP(s)`、`ipFamilies`、`ipFamilyPolicy`、`internalTrafficPolicy`、`healthCheckNodePort`…）
一旦丢掉，API 会以 `field is immutable` 直接拒绝，或者把配置悄悄抹掉。因此
`mergeServiceUpdate` 把表单算出的 spec **叠在线上 spec 之上**，`metadata` 同理
（只覆盖表单给的那部分，标签/注解不会被清掉）。

### 3.2 与工作负载相反：清空必须真的删掉

工作负载用的是「覆盖合并」，因为它的表单从不表达「删除」。Service 不一样：选择器删空
（无选择器的手动 Endpoint Service / headless Service）是有意义的改动。所以
`mergeServiceUpdate` 对 `selector` / `sessionAffinity` / `externalName` 额外做一次
「生成结果里没有就 delete」——只做覆盖合并的话，选择器永远删不掉。

## 4. 顺带修掉的两个数据损坏问题

1. **具名 targetPort 被顶成数字。** 表单的 targetPort 输入框是 `type="number"`，且生成时写
   `intOrNull(targetPort) ?? port`：`targetPort: http` 这种具名端口会被静默替换成 `port` 的数字。
   创建页上只是「用户自己填错」，但编辑一个**已有**的具名端口 Service 就是直接改坏线上对象。
   现在输入框改为文本、`resolveTargetPort` 原样保留名字，并校验名字符合 IANA_SVC_NAME
   （小写字母/数字/`-`，最长 15 字符）。
2. **LoadBalancer 的 nodePort 被抹掉。** 生成 spec 时只在 `type === 'NodePort'` 时带 `nodePort`，
   而表单在 LoadBalancer 下不显示这一栏 → 编辑一次 LoadBalancer，提交上去的端口没有
   `nodePort`，等于请求重新分配一批新端口。现在 NodePort / LoadBalancer 两种类型都会把
   预填的值带回去（ClusterIP 带 nodePort 是非法的，仍然不带）。
3. **类型转换被提前拦住。** ExternalName 与其他类型之间不能互转（API 报
   `may not change type`），编辑时该下拉只放行兼容的那几个值，并给一句说明。

## 5. 测试

- 单元（`ui/src/lib/service-yaml.test.ts`，7 条）：具名 targetPort 往返、空 targetPort 回落 port、
  LoadBalancer 带 nodePort 而 ClusterIP 不带、线上对象预填不丢信息、合并保住不可变字段与
  标签/注解、清空的字段真的消失（含 externalName）、ExternalName 类型锁定。
- e2e（`e2e/specs/resource-edit.spec.ts` 新增一条，本地集群实跑）：种一个带标签/注解、
  具名 `targetPort: http` 的 Service → 从详情页进编辑页 → 改端口 80 → 8080 → 保存，
  断言端口改了、`clusterIP` 不变、标签/注解都在、`targetPort` 仍是 `http`。
- 反证（逐条关掉改动，确认对应用例失败，再还原）：
  - 把具名 targetPort 当数字 → 2 条失败（含往返那条）；
  - 去掉「清空即删除」→ 「清空的字段在合并后真的消失」失败；
  - 不再从线上对象带字段 → 「保留不可变字段、标签与注解」失败。

## 6. 还没做：PV 与 StorageClass（用户已确认都要做）

两者的不可变面比 Service 更大，需要单独设计：

- **PersistentVolume**：`capacity` 只能增、`volumeMode`/`accessModes` 部分不可变、
  各 `persistentVolumeSource` 互斥且不可变、`claimRef` 决定绑定状态。
  有效的表单编辑基本只剩「标签/注解 + 回收策略 + 挂载参数」，所以要先把「可改 vs 只读」
  在界面上讲清楚。
- **StorageClass**：`provisioner` / `parameters` 创建后**完全不可变**（改只能新建一个），
  可改的只有 `reclaimPolicy`、`volumeBindingMode`、`allowVolumeExpansion`、`mountOptions`、
  `allowedTopologies` 与默认类注解。所以编辑页应当把 provisioner/parameters 显示为只读。

在此之前这两类仍可用详情页的 YAML 标签页修改。
