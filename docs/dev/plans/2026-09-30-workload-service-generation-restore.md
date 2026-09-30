# 方案：恢复工作负载表单的 Service 配置与生成

- 状态：**已实现**（前端表单 + 生成/反解 + i18n + 单测）
- 触发：用户要求在 Deployment 创建页直接配置网络（Service 类型、监听端口、静态 IP），
  即恢复 `33c323d` 的实现；同时删除页面上的「关联的 Service」区块。

## 1. 背景

`33c323d`（Initial commit）的工作负载表单里，「网络」区每行可以选 Service 类型
（不创建服务 / ClusterIP / NodePort / LoadBalancer）、名称、监听端口、静态 ClusterIP，
底部一个「添加端口或 Service」按钮；保存时由 `deployment-form.ts` 的
`buildServiceDocuments` 把请求了 Service 的端口按类型分组，生成 `Service` 文档，
与工作负载一起组成多文档 YAML 提交。

`f8baa2f`（2026-09-20）按用户当时的要求删掉了这条路径（见
`2026-09-20-console-ux-and-notification-fixes.md` 第 2 节）：`PortForm` 只留
`name / containerPort / protocol`，新增 `associated-services.tsx` 在创建页只读展示
关联到的 Service 名称。

本次是**恢复**，不是重新发明：代码取自 `33c323d` 并适配当前 `deployment-form.ts`
（其后新增了 NFS / CSI 卷、编辑模式的合并逻辑等）。

## 2. 改动

### 2.1 表单数据层（`ui/src/components/editors/deployment-form.ts`）

- `PortForm` 恢复 `serviceType / servicePort / nodePort / clusterIP`，
  新增 `PortServiceType = 'none' | 'ClusterIP' | 'NodePort' | 'LoadBalancer'`。
- 恢复 `buildServiceDocuments(formData)`：按类型分组（同类型合成一个 Service，
  同 `containerPort` 去重），选择器取工作负载标签（`app` 缺省补成工作负载名）；
  ClusterIP 用工作负载名，其余类型用 `<名称>-<类型小写>`；静态 `clusterIP` 只写进 ClusterIP。
- `generateWorkloadYaml` 在存在 Service 时输出多文档（Service 在前、工作负载在后，
  与 `33c323d` 一致）。
- `parseYamlToFormData` 恢复「Service 文档 → 端口行」的反向映射
  （`serviceType / servicePort / nodePort`；静态 `clusterIP` 不回填，与旧实现一致）。

### 2.2 界面

- `workload-container-sections.tsx` 的 `PortsEditor` 恢复 Service 类型 / 名称 /
  私有容器端口 / 协议 / 监听端口 / 主机 IP 六列 + 「添加主机」「移除」，底部按钮改回
  「添加端口或 Service」（新增行默认 ClusterIP，可切到「不创建服务」）。
  NodePort 的合法范围仍按 kube-apiserver 的 `--service-node-port-range` 取，取不到时回落
  30000-32767。
- `deployment-create-page.tsx` 给 `PortsEditor` 传 `workloadName`（用于预览自动生成的
  Service 名称）。
- 删除创建页的「关联的 Service」区块、`podLabelRecord`，以及
  `ui/src/components/associated-services.tsx`（仅被该处使用）。
  Deployment 详情页的「暴露服务」与 Endpoints 卡片不受影响。
- i18n：恢复 / 新增 `containerAdv.*` 的 `serviceTypeLabel`、`serviceNameLabel`、
  `portNameAuto`、`servicePortLabel`、`nodePort`、`hostIPLabel`、`hostIP`、
  `nodePortAutoPlaceholder`、`listenPortPlaceholder`、`publicPortPlaceholder`、
  `svcNone`、`addHost`、`addPortOrService`、`clusterIPFormatError`、
  `servicePortRangeError`、`nodePortRangeError`、`networkHintFull`，以及
  `workloadWizard.networkSection`（提交校验的错误提示）；删除失效的 `networkHint`、
  `portNameHint`、`addPort` 与关联 Service 的 3 个键。zh / en 同步
  （`locales.test.ts` 断言两边键集合一致）。

## 3. 与旧实现的两处差异

1. **`applyEditedManifest` 改为按 kind 定位工作负载文档。** 旧实现把 Service 放在
   第一个文档，而编辑模式的合并逻辑是后来才有的（`mergeEditedManifest` 假定
   `docs[0]` 是工作负载）。若不动它，编辑工作负载时会把生成的 Service 和线上
   Deployment 叠在一起。现在按 `kind` 找到要合并的文档，其余文档原样保留。
2. **创建页拦住非法端口。** 原实现只在行内画红框，提交仍然放行：容器端口为空 /
   超范围时 `buildServiceDocuments` 会静默跳过该行——用户以为建了 Service，实际没有。
   现在 `isValid` 增加容器端口 1-65535 与 ClusterIP 格式（可留空）校验，错误提示归到
   「网络」这一项。NodePort 范围依赖集群配置，仍在组件里就地提示，不在页面拦。
   规则抽成 `isValidContainerPort` / `isValidClusterIP` / `hasInvalidPorts`，表单与组件
   共用一份，避免两处各判一套。
3. **反解时只认表单支持的三种 Service 类型。** 手写的 `ExternalName` 之类不会写进端口行，
   否则下拉框会出现一个不存在的选项。

## 4. 已知取舍（保持旧实现行为）

- 编辑模式下表单会重新生成 Service 文档并 apply，会覆盖该 Service 上表单未建模的字段
  （`sessionAffinity`、`externalTrafficPolicy` 等）。旧实现同样如此；需要精细修改 Service
  时仍走服务页或详情页 YAML。若要改，应另开一次改动引入「只增不改」策略。
- 静态 ClusterIP 不回填到表单，重存时按表单当前值生成。

## 5. 权限与失败路径

后端 `pkg/resources/apply_handler.go` 本来就是逐文档鉴权、逐文档写入：创建 Service 需要
`services` 的 `create`（或已存在时的 `update`）权限，缺失时该文档返回 403，前端按错误
提示展示，不会静默改工作负载之外的资源。

## 6. 验证

- `pnpm --dir ui exec vitest run src/components/editors/deployment-form.test.ts`
  （新增：按类型分组生成 Service、NodePort 写 nodePort、`serviceType: 'none'` 不生成、
  多文档反解回端口行、`applyEditedManifest` 只合并工作负载文档）。
- `pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json`。
- `pnpm --dir ui exec vitest run src/i18n`（zh / en 键集合一致）。
