# 功能详解

这一组页面按**功能**拆开讲：每页只讲一个能力——怎么用、有什么限制、依赖哪些配置。适合已经能走完日常流程、想深挖某个入口的人。

第一次上手、只想把操作做完，先看[使用指南](/usage/)（六个步骤，约 15 分钟）；要部署、要接集群、要配权限，看[安装部署](/)与[管理配置](/config/)。

| 想解决的问题 | 页面 |
| --- | --- |
| 按名字、标签快速找到任意资源 | [全局搜索](./global-search.md) |
| 从 Deployment 跳到它的 Pod、从 Service 跳到后端 | [相关资源](./related-resources.md) |
| 看 Pod 日志、过滤与高亮 | [日志](./logs.md) |
| 看集群指标、Pod 用量 | [监控](./monitoring.md) |
| 查某个资源被谁改过、改了什么、回滚 | [资源历史](./resource-history.md) |
| 让 AI 帮忙读状态、查日志、查指标 | [AI 助手](./ai-assistant.md) |
| 装应用、升级、回滚、卸载 | [Helm 管理](./helm-management.md) |
| 在浏览器里进 Pod / Node 执行命令 | [Web 终端](./web-terminal.md) |
| 通过代理访问集群内的服务 | [Kube Proxy](./kube-proxy.md) |
| 调整左侧栏显示哪些入口 | [自定义侧边栏](./custom-sidebar.md) |
| 查审计记录、导出、合规口径 | [审计与合规](./audit-and-compliance.md) |
| 站内信、邮件通知与顶栏公告 | [通知与公告](./notification-and-announcements.md) |
| 接入私有或远程集群 | [鸢联 AeroLink Cluster Agent](./aerolink-cluster-agent.md) |

## 按场景分组

### 观察与排障

[全局搜索](./global-search.md)、[相关资源](./related-resources.md)、[日志](./logs.md)、[监控](./monitoring.md)、[资源历史](./resource-history.md)、[AI 助手](./ai-assistant.md)。

从「哪个 Pod 在报错」一路走到「它为什么报错」：搜索定位资源 → 相关资源补上下文 → 日志看输出 → 监控看趋势 → 资源历史看变更。AI 助手可以代劳其中几步的查询。

### 运维操作

[Helm 管理](./helm-management.md)、[Web 终端](./web-terminal.md)、[Kube Proxy](./kube-proxy.md)、[自定义侧边栏](./custom-sidebar.md)。

创建与改动类操作（建工作负载、改配置、扩缩容、重启、删除、回滚）的具体步骤在[创建与常用操作](/usage/common-operations)里，这里补充各入口的完整用法和使用限制。

### 治理与接入

[审计与合规](./audit-and-compliance.md)、[通知与公告](./notification-and-announcements.md)、[鸢联 AeroLink Cluster Agent](./aerolink-cluster-agent.md)。

审计记录只写不改，按保留策略整批过期；通知与公告面向全员，在「系统设置 → 通知管理」里配置；Cluster Agent 用于把私有或远程集群接进工作空间。
