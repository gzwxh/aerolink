# 跟着做：把一个应用部署上线

这一页把「部署一个应用」拆成照着做就行的小步骤：建好 → 确认成功 → 看日志 → 出问题怎么查 → 对外暴露 → 发新版本。全部截图都来自真实界面。

## 先选对部署类型

| 你要跑的东西 | 用 | 为什么 |
| --- | --- | --- |
| Web、API、网关等无状态服务 | Deployment | 副本随意扩缩，支持滚动升级与回滚 |
| 数据库、中间件等有状态服务 | StatefulSet | Pod 名固定、存储独立、按顺序启停 |
| 每个节点都要跑一份（日志采集、监控 agent） | DaemonSet | 每个节点自动起一个 Pod |
| 跑一次就结束（迁移、批处理） | Job | 结束即完成，不常驻 |
| 按时重复跑（定时备份、清理） | CronJob | 按 Cron 表达式生成 Job |

每种类型的表单字段见[按资源类型创建与修改](./create/)，这一页用 Deployment 走完全程。

## 第 1 步：准备两样东西

1. **镜像地址**：问开发或看发布记录，格式是 `镜像名:版本`，例如 `nginx:1.27`。**不要用 `latest`**——出问题时无法判断跑的是哪一版。
2. **命名空间**：问管理员你的应用该放哪个命名空间（比如 `payment`、`team-a`）。放错命名空间等于部署到了别的项目里。

## 第 2 步：创建 Deployment

左侧栏「工作负载 → Deployments」→ 右上角「创建」，按图填：

![创建 Deployment 表单：① 命名空间 ② 名称 ③ 副本数 ④ 页签行 ⑤ 容器镜像 ⑥ 创建按钮](/images/usage/create-deploy-form-guided.png)

| 编号 | 填什么 | 说明 |
| --- | --- | --- |
| ① | 命名空间 | 选第 1 步确认的那个 |
| ② | 名称 | 必填，例如 `web`；同一命名空间里不能重名 |
| ③ | 副本数 | 先填 1 或 2；跑起来后再扩 |
| ④ | 页签行 | Deployment（标签与策略）/ Pod / 容器，容器页签里填镜像 |
| ⑤ | 容器镜像 | 必填，格式 `镜像名:版本` |
| ⑥ | 创建 Deployment | 点下去就下发到集群，没有草稿 |

表单里其他字段都可以先用默认值；要加环境变量、端口、资源限制，切到对应页签补。

## 第 3 步：确认部署成功

回到 Deployments 列表，看三列：**就绪**（如 `2/2`）、**可用**、**健康**（绿色条）。都对了就说明副本全部起来了：

![Deployments 列表：① 命名空间筛选 ② 搜索 ③ 创建 ④ 行操作](/images/usage/deploy-list-guided.png)

再点名称进详情页确认：

![Deployment 详情页：① 面包屑 ② 操作按钮 ③ 页签 ④ 概览卡片 ⑤ Pod 列表 ⑥ 事件与相关资源](/images/usage/deploy-detail-demo-guided.png)

| 编号 | 看什么 | 正常表现 |
| --- | --- | --- |
| ④ | 状态与副本 | 状态「可用」，就绪 `2/2` |
| ⑤ | Pod 列表 | 每个 Pod 都是「运行中」，重启次数 0 |
| ⑥ | 右侧事件 | 有 `ScalingReplicaSet` 这类正常事件；没有红色 Warning 更好 |

## 第 4 步：看日志确认程序真的起来了

Pod 列表里点一个 Pod → 页头「日志」：

![Pod 日志页：① 页头「日志」入口 ② 终端工作区标签 ③ 过滤框 ④ 搜索高亮与下载](/images/usage/pod-logs-demo-guided.png)

看到启动成功的日志（监听端口、初始化完成）就说明应用正常；日志一直为空时先确认容器选对了、程序确实往 stdout 打日志。完整用法见[日志与容器终端](./logs-terminal.md)。

## 第 5 步：部署失败怎么查 {#deploy-failure}

按顺序看：**列表状态 → 事件页签 → 日志（上一个容器日志）→ YAML**。

![事件页签：① 事件页签 ② 事件表（原因 + 消息）](/images/usage/deploy-events-demo-guided.png)

| 你看到的状态 | 大概率原因 | 先查什么 |
| --- | --- | --- |
| `ImagePullBackOff` / `ErrImagePull` | 镜像地址写错、镜像不存在、仓库拉取不了 | 镜像名与 tag 是否对；镜像仓库地址是否可访问 |
| `CrashLoopBackOff` | 容器启动后立刻退出 | 日志里的报错；启动命令与配置 |
| `Pending` | 没有节点放得下 | 事件里的调度失败原因；资源请求是否过大 |
| `OOMKilled` | 内存超限被杀 | 容器「资源」里的内存上限；程序内存占用 |
| 一直 `ContainerCreating` | 镜像拉取慢或存储挂载中 | 事件里的 Pulling / FailedMount |

更多排查路径见[Pod 起不来怎么查](./logs-terminal.md#pod-not-starting)。

## 第 6 步（可选）：对外暴露访问

Deployment 起来的 Pod 只在集群内。要让别的服务访问，建一个 Service：

![创建 Service：① 命名空间 ② 服务名称 ③ 服务类型 ④ 选择器 ⑤ 端口 ⑥ 创建按钮](/images/usage/create-service-form-guided.png)

- **选择器**填 Pod 的标签（常见 `app=web`），页面会提示匹配到几个 Pod；匹配为 0 时流量找不到后端。
- **端口**是 Service 暴露的端口，**目标端口**是容器实际监听的端口，两者别写反。
- 只需要集群内访问选 `ClusterIP`；节点端口访问选 `NodePort`；需要云厂商负载均衡器选 `LoadBalancer`。

## 第 7 步：发新版本与回滚

| 想做什么 | 怎么做 |
| --- | --- |
| 只换镜像版本 | 行操作「修改镜像版本」，只提交改动的镜像 |
| 改环境变量 / 探针 / 资源 | 行操作「编辑」，表单里改，改动会滚动到新 Pod |
| 看这次改了什么 | 详情页「历史」页签，对比差异 |
| 退回上一版 | 「历史」页签里选目标版本 → 回滚 |

回滚的细节见[资源历史](../features/resource-history.md)。

## 其他类型的入口差异

- **StatefulSet**：表单多一个「服务名称」（governing Service），要配一个 Headless Service；其余与 Deployment 相同。创建页见[StatefulSet](./create/statefulset.md)。
- **DaemonSet**：没有副本数，每个节点自动一份。创建页见[DaemonSet](./create/daemonset.md)。
- **Job**：跑完即结束；失败重试次数、并行度在「任务参数」里。创建页见[Job](./create/job.md)。
- **CronJob**：多一个「计划（Cron）」字段，如 `*/5 * * * *`；创建页见[CronJob](./create/cronjob.md)。

## 下一步

- 部署完要改配置：[创建与常用操作](./common-operations.md)
- 要下载文件或导出数据：[下载与上传](./downloads.md)
- 界面上的词不认识：[名词解释](./glossary.md)