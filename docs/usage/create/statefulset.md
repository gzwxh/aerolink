# StatefulSet：创建与修改

StatefulSet 管有状态的 Pod：每个 Pod 有固定名字（`<名称>-0`、`<名称>-1`…）、稳定的网络标识和独立的存储，扩缩容与升级按序号顺序进行。

## 创建入口

左侧「工作负载 → StatefulSets」→ 右上角「创建」；或用详情页「更多」→「克隆」按现有对象复制。

![StatefulSets 列表：① 命名空间筛选 ② 搜索 ③ 创建 ④ 行操作](/images/usage/sts-list-guided.png)

列表看「就绪 / 可用」列确认副本；StatefulSet 的 Pod 名是 `<名称>-0`、`-1` 递增。

## 顶部身份字段

![StatefulSet 创建页：① 命名空间 ② 名称 ③ 副本数 ④ 服务名称 ⑤ 页签行 ⑥ 创建按钮](/images/usage/create-statefulset-form-guided.png)

图上编号：① 命名空间 ② 名称 ③ 副本数 ④ 服务名称（governing Service）⑤ 页签行 ⑥ 创建按钮。

| 字段 | 说明 |
| --- | --- |
| 命名空间 | 默认当前命名空间 |
| 名称 | 必填，创建后不可改 |
| 副本数量 | 目标 Pod 数，默认 1 |
| 服务名称 | governing Service，通常是一个 Headless Service；不选则用负载名 |
| 描述 | 写进注解 |

**服务名称要当回事**：StatefulSet 靠它给每个 Pod 一个稳定的 DNS 名（`<pod>.<service>.<ns>.svc`）。留空时会写成与负载同名，这要求你另外有一个同名 Headless Service（`clusterIP: None`），否则 Pod 之间按名字互访会失败。

## 页签

页签是 **StatefulSet**、**Pod**、`container-1`(+「+ 添加容器」)、**编辑 YAML 并创建**。Pod 与容器页签的字段与 Deployment 一致，见[表单创建页怎么填](/usage/common-operations#表单创建页怎么填)。

### 标签 & 注释

Pod 模板的标签会生成 `spec.selector`，改标签会让选择器和已有 Pod 对不上，谨慎动。

### 扩缩容和升级策略

| 界面上的字段 | 对应字段 | 说明 |
| --- | --- | --- |
| 滚动升级 / 删除重建 | `RollingUpdate` / `OnDelete` | 滚动升级按序号从大到小逐个更新；「删除重建」= 只在你手动删 Pod 后才按新模板建 |
| 分区（partition） | `rollingUpdate.partition` | 滚动升级时保留的序号上限：只更新序号小于它的 Pod，用来灰度 |
| 最小缩短时长 | `minReadySeconds` | 单位秒 |
| 修订历史记录限制 | `revisionHistoryLimit` | 回滚能退几版 |

StatefulSet 没有 Deployment 那种「最大 Pod 数量 / 最大不可用数量」，也没有「进展截止时间」——它按序号一个一个来。

## 特殊之处

- **Pod 名有序**：`web-0`、`web-1`…删除后重建还是同一个名字。
- **启停有序**：默认按序号从小到大启动、从大到小停止（`podManagementPolicy` 表单不建模，需要时走 YAML）。
- **每 Pod 独立存储**：靠 `volumeClaimTemplates` 实现。表单里的「存储」只支持 emptyDir、hostPath、ConfigMap、Secret 四种卷，没有 PVC；要每个 Pod 自动申请一块盘或挂已有 PVC，请在「编辑 YAML 并创建」里写。

## 建完之后

详情页会按序号列出 Pod。可用动作：修改镜像版本、滚动重启、回滚、扩缩容、删除。**没有「暂停编排」**——那是 Deployment 专属。

## 修改

| 改什么 | 怎么改 |
| --- | --- |
| 副本数、镜像、环境变量、探针、挂载、升级策略 | 行操作「编辑」进表单页 |
| `volumeClaimTemplates`、`podManagementPolicy`、`serviceName` | 只能在 YAML 里看，改不了 |
| 只换镜像 | 行操作「修改镜像版本」 |

改不了的（Kubernetes 层面就不可变，API 会直接拒绝）：

- `spec.serviceName`、`spec.selector`、`spec.podManagementPolicy`、`spec.volumeClaimTemplates`。
- Pod 的存储卷要在 StatefulSet 上改 PVC 模板；已经建出来的 PVC 不会跟着缩容一起删。

真要动这些字段，只能删掉 StatefulSet 重建（数据在 PVC 里，注意 `Retain` 策略）。
