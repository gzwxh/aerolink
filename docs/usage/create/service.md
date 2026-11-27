# Service：创建与修改

Service 给一组 Pod 一个固定入口：ClusterIP 供集群内访问，NodePort / LoadBalancer 对外暴露端口。它靠**选择器**匹配 Pod 的标签，不靠名字。

## 创建入口

左侧「流量 → Services」→ 右上角「创建」；也可以在容器页签的「端口」里勾选「生成 Service」，建工作负载时一起建出来（ClusterIP 与负载同名，NodePort 加 `-nodeport`，LoadBalancer 加 `-loadbalancer`）。

![Services 列表：① 命名空间筛选 ② 搜索 ③ 创建 ④ 行操作](/images/usage/svc-list-guided.png)

列表看「类型 / Cluster IP / 端口」列；无头 Service 的 Cluster IP 显示 `None`。

## 表单

![Service 创建页：① 命名空间 ② 服务名称 ③ 服务类型 ④ 选择器 ⑤ 端口 ⑥ 创建按钮](/images/usage/create-service-form-guided.png)

图上编号：① 命名空间 ② 服务名称 ③ 服务类型 ④ 选择器（匹配 Pod 标签）⑤ 端口（端口 / 目标端口）⑥ 创建按钮。

| 字段 | 说明 |
| --- | --- |
| 命名空间 | 默认当前命名空间，编辑时锁定 |
| 服务名称 | 必填，创建后不可改 |
| 服务类型 | ClusterIP / NodePort / LoadBalancer / ExternalName |
| 选择器 | 键值对，匹配 Pod 上的标签；留空=不选 Pod，需要手动维护 Endpoints |
| 会话保持 | `None` 或 `ClientIP` |
| 外部名称 | 只有 ExternalName 类型要填，写目标 DNS 名 |
| 端口 | 名称、协议（TCP/UDP）、端口、目标端口；NodePort / LoadBalancer 还要节点端口 |

ExternalName 类型没有选择器、会话保持和端口——它是条 CNAME 记录。

### 选择器怎么填

页面上可以直接从当前命名空间的 Pod 标签里选，也可以手填。目标 Pod 上有 `app=web`，这里就填 `app` / `web`。

::: warning 选择器别写错
选错了不会报错，只会出现"Service 建好了但没有后端"：详情页的 Endpoints 是空的，访问自然不通。建完先看详情页有没有列出 Pod IP。
:::

### 端口

- **端口**：Service 自己监听的端口。
- **目标端口**：Pod 容器里的端口，可以写端口号或容器端口的名字。
- **节点端口**：NodePort / LoadBalancer 才有；留空则由集群分配（30000-32767）。

多个端口时各自命名（如 `http`、`metrics`），否则 YAML 会不合法。

### 生成的 YAML

页面底部就是最终清单，可以直接改。手改后以 YAML 为准生效，回到表单再改会重新生成——和创建工作负载时的联动规则一致，见[表单创建页怎么填](/usage/common-operations#表单创建页怎么填)。

## 建完之后

详情页能看到 ClusterIP、端口、以及选中的 Pod（Endpoints）。访问不通时按顺序查：

1. 选择器与 Pod 标签是否真的匹配（详情页 Endpoints 是否为空）。
2. `targetPort` 是否是容器真实监听的端口。
3. Pod 是否 Ready（没 Ready 的 Pod 不会被挂进 Endpoints）。

## 修改

| 改什么 | 怎么改 |
| --- | --- |
| 选择器、端口、会话保持、标签注解 | 行操作「编辑」进表单页 |
| 服务类型 | 表单里可改，但 **ExternalName 与其他类型之间不能互转**，此时类型会锁定并提示 |
| 表单没建模的字段（`externalTrafficPolicy`、`internalTrafficPolicy`、`ipFamilyPolicy`…） | 详情页「YAML」页签 |

Service 没有容器、终端和滚动重启这些概念，所以行操作里只有编辑、查看 YAML、管理标签/注解、删除；也没有「回滚」——改错了就再改回去，详情页「历史」页签能查到每次改动。

删除 Service 不会影响 Pod；反过来删除 Deployment 时，如果有 Service 的选择器指向它，会提示连带删除。
