# cert-manager 资源面内置 + 资源关系图

## 背景

上游 kite v0.16.0 以插件形式提供了 cert-manager 与 Resource Map。鸢联是内网单二进制交付，
不做插件框架，改为把有价值的部分直接内置：

- cert-manager 的 CR（Certificate / CertificateRequest / Issuer / ClusterIssuer / Order /
  Challenge）注册为一等资源面，与 Gateway API 同模式。
- 资源关系图：独立前端页面，展示「Ingress → Service → Pod → 负载（owner 链）→
  ConfigMap/Secret/PVC」的依赖拓扑。

## cert-manager 资源面

走既有 `GenericResourceHandler` 强类型模式（同 gateway）：

- 引入 `github.com/cert-manager/cert-manager/pkg/apis/certmanager/v1` 依赖（仅 apis 包，
  go.sum 增量极小），`pkg/kube/client.go` 的 runtimeScheme 注册。
- `pkg/common/resource.go`：新增 6 个 ResourceType 常量 + Registry 条目
  （cert-manager.io/v1；ClusterIssuer 集群级，其余命名空间级）。
- `pkg/resources/handler.go`：6 个 generic handler。
- 前端：`resource-catalog.ts` 条目（新侧边栏分组 `sidebar.groups.certmanager`「证书」，
  仅 Certificate / Issuer / ClusterIssuer 显示在侧边栏，Order / Challenge /
  CertificateRequest 设 defaultHidden 或不进侧边栏）+ `types/api.ts` 类型映射 +
  zh/en i18n key。列表/详情先走通用页面，不做专用列定义（后续按需加）。
- RBAC 沿用既有机制：权限字符串是复数资源名（certificates 等），Group 不参与匹配。


## 测试与文档

- 后端：resourcemap 图构建单测（fake client，覆盖 owner/selector/backend/卷引用与 RBAC
  过滤）；cert-manager 注册单测（LookupResource + 走 API 列表）。
- 前端：resource-map 布局/图构建纯函数 vitest；`tsc --noEmit`。
- 同步 `docs/dev/feature-code-index.md`。
