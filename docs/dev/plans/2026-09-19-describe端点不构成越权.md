# 结论：控制台 `describe` 端点不构成越权（不做改动）

- 状态：**已核查，无需改动**
- 背景：AI 工具的 `describe_resource` 会把 kubectl describer 的输出送进模型上下文，其中
  ConfigMap 明文值、`kubernetes.io/service-account-token` 类型 Secret 的 token 会因此
  离开集群交给外部模型。该问题已在 `pkg/ai/tool_resource_execution.go` 修复（敏感类型
  改走脱敏的 `executeGetResource`）。同一 describer 也被控制台的
  `GET /:ns/:name/describe`（`pkg/resources/generic_resource_handler_history.go` 的
  `Describe`）使用，这里记录「控制台这条路径是否同样需要脱敏」的核查结论。

## 结论

控制台 `describe` **不需要**改动，理由是该端点的输出是调用方已有权限读取的对象内容，
不存在提权：

1. **RBAC 与普通 GET 同档**：路由经 `pkg/middleware/rbac.go` 的 `RBACMiddleware`，
   方法为 `GET` → verb 为 `get`（`method2verb`）。`/describe` 还被
   `isCrossNamespaceList` 显式排除在跨命名空间放行之外（该文件注释明确列出
   `/:name`、`/describe`、`/history`… 仍需要显式的 `_all`/`*` 授权）。因此能调用它的人
   对同一对象有 `get` 权限。
2. **`get` 就能读到同样的数据**：控制台的 Secret 详情页会解码并展示 `data`
   （`ui/src/pages/secret-detail.tsx` 的 `atob` 路径），且仓库里**没有**独立的
   「查看明文」动词（`pkg/common/rbac.go` 只有 get/create/update/delete/log/exec/
   view-file/download-file/upload-file）。也就是说 describer 打印的 token，调用方本就
   能看到。
3. **describer 的读取范围不超出被描述对象**：`SecretDescriber` / `ConfigMapDescriber`
   只 get 目标对象本身；只有 `IngressDescriber` 会额外读取 Service 与 EndpointSlice
   （用于展示后端），属于「同一命名空间内、调用方通常也持有 `get`」的关联信息，与 kubectl
   本身的行为一致。

## 与 AI 路径的差别

差别不在「谁能看到」，而在**数据去哪里**：控制台把输出返回给已认证的浏览器，AI 工具把
输出交给外部 LLM。因此只有 AI 路径需要脱敏，这条口径记在
`pkg/ai/tool_resource_execution.go` 的 `isSensitiveResourceKind` 注释里。

## 若日后仍要收紧

可选（本次未做，且需要产品决定）：
- 对 `Secret` / `ConfigMap` 关闭 describe，或改用脱敏视图（UI 的 describe 弹窗仍可用，
  只是看不到明文值）；
- 用 RESTMapper 的 `get` 权限逐个校验 describer 会读取的关联资源后，再拼接输出。
