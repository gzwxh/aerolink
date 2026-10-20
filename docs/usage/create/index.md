# 按资源类型创建与修改

上一页[创建与常用操作](/usage/common-operations)讲的是通用的入口、表单结构和编辑规则；这一组页面按资源类型分开讲：**某一类资源要填什么、创建后长什么样、以后还能改什么**。

## 先选对类型

| 你的需求 | 用哪种 | 页面 |
| --- | --- | --- |
| 跑无状态服务：Web、API、网关，需要副本、滚动升级、回滚 | Deployment | [Deployment](./deployment.md) |
| 有状态服务：需要稳定的 Pod 名、稳定的存储、按顺序启停 | StatefulSet | [StatefulSet](./statefulset.md) |
| 每个节点（或每类节点）都要跑一份：日志采集、监控 agent、网络插件 | DaemonSet | [DaemonSet](./daemonset.md) |
| 跑一次就结束的任务：数据迁移、批处理 | Job | [Job](./job.md) |
| 按时间表重复跑的任务：定时备份、定时清理 | CronJob | [CronJob](./cronjob.md) |
| 临时排查、手工跑一个容器；或对象本身就长这样 | Pod | [Pod](./pod.md) |
| 给一组 Pod 一个固定访问入口 / 对外暴露端口 | Service | [Service](./service.md) |
| 存配置、环境变量、挂载的配置文件 | ConfigMap | [ConfigMap](./configmap.md) |
| 存口令、证书、镜像仓库凭证 | Secret | [Secret](./secret.md) |

::: tip 裸 Pod 与工作负载的区别
Pod 是最小调度单位。直接建 Pod 没有控制器管它：节点挂了、进程退了，不会有人拉起一个新的。日常请建 Deployment / StatefulSet / DaemonSet / Job / CronJob，让它们去管 Pod。
:::

## 三类创建入口都适用

下面每页讲的是**表单创建页**。另外两个入口对所有类型通用：

- 顶栏「+」→「创建资源」：贴任意 Kind 的 YAML，可多文档（`---` 分隔）。
- 详情页「更多」→「克隆」：拿现有对象当模板，改名后生成新对象（9 类都有）。

两个入口的细节见[创建与常用操作](/usage/common-operations#创建资源)。

## 每页都会讲到的三件事

1. **入口**：从哪个列表进、按钮叫什么。
2. **填什么**：顶部身份字段、按 Kind 命名的页签、Pod 页签、容器页签各自的关键项。
3. **建完怎么改**：表单编辑 / 改镜像 / YAML 三条路，以及哪些字段改不了（`spec.selector`、Job 的 Pod 模板、Pod 的大部分字段……）。

共享的规则（表单与 YAML 联动、必填提示、编辑时名称和命名空间锁定）在[表单创建页怎么填](/usage/common-operations#表单创建页怎么填)与[表单编辑还是 YAML 编辑](/usage/common-operations#表单编辑还是-yaml-编辑)，这里不重复。
