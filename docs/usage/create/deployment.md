# Deployment：创建与修改

Deployment 管一组无状态的 Pod：声明副本数，它负责把集群里的 Pod 数量维持在目标值。滚动升级、回滚、暂停/恢复编排、扩缩容都基于它。

## 创建入口

左侧「工作负载 → Deployments」→ 右上角「创建」。按钮只在你有 `deployments` 的创建权限时出现；直接打开创建页会被拦下并提示缺哪个命名空间的什么权限。

想照着现有 Deployment 改一个出去，用详情页标题栏「更多」→「克隆」，表单会预填原对象的值。

![Deployments 列表：① 命名空间筛选 ② 搜索 ③ 创建 ④ 行操作](/images/usage/deploy-list-guided.png)

列表看「就绪 / 可用 / 健康」三列判断副本是否正常，行末「⋯」里是编辑、扩缩容、删除等动作。

## 顶部身份字段

![Deployment 创建页：① 命名空间 ② 名称 ③ 副本数 ④ 页签行 ⑤ 容器镜像 ⑥ 创建按钮](/images/usage/create-deploy-form-guided.png)

图上编号：① 命名空间 ② 名称 ③ 副本数 ④ 页签行（Deployment / Pod / 容器）⑤ 容器镜像 ⑥ 创建按钮。

| 字段 | 说明 |
| --- | --- |
| 命名空间 | 默认当前命名空间，可在顶部切换 |
| 名称 | 必填，填了就不能在这个表单里改 |
| 副本数量 | 目标 Pod 数，默认 1；`0` 表示先建出来不跑 |
| 描述 | 写进对象的注解，列表和详情里都会显示 |

## 页签

底部页签是：**Deployment**、**Pod**、`container-1`（页签名就是容器名）、**+ 添加容器**、**编辑 YAML 并创建**。

容器页签长这样（镜像、拉取策略、命令、端口都在这一页）：

![Deployment 创建页：容器页签](/images/usage/create-deployment.png)

Pod 页签与容器页签的字段见[表单创建页怎么填](/usage/common-operations#表单创建页怎么填)，这里只讲 Deployment 页签。

### 标签 & 注释

![Deployment 页签：标签与注释](/images/usage/create-deployment-labels.png)

- 这里是 `metadata.labels` / `annotations`。
- **Pod 标签同时是选择器**：表单用 Pod 模板的标签生成 `spec.selector.matchLabels`，页面会显示「当前选择器匹配 N 个 Pod」。
- 不填 `app` 标签时，会用负载名补上——Service 就是靠这个标签找到 Pod 的。要保持可被 Service 选中，标签别乱改。

### 扩缩容和升级策略

同一个页签往下是升级策略：

| 界面上的字段 | 对应字段 | 说明 |
| --- | --- | --- |
| 滚动升级 / 重置创建 | `RollingUpdate` / `Recreate` | 默认滚动升级；「重置创建」是先把 Pod 全停掉再起新的 |
| 最大 Pod 数量 | `maxSurge` | 滚动时允许多起几个，可填数字或百分比 |
| 最大不可用数量 | `maxUnavailable` | 滚动时允许多少个不可用，可填数字或百分比 |
| 最小缩短时长 | `minReadySeconds` | Pod 就绪后再等多久才算可用，单位秒 |
| 修订历史记录限制 | `revisionHistoryLimit` | 回滚能退几版 |
| 进展截止时间 | `progressDeadlineSeconds` | 多久没进展就标记失败，单位秒 |

选「重置创建」时，「最大 Pod 数量」和「最大不可用数量」会隐藏——它不并发起新 Pod，这两个值没有意义；其余三项照旧。

### 顺手建 Service

容器页签的**端口**里勾上「生成 Service」，一次提交会连带建出 Service（同一份 YAML 的多文档）：

| 勾选的服务类型 | 生成的 Service 名 |
| --- | --- |
| ClusterIP | 与 Deployment 同名 |
| NodePort | `<名称>-nodeport` |
| LoadBalancer | `<名称>-loadbalancer` |

之后再改端口、取消勾选，保存时会清理掉不再被引用的那几个 Service。

## 建完之后

提交成功后跳到这个 Deployment 的详情页，可以直接看到滚动出来的 Pod。常用动作都在行操作和详情页标题栏：

- 「修改镜像版本」：只提交被改的镜像，不动其他字段。
- 「滚动重启」：逐个替换 Pod，不改配置。
- 「暂停编排」/「恢复编排」：冻结滚动更新，方便连续改几处再一起放量。
- 「回滚」：挑一版历史退回去。
- 「编辑」：扩缩容就是在这里改「副本数量」。

## 修改

| 改什么 | 怎么改 |
| --- | --- |
| 副本数、镜像、环境变量、探针、挂载、更新策略 | 行操作「编辑」进表单页 |
| 表单没建模的字段（`serviceAccountName`、`topologySpreadConstraints`…） | 详情页「YAML」页签 |
| 只换镜像 | 行操作「修改镜像版本」 |

表单编辑的固定规则：

- 名称与命名空间锁定，改了就成另一个对象。
- `spec.selector` 不可变，表单始终沿用线上的值；改 Pod 标签不会改选择器，但会让 Service 选不中 Pod，动标签前先想清楚。
- 保存是把改动叠到线上对象上，表单没建模的字段保持原样。

![Deployment 编辑页：名称与命名空间已锁定](/images/usage/edit-deployment.png)

## 删除时的连带动作

删除 Deployment 时，如果有 Service 的选择器指向它，弹窗会提示这些 Service 也会被一起删掉。只想删负载、保留 Service 的话，先改 Service 的选择器。
