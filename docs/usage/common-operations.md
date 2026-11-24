# 第 5 步：创建与常用操作

这一页是"想做什么 → 在哪做"的对照表，加上几个容易踩的坑。

## 创建资源

两个入口，先分清是建"标准类型"还是贴一份随手写的 YAML：

| 入口 | 能建什么 | 怎么用 |
| --- | --- | --- |
| 资源列表页右上角「创建」 | Deployment、StatefulSet、DaemonSet、Job、CronJob、Pod、Service、ConfigMap、Secret、PV、StorageClass、Namespace | 进入表单页，按页签填完点创建 |
| 顶栏「+」→「创建资源」 | 任意 Kind；「空模板」下可以一次贴多份 YAML（`---` 分隔，多个 Deployment / StatefulSet 等能同时创建） | 「空模板」：粘贴 YAML → 应用（命名空间写在 YAML 里）；选具体模板：载入该模板 → 按需选命名空间 → 应用 |

- 列表页的「创建」只在你有该资源的创建权限时出现；没权限时按钮不显示，直接打开表单页会提示「你没有权限在命名空间 X 中创建 Y」。
- 模板是**单选**：选中一份模板就会把它的 YAML 载入编辑器；要自己写（包括把多份文件拼在一起）就选「空模板」。
- 「空模板」是自由 YAML 模式：支持多文档（`---` 分隔），命名空间直接写在每个文档的 `metadata.namespace` 里，弹窗**不提供命名空间下拉**。一次应用会按顺序下发每份文档，成功下发多个对象时会提示「已下发 N 个资源」。
- 选了具体模板时才有命名空间下拉：选中的命名空间会写进 YAML；如果 YAML 里的 `metadata.namespace` 与它不同，页面会提示以所选命名空间为准。
- 多文档是逐份下发的，不是事务：中间某份失败不会回滚前面已经创建的对象。弹窗会提示已下发几个、失败的是哪份，留在弹窗里改完失败的部分再提交即可。
- 贴的是**单个文档**的工作负载（Deployment / StatefulSet / DaemonSet / ReplicaSet）时，弹窗里会多出「节点调度」区块，改它会同步进 YAML；多文档或其他 Kind 不显示这一区块。
- 弹窗里已经写了内容再关闭，会先确认一次，避免丢掉写了一半的 YAML。

### 弹窗示例

**空模板：自由 YAML 模式**（没有命名空间下拉，命名空间写在 YAML 里）

![创建资源弹窗：空模板模式，模板下方提示多文档用法，弹窗内没有命名空间下拉](/images/usage/create-resource-empty-template.png)

**选了具体模板**（载入模板 YAML，同时出现命名空间下拉）

![创建资源弹窗：选择 Deployment 模板后载入模板 YAML，右侧出现命名空间下拉与节点调度区块](/images/usage/create-resource-with-template.png)

### YAML 参考示例

**空模板：一次下发多个资源**

选「空模板」，把下面整段贴进弹窗。两份文档用 `---` 分隔，命名空间分别写在各自的 `metadata.namespace` 里，应用成功后会提示「已下发 2 个资源」：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: team-a
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
  namespace: team-b
spec:
  serviceName: db
  replicas: 1
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
        - name: postgres
          image: postgres:16
```

**选了具体模板：命名空间覆盖**

模板的 YAML 会原样载入编辑器；再在弹窗里选命名空间时，界面会把该命名空间写进每份命名空间级文档的 `metadata.namespace`（集群级资源不动）：

```yaml
metadata:
  name: example-deployment
  # 弹窗里选了 team-a 后，这里会被写成 team-a
  namespace: default
```

**几个容易踩的坑**

- 多份文档之间必须有 `---` 分隔行，否则会被当成一份非法清单。
- 每份文档都要有 `apiVersion`、`kind`、`metadata.name`，缺一项这一份就会失败。
- 空模板下没有命名空间下拉兜底，命名空间级资源请自己写 `metadata.namespace`。
- 拿不准时可以先在本地用 `kubectl apply --dry-run=client -f demo.yaml` 校验语法与字段，再粘进弹窗。

### 表单创建页怎么填

顶部常驻的是身份信息：名称、命名空间、Deployment / StatefulSet 的副本数、CronJob 的 Cron 计划、描述。下面的页签：

| 页签 | 内容 |
| --- | --- |
| 按 Kind 命名（Deployment / Job / CronJob…） | 标签 & 注释、扩缩容和升级策略；Job 与 CronJob 另有「任务参数」（失败重试次数、并行度、完成数） |
| Pod | 标签 & 注释、网络（可以顺手建 Service）、节点调度、Pod 调度、资源、扩缩容和升级策略、安全性上下文、存储 |
| 容器页签（页签名就是容器名，默认 container-1；「+ 添加容器」新增） | 通用（镜像、拉取策略、命令与参数、端口、环境变量）、健康检查、资源、安全性上下文、存储（卷挂载） |
| 编辑 YAML 并创建 | 表单生成的最终清单，可以直接改 |

- 表单和 YAML 是联动的：手改的 YAML 会原样应用，能被表单识别的字段会在约 1 秒后回填表单、之后以表单为准；表单没建模的字段则保留你写的内容。
- 底部按钮在创建模式是「创建 Deployment」这类文案，编辑模式是「保存」；点下去就是下发到集群，没有草稿。没填完时提示条会直接列出缺哪几项（名称、副本数量、容器镜像、标签……）。

### 每种资源各要填什么

按类型拆开的页面在「按资源类型创建与修改」一栏里，每页都带截图和该类型改不了什么：

| 类型 | 页面 |
| --- | --- |
| Deployment / StatefulSet / DaemonSet | [Deployment](/usage/create/deployment)、[StatefulSet](/usage/create/statefulset)、[DaemonSet](/usage/create/daemonset) |
| Job / CronJob | [Job](/usage/create/job)、[CronJob](/usage/create/cronjob) |
| Pod | [Pod](/usage/create/pod) |
| Service | [Service](/usage/create/service) |
| ConfigMap / Secret | [ConfigMap](/usage/create/configmap)、[Secret](/usage/create/secret) |

选型（该用哪种）见[按资源类型创建与修改 · 总览](/usage/create/)。这三个入口对所有类型都通用，细节在上面「创建资源」一节。

## 对照表

| 想做什么 | 在哪做 |
| --- | --- |
| 创建一个新对象 | 列表页「创建」；任意 Kind 用顶栏「+」→「创建资源」，见上文 |
| 照现有对象复制一份 | 详情页标题栏「更多」→「克隆」，改名后即生成新对象 |
| 只看 YAML | 行操作「查看 YAML」（只读弹窗）、详情页「YAML」页签 |
| 下载 YAML | 节点与命名空间的行操作里有「下载 YAML」；其他资源在「YAML」页签里复制 |
| 改 YAML | 详情页「YAML」页签，保存即应用，改动会进资源历史 |
| 加环境变量、改探针、挂卷、改更新策略 | 行操作「编辑」进表单页，见下文 |
| 只换镜像版本 | 行操作「修改镜像版本」，只提交被改动的镜像，不动其他字段 |
| 加标签 / 注解 | 行操作「管理标签」「管理注解」 |
| 扩缩容 | 工作负载行操作或详情页的「扩缩容」，见[下文](#扩缩容) |
| 让 Pod 重新拉起 | 工作负载的「滚动重启」 |
| 暂时停止滚动更新 | **Deployment** 行操作「暂停编排」，恢复时用「恢复编排」（StatefulSet / DaemonSet 没有这个动作） |
| 立刻跑一次 CronJob | CronJob 详情页标题栏「立即运行」 |
| 暂停 CronJob 调度 | CronJob 详情页标题栏「暂停」，恢复用「恢复」 |
| 批量改多个资源 | 列表勾选多行 → 批量动作 |
| 改完想退回上一版 | 工作负载详情页「历史」页签，对比差异后回滚 |
| 删除 | 行操作「删除」，有确认弹窗，见[危险操作](#危险操作) |
| 排查 Pod | Pod 的「事件」「描述」「调试」，见[第 4 步](./logs-terminal.md) |

写操作都需要对应权限：**没有权限时按钮不会出现**；如果提交后才被拒，界面会明确告诉你缺哪个资源的哪个动作。

## 表单编辑还是 YAML 编辑

| 场景 | 用哪个 |
| --- | --- |
| 加环境变量、改探针、挂卷、改副本数与更新策略 | 行操作「编辑」进表单页，字段有校验，最不容易写错 |
| 改表单没建模的字段（`serviceAccountName`、`topologySpreadConstraints` 等） | 详情页「YAML」页签 |
| 只换镜像 | 行操作「修改镜像版本」，只提交被改动的镜像 |

表单编辑有几条固定规则：

- 名称与命名空间锁定，改了就成另一个对象了；保存时会把改动叠到线上对象上，表单没建模的字段不会被清掉。
- `spec.selector` 是不可变字段，始终沿用线上的值，不要在表单里指望改它。
- Job 的 Pod 模板创建后不可变，所以 Job 没有「修改镜像」，编辑页只能改并行度、重试次数这类字段；要换镜像请重建 Job。
- Pod 的大部分字段同样不可变：编辑页顶部会提示，并告诉你这个 Pod 属于哪个 Deployment —— 去 Deployment 的编辑页改，改动会自动滚动到新 Pod。

## 编辑 YAML 时注意

- 保存就是 `kubectl apply`，**没有"暂存"这一步**，改错了只能靠历史回滚（保留期的长度由管理员配置）。
- 页面会做基本的格式校验，但**不会做语义校验**：字段名写错、缩进错、类型不匹配都可能直接写进集群。
- 建议先「查看 YAML」复制一份到本地留底，再改。
- 手改 `status`、`metadata.managedFields` 这类字段没有意义，可能被 API Server 拒绝。

![YAML 格式错误：编辑器上方会直接提示出错行列与原因](/images/usage/yaml-syntax-error.png)

## 修改镜像版本

只想发个新版本时用「修改镜像版本」，比改 YAML 安全：

- 只提交你改动的那几个容器的镜像，其他字段保持原样；
- 没改动镜像直接提交时，界面会提示没有变化、不会产生新版本；
- 改完工作负载会自动滚动更新，之后再回「历史」页签可以对比这次改动。

## 扩缩容

工作负载的行操作或详情页标题栏都有「扩缩容」，只改副本数：

- 输入必须是不小于 0 的整数，空值或非法值会被拦住。
- 缩到 0 副本会先提示「这个服务不会有任何运行中的 Pod，流量会全部中断」，勾选确认后按钮才会启用。
- 扩到较大副本数会提示确认集群资源是否足够；实际能否调度还受命名空间配额与节点资源限制。

![扩缩容：缩到 0 副本时的中断警告，勾选确认后才能提交](/images/usage/scaling-zero-warning.png)

## 危险操作

| 操作 | 风险 |
| --- | --- |
| 删除 Pod / 直接重启 | 会被控制器重新拉起；但单副本服务的这段时间就是中断 |
| 删除 Deployment / StatefulSet | 它管理的 Pod 一起消失，除非你确认不要了 |
| 删除命名空间 | 里面的**所有**资源都会被清理，包括 PVC 与数据；必须逐字输入命名空间名称才能确认 |
| 删除 PVC / PV | 存储数据可能不可恢复 |
| 改 Service / Ingress | 影响面是整个入口，改前先确认影响范围 |

::: warning 删除是不会提示备份的
确认弹窗里只会告诉你删什么。涉及数据的对象（PVC、命名空间、StatefulSet）请先在外部确认备份。
:::

![删除确认：列出要删除的对象，并要求输入名称后才能提交](/images/usage/delete-confirm.png)

## 改完怎么确认

1. 详情页「概览」看副本数与状态是否变成期望值；
2. 「事件」页签看有没有新的失败事件；
3. Pod 的「日志」看启动是否正常；
4. 「历史」页签确认这次改动记录在案（也方便后续回滚）。

## 下一步

如果操作被拒 → [第 6 步：权限不够怎么办](./permissions.md)。