# 相关资源

在查看资源时，鸢联 AeroLink 会向您显示相关资源的列表。这可以帮助您在相关对象之间快速导航，例如，从 Deployment 到其 Pod，或从 Service 到其后备 Pod。

## 在哪看

资源详情页右侧栏的「相关资源」卡片，以及部分资源的「相关资源」页签。

![Deployment 详情页右侧的相关资源（⑥）与事件](/images/usage/deploy-detail-demo-guided.png)

## 关系是怎么算的

| 当前资源 | 会列出什么 |
| --- | --- |
| Deployment / StatefulSet / DaemonSet | 它管理的 Pod、指向它的 Service、关联的 ConfigMap / Secret |
| Pod | 所属工作负载、同选择器的 Service、挂载的 ConfigMap / Secret |
| Service | 匹配选择器的后端 Pod、Endpoints |
| Ingress | 指向的 Service |
| PVC / PV | 挂载它的 Pod / 对应的存储对象 |

- 点条目直接跳到对应资源详情，不用回列表找。
- 显示「暂无相关资源」通常是选择器 / 标签不匹配，或权限不足看不到对象（无权限的对象不显示）。
- 相关资源只做导航，不改变任何对象。
