# DaemonSet：创建与修改

DaemonSet 保证**每个（符合条件的）节点上都有一个 Pod**：新节点加入自动补，节点下线自动清。日志采集、监控 agent、CNI/CSI 这类"节点级"组件都用它。

## 创建入口

左侧「工作负载 → DaemonSets」→ 右上角「创建」；或用详情页「更多」→「克隆」。

节点数量由集群决定，所以**创建页没有「副本数量」这一栏**，也不该有。

## 顶部身份字段

![DaemonSet 创建页](/images/usage/create-daemonset.png)

| 字段 | 说明 |
| --- | --- |
| 命名空间 | 默认当前命名空间 |
| 名称 | 必填，创建后不可改 |
| 描述 | 写进注解 |

## 页签

页签是 **DaemonSet**、**Pod**、`container-1`(+「+ 添加容器」)、**编辑 YAML 并创建**。

### 标签 & 注释

Pod 模板标签生成 `spec.selector`。DaemonSet 的标签常被其他组件（比如网络插件）用 `app=xxx` 精确匹配，改名等于断链，别随手改。

### 扩缩容和升级策略

这个页签在 DaemonSet 上只显示一句「该资源类型不支持升级策略配置。」

也就是说：表单不提供 `updateStrategy`（`RollingUpdate` 的 `maxUnavailable`、`OnDelete`），需要时在「编辑 YAML 并创建」里写，或建完后在 YAML 页签里改。

## 让 Pod 只跑在部分节点上

DaemonSet 默认铺满所有节点。要限制范围，在 **Pod 页签**里配：

- **节点调度**：选「指定节点」写 `nodeName`，或选「匹配调度规则」用 `nodeSelector`——比如只在带 `node-role.kubernetes.io/edge` 标签的节点上跑。
- **Pod 调度**：`nodeSelector` 键值对。
- **资源**：容忍（`tolerations`）与优先级——节点级组件经常要容忍 `node-role.kubernetes.io/control-plane:NoSchedule`，否则 master 节点上不会起 Pod。

这两个区块在创建时就会写进 Pod 模板，之后改会触发滚动更新（逐个节点替换）。

## 建完之后

详情页按节点列出 Pod（每个节点一个）。可用动作：修改镜像版本、滚动重启、回滚、删除。**没有「暂停编排」**。

## 修改

| 改什么 | 怎么改 |
| --- | --- |
| 镜像、环境变量、探针、挂载、节点选择 | 行操作「编辑」进表单页 |
| 更新策略（`updateStrategy`） | 详情页「YAML」页签 |
| 只换镜像 | 行操作「修改镜像版本」 |

`spec.selector` 不可变；Pod 模板可变（改完按更新策略滚动）。删除 DaemonSet 会连带删掉它铺出去的所有 Pod，但不会动节点上的宿主机目录数据。
