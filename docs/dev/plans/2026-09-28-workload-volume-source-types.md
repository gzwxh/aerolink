# 方案：工作负载创建页的存储卷来源类型

- 状态：**已实现**（`tsc --noEmit`、`eslint`、`vitest` 通过；未做集群 dry-run，见 §5）
- 触发（2026-09-28）：参考 Rancher 的「添加卷」下拉，把
  `/statefulsets/:namespace/create?tab=pod` 「存储」面板的卷来源从 5 种补到 7 种，
  并把「类型」从行内下拉改成添加时选定。
- 相关：`ui/src/pages/deployment-create-page.tsx`（`StorageFormView`）、
  `ui/src/components/editors/deployment-form.ts`（`VolumeForm` / `buildVolumes` /
  `parseYamlToFormData` / `validateStep`）。

## 1. 交互

- 「添加卷」改成一个菜单，列出 7 种来源：
  空目录（`emptyDir`）、主机路径（`hostPath`，即 Bind-Mount）、`configMap`、密文（`secret`）、
  持久卷声明（`pvc`）、`NFS`、`CSI`。
- **类型在添加时确定**，行内不再给类型下拉：每张卷卡片只显示「类型名 + 该类型的字段 + 移除」，
  避免上一版那种「先加一个空卷、再在行内改类型」的两步操作（改类型后另一套字段会留在 YAML 里）。
- `hostPath` 多一个「路径类型」下拉，取值与 k8s 的 `HostPathType` 一一对应，
  文案沿用截图里的中文（任意路径 / 一个目录，如果该目录不存在则创建 / …）。
- `csi` 的驱动参数用键值对行编辑（「添加卷属性」）。

## 2. 字段与生成规则

| 类型 | 表单字段 | 生成的 `podSpec.volumes[]` |
| --- | --- | --- |
| `emptyDir` | 卷名称 | `emptyDir: {}` |
| `hostPath` | 卷名称、主机路径、路径类型 | `hostPath: { path, type? }` |
| `configMap` | 卷名称、ConfigMap 名称 | `configMap: { name }` |
| `secret` | 卷名称、Secret 名称 | `secret: { secretName }` |
| `pvc` | 卷名称、PVC 名称 | `persistentVolumeClaim: { claimName }` |
| `nfs` | 卷名称、NFS 服务器、共享路径、只读 | `nfs: { server, path, readOnly? }` |
| `csi` | 卷名称、CSI 驱动、文件系统类型、只读、卷属性 | `csi: { driver, fsType?, readOnly?, volumeAttributes? }` |

两处容易写错、这次专门盯住的点：

- **`hostPath` 的空 `type` 不写进 YAML**：空串就是 API 的默认值（不检查目标路径），
  写成 `type: ''` 会被拒绝。界面侧因为 Radix `Select` 不接受空字符串 `value`，
  用 `__none__` 哨兵在 UI 与空串之间转换。
- **Pod 级 CSI 卷没有 `volumeHandle`**（那是 PV / PVC 的字段），参数只能落在
  `volumeAttributes`（例如华为云 CSI 的 `volumeHandle`、`everest.io/disk-volume-type`）。
  键为空的属性行在生成时丢弃，否则会写出一个空键的 attribute。

## 3. 校验

- `validateStep(formData, 2)` 补上 `nfs`（服务器 + 共享路径）与 `csi`（驱动）的必填判定；
  这个函数此前是死代码，现在被创建页的 `isValid` 与提交前的缺项提示使用。
- 「添加卷」后字段没填完时，创建按钮直接不可用，并提示「『存储卷』是必填项」，
  而不是生成一个空来源等 API 报错。

## 4. 不做的事

- **in-tree 云盘类**（Amazon EBS / Azure 磁盘 / Azure 文件 / Google 持久磁盘 / vSphere）：
  Rancher 菜单里有，但这些 in-tree 卷插件在新集群已逐步移除，写出来的 YAML 在多数目标集群上
  是无效的。要用云盘的场景应走 CSI（或 PVC + StorageClass）。
- **「创建持久卷声明」**：需要额外生成一份 `PersistentVolumeClaim` 文档一起提交，
  而本页的生成函数只产出工作负载一个文档（Service 也是单独只读展示）。
  要建 PVC 走 `/persistentvolumeclaims` 的创建页。
- `emptyDir` 的 `medium` / `sizeLimit`：暂不需要。

## 5. 测试与验证

- 单元（`ui/src/components/editors/deployment-form.test.ts` 的「存储卷的生成与反向解析」）：
  `hostPath` 带/不带路径类型的输出形状、`nfs` 与 `csi` 的字段映射（含空键属性被丢弃）、
  以及「生成的 YAML 能原样读回表单」的往返断言。
- `parseYamlToFormData` 反向解析补齐了 `nfs` / `csi` / `hostPathType`：这之前 `nfs` 与 `csi`
  会被当成「表单不支持的卷」直接交给 `mergeEditedManifest` 从线上对象恢复，
  编辑已有工作负载时看不到、也没法改这两个卷。
- 未做：对真实集群的 `kubectl apply --dry-run=server`（上一轮
  `2026-09-20-storage-create-hardening.md` 用的是同一种方式，这次没跑）。
