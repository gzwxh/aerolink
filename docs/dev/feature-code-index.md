# 功能代码索引（feature → code）

这份文档解决一个问题：**提到某个功能，能立刻知道该看/该改哪些文件**。

它与 `AGENTS.md` 的分工：`AGENTS.md` 是**规则**（该怎么做、不该做什么），本文是**导航**（东西在哪）。
新增/迁移功能时请顺手更新对应小节——索引过期比没有索引更有害。

- 适用：定位现有实现、判断该复用哪一层、估算改动的波及面
- 不适用：当作 API 契约（以代码为准）、当作产品说明（见 `docs/guide/`）

---

## 1. 核心入口与总分发

### 后端

| 关注点 | 文件 |
| --- | --- |
| 进程入口 | `main.go` |
| 启动编排（DB、RBAC、模板、后台任务） | `app.go` → `initializeApp()` |
| 全部 HTTP 路由 | `routes.go` |
| 前端静态资源（embedded） | `static.go` + `static/`（生成物，勿手改） |
| 配置文件加载与监听 | `internal/config.go` |
| 环境变量与默认值 | `pkg/common/common.go` |
| 换库/整库搬运（SQLite/MySQL/PostgreSQL 互导） | `tools/dbmigrate/main.go`（`go run ./tools/dbmigrate`；方案见 `plans/2026-09-20-sqlite-to-postgres-migration.md`） |
| 数据模型与 AutoMigrate 清单 | `pkg/model/model.go`（`Models()`，顺序即外键依赖顺序） |
| 资源类型目录（后端权威） | `pkg/common/resource.go` |
| 资源 handler 注册入口 | `pkg/resources/handler.go` |

`routes.go` 的分组（改接口先定位分组，权限门就挂在分组上）：

| 分组 | 说明 |
| --- | --- |
| `/api/v1/bootstrap`、`/api/v1/cluster-agent/*` | 未登录可达（初始化、agent 注册/连接） |
| `/metrics`、`/healthz`、`/api/v1/version` | 运维与本版信息 |
| `/api/auth` | 登录、MFA、验证码、OAuth 回调 |
| `/api/users` | 当前用户自服务（含 `POST /api/users/sidebar_preference`） |
| `/api/v1/admin/*` | 管理接口，按域再分权：`clusters`/`roles`/`binding-groups`/`users`/`apikeys`/`general-setting`/`sidebar_preference`/`security-setting`/`audit-setting`/`notification-*`/`templates` |
| `/api/v1`、`/api/v1/_clusters/:cluster` | 登录用户可达；集群维度在 `_clusters` 下 |
| `/api/v1/ai/*` | AI 助手（状态、对话、待确认动作续跑） |

### 前端

| 关注点 | 文件 |
| --- | --- |
| 挂载与应用外壳 | `ui/src/main.tsx`、`ui/src/App.tsx` |
| 路由表 | `ui/src/routes.tsx` |
| 资源列表总分发 | `ui/src/pages/resource-list.tsx` |
| 列表页的命名空间筛选 | `ui/src/components/resource-table-toolbar.tsx`（挂 `ui/src/components/selector/namespace-selector.tsx`）+ `ui/src/hooks/use-resource-table-state.ts`（`selectedNamespace` 可选多值「a,b」，多值时按 `_all` 拉取再前端过滤）。**约定：URL 的单段路径只能表达一个命名空间，多选值不写进 URL**；`/deployments` 另有「URL 里的命名空间是否存在」的守卫，判定时只认单值（见 `docs/dev/plans/2026-09-20-storage-create-hardening.md` §7） |
| 资源详情总分发 | `ui/src/pages/resource-detail.tsx` + `ui/src/pages/resource-definitions.tsx`（类型 → 专用页面映射） |
| 资源目录（前端） | `ui/src/lib/resource-catalog.ts`（须与 `pkg/common/resource.go` 同步） |
| 侧边栏菜单来源 | `ui/src/components/app-sidebar.tsx` + `ui/src/contexts/sidebar-config-context.tsx` + `ui/src/contexts/sidebar-config-defaults.ts` |
| HTTP 客户端与 API 模块 | `ui/src/lib/api.ts`（聚合导出）+ `ui/src/lib/api/*.ts`（按域拆：`admin`/`auth`/`bootstrap`/`cluster`/`core`/`notification`/`observability`/`shared`/`system`） |
| i18n | `ui/src/i18n/index.ts` + `ui/src/i18n/locales/{zh,en}.json` |
| 子路径部署 | `ui/src/lib/subpath.ts`、`ui/src/lib/base-path.ts` |

---

## 2. 功能索引

> 列含义：前端页面/组件 → 前端 API → 后端包 → 主要数据模型/表。
>
> 写法约定：同一格内多个文件时，**首个写全路径，后续与它同目录的省略前缀**（如 `ui/src/components/settings/rbac-management.tsx`、`rbac-view.tsx`）。

### 身份与访问

| 功能 | 前端 | 前端 API | 后端 | 数据 |
| --- | --- | --- | --- | --- |
| 登录（密码/LDAP） | `ui/src/pages/login.tsx` | `ui/src/lib/api/auth.ts` | `pkg/auth/login_handler.go`、`pkg/captcha` | `users`、`login_records` |
| 初始化向导 | `ui/src/pages/initialization.tsx` | `ui/src/lib/api/system.ts`、`ui/src/lib/api/bootstrap.ts` | `pkg/auth/bootstrap_handler.go`、`internal/config.go` | `general_settings` |
| MFA（动态码） | `ui/src/components/account/mfa-section.tsx`、`ui/src/components/mfa-enrollment-gate.tsx`、`ui/src/components/mfa-prompt-dialog.tsx`、`ui/src/lib/mfa-enrollment.ts`（自助绑定范围与再认证方式） | `ui/src/lib/api/auth.ts`、`ui/src/lib/mfa-prompt.ts` | `pkg/mfa`、`pkg/auth`、`pkg/users/handler.go`（自助绑定接口）、`pkg/model/security_setting.go`（谁必须绑定） | `users.mfa_*`、`user_sessions.started_at`（目录账号的再认证依据） |
| 头像（外链 / 上传存库） | `ui/src/components/account/profile-section.tsx`（上传与移除）、`ui/src/lib/avatar-upload.ts`（浏览器端裁方+缩放+重编码）、`ui/src/lib/avatar-url.ts`（`resolveAvatarSrc` 区分内链/外链，4 处头像渲染点共用） | `ui/src/lib/api/auth.ts` | `pkg/users/avatar.go`（校验与三个接口）、`pkg/model/user_avatar.go` | `user_avatars`（字节按用户一行；`users.avatar_url` 存 `/api/users/<id>/avatar?v=<内容哈希>`，口径见 `plans/2026-09-20-avatar-upload.md`） |
| 会话策略（空闲/总时长/单点登录） | `ui/src/components/settings/security-management.tsx` | `ui/src/lib/api/admin.ts` | `pkg/auth/session_policy.go`、`pkg/auth/login_attempt_limiter.go` | `security_settings` |
| 会话心跳 / 被顶下线 | `ui/src/hooks/use-session-heartbeat.ts`、`ui/src/hooks/use-session-takeover-notice.tsx`、`ui/src/components/session-superseded-dialog.tsx` | — | `pkg/auth`、`pkg/notification/session_takeover.go` | 进程内状态 + `notifications` |
| 登录失败限流 / IP 黑白名单 | `ui/src/components/settings/security-management.tsx` | `ui/src/lib/api/admin.ts` | `pkg/auth/login_attempt_limiter.go` | `security_settings` |
| API Key | `ui/src/components/settings/apikey-management.tsx`、`apikey-dialog.tsx` | `ui/src/lib/api/admin.ts` | `pkg/apikeys` | `users.api_key` |
| 站内信 | `ui/src/components/notification-bell.tsx` | `ui/src/lib/api/notification.ts` | `pkg/notification`、`pkg/model/notification.go` | `notifications` |
| 邮件模板/订阅 | `ui/src/components/settings/notification-management.tsx`、`template-management.tsx` | `ui/src/lib/api/admin.ts` | `pkg/notification` | `notification_settings`、`notification_templates`、`notification_subscriptions` |

### 权限

| 功能 | 前端 | 前端 API | 后端 | 数据 |
| --- | --- | --- | --- | --- |
| 权限判定（前端展示） | `ui/src/hooks/use-can.ts`、`ui/src/lib/rbac-permissions.ts`、`ui/src/lib/rbac-privileges.ts`、`ui/src/lib/node-permissions.ts` | — | — | — |
| 角色与授权 | `ui/src/components/settings/rbac-management.tsx`、`rbac-view.tsx`、`rbac-role-form-dialog.tsx`、`rbac-permission-catalog.tsx` | `ui/src/lib/api/admin.ts` | `pkg/rbac`、`pkg/resources/rbac_list_test.go` | `roles`、`role_assignments` |
| 权限绑定组（集群/命名空间范围） | `ui/src/components/settings/binding-group-management.tsx` | `ui/src/lib/api/admin.ts` | `pkg/bindinggroups`、`pkg/rbac/manager.go` | `binding_groups`、`binding_group_namespaces`、`binding_group_members` |
| 创建命名空间只归管理员（不通过角色 / 绑定组下发） | `ui/src/lib/rbac-permissions.ts`（`isNamespaceCreate`，镜像后端）、`ui/src/lib/node-permissions.ts`（角色编辑器不列 create） | — | `pkg/rbac/rbac.go`（`canAccessVerb` 开头的管理员分支） | — （口径见 `docs/dev/plans/2026-09-20-namespace-create-admin-only.md`；管理员的创建入口在权限绑定组页，`pkg/bindinggroups/handler.go` 的 `CreateBindingGroupNamespace`） |
| 用户与用户组 | `ui/src/components/settings/user-management.tsx`、`user-form-dialog.tsx`、`user-detail-dialog.tsx`、`user-management-tabs.tsx`、`user-groups-tab.tsx` | `ui/src/lib/api/admin.ts` | `pkg/users` | `users`、`local_groups`、`group_members` |
| 三权分立 / 审计员视图 | `ui/src/pages/rbac.tsx`、`ui/src/components/settings/administrator-management.tsx`、`separation-of-duties-banner.tsx` | `ui/src/lib/api/admin.ts` | `pkg/rbac` | `roles`、`role_assignments` |

### 集群与资源

| 功能 | 前端 | 前端 API | 后端 | 数据 |
| --- | --- | --- | --- | --- |
| 集群管理 | `ui/src/components/settings/cluster-management.tsx`、`cluster-dialog.tsx`、`cluster-import-dialog.tsx`、`ui/src/components/cluster-selector.tsx`、`ui/src/contexts/cluster-context.tsx` | `ui/src/lib/api/cluster.ts`、`ui/src/lib/api/admin.ts` | `pkg/cluster` | `clusters` |
| Cluster Agent（反向连接） | `ui/src/components/settings/cluster-management.tsx` | `ui/src/lib/api/cluster.ts` | `pkg/clusteragent` | `clusters.cluster_agent*` |
| 通用资源列表/详情 | `ui/src/pages/resource-list.tsx`、`resource-detail.tsx`、`simple-list-page.tsx`、`simple-resource-detail.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/handler.go`、`generic_resource_handler_{list,write,history}.go` | — |
| 资源创建（YAML apply） | `ui/src/components/create-resource-dialog.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/apply_handler.go` | `resource_histories` |
| ConfigMap | `ui/src/pages/configmap-list-page.tsx`、`configmap-detail.tsx`、`configmap-create-page.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources` | — |
| Secret | `ui/src/pages/secret-list-page.tsx`、`secret-detail.tsx`、`secret-create-page.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources` | — |
| 工作负载列表/详情 | `ui/src/pages/{deployment,statefulset,daemonset,cronjob,job,pod}-{list-page,detail}.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/{deployment,statefulset,daemonset}_handler.go` | — |
| 工作负载创建/编辑表单 | `ui/src/pages/deployment-create-page.tsx`、`ui/src/components/workload-container-sections.tsx`、`workload-container-security.tsx`、`ui/src/components/editors/deployment-form.ts`（编辑模式下的合并规则见 `mergeEditedManifest`） | `ui/src/lib/api/core.ts` | `pkg/resources/apply_handler.go` | — （**表单不生成 Service**：端口只描述容器端口，关联的 Service 只读展示见下一行） |
| 工作负载编辑入口（Deployment / StatefulSet / DaemonSet / Job / CronJob 同一套） | 路由 `ui/src/routes.tsx` 的 `…/:namespace/:name/edit`；详情页 `headerActions` 里的「编辑」按钮 | — | — | 口径见 `docs/dev/plans/2026-09-20-workload-edit-parity.md` |
| 对象编辑入口（12 类可创建资源：工作负载六类 + Service + ConfigMap / Secret + PV / StorageClass + Namespace） | 表单编辑：路由 `ui/src/routes.tsx` 的 `…/:name/edit`（命名空间级带命名空间段，PV/SC 是集群级）；同一个 create page 靠 `:name` 切创建/编辑；提交前的字段合并见 `ui/src/lib/{configmap,secret,service,pv,storageclass}-yaml.ts`；编辑路径的唯一来源是 `ui/src/lib/resource-catalog.ts` 的 `getResourceFormEditPath`（`resource-catalog.test.ts` 会核对路由存在）；列表入口是 `ui/src/components/resource-row-actions.tsx` 的「编辑」，详情页入口是 `resource-detail-shell.tsx` 标题栏的编辑按钮 | `ui/src/lib/api/core.ts` | `pkg/resources/apply_handler.go`、`generic_resource_handler_write.go` | 不可变字段的实测口径见 `plans/2026-09-20-service-form-edit.md`、`plans/2026-09-20-pv-sc-form-edit.md`；编辑对等与列宽口径见 `plans/2026-09-20-edit-parity-and-list-column-width.md` |
| 工作负载关联的 Service（只读 + 跳转） | `ui/src/components/associated-services.tsx`、`ui/src/lib/k8s.ts` 的 `servicesForWorkload`；服务列表页 `?search=` 预填（`resource-table.tsx` / `use-resource-table-state.ts` 的 `initialSearch`） | — | — | — |
| 通知投递口径（只发订阅者 + 管理员必收的安全事件） | `ui/src/components/settings/notification-management.tsx`（事件多选 + 全选、必收事件上锁）、`ui/src/lib/api/notification.ts`（`createNotificationSubscriptionsBatch`） | `ui/src/lib/api/notification.ts` | `pkg/notification/service.go`（`SendEvent` / `resolveRecipients` / `adminUserResolver`）、`handler.go`（`HandleCreateNotificationSubscriptions`）、`pkg/model/notification.go`（`mandatoryAdminEvents`、`ListAdminUserIDs`）、`pkg/rbac/rbac.go`（`AdminUserIDs`，由 `app.go` 注入） | `notification_subscriptions`、`notifications`（口径见 `docs/dev/plans/2026-09-20-console-ux-and-notification-fixes.md` §5 与 `docs/dev/plans/2026-09-20-notification-mandatory-admin-events.md`） |
| 容器编辑对话框 | `ui/src/components/container-edit-dialog.tsx`、`container-table.tsx`、`container-info-card.tsx` | `ui/src/lib/api/core.ts` | 同上 | — |
| 存储（PV/PVC/StorageClass） | `ui/src/pages/pv-list-page.tsx`、`pvc-list-page.tsx`、`storageclass-list-page.tsx`；创建/编辑页 `pv-create-page.tsx`、`storageclass-create-page.tsx`（YAML 生成与编辑合并都在 `ui/src/lib/pv-yaml.ts`、`ui/src/lib/storageclass-yaml.ts`，有单测与组件测试） | `ui/src/lib/api/core.ts`（`applyResource`） | `pkg/resources`（`apply_handler.go` 的集群级资源分支） | — |
| 网络（Service/Ingress/HTTPRoute/Gateway） | `ui/src/pages/service-*.tsx`、`ingress-list-page.tsx`、`httproute-list-page.tsx`、`gateway-list-page.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources` | — |
| 节点与调度 | `ui/src/pages/node-list-page.tsx`、`node-detail.tsx`、`ui/src/components/node-scheduling-section.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/node_handler.go` | — |
| 事件 | `ui/src/pages/event-list-page.tsx`、`ui/src/components/event-table.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/event_handler.go` | — |
| 相关资源 | `ui/src/components/related-resource-table.tsx`、`ui/src/pages/resource-detail-shell.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/related_resources.go` | — |
| 资源模板 | `ui/src/components/settings/template-management.tsx` | `ui/src/lib/api/admin.ts` | `pkg/templates` | `resource_templates` |
| 镜像 tag 选择 | `ui/src/components/editors/image-editor.tsx` | `ui/src/lib/api/core.ts` | `pkg/images/handler.go` | — |
| 全局搜索 | `ui/src/components/global-search.tsx`、`global-search-provider.tsx`、`ui/src/components/search.tsx` | `ui/src/lib/api/core.ts` | `pkg/search` | — |
| 资源收藏 | `ui/src/lib/favorites.ts`、`ui/src/hooks/use-favorites.ts`（**当前仅 localStorage**） | — | — | 迁移方案见 `plans/2026-09-18-server-side-user-preferences.md` |

### 运维与观测

| 功能 | 前端 | 前端 API | 后端 | 数据 |
| --- | --- | --- | --- | --- |
| 概览页 | `ui/src/pages/overview.tsx`、`ui/src/components/cluster-stats-cards.tsx`、`resources-charts.tsx` | `ui/src/lib/api/core.ts`、`ui/src/lib/api/observability.ts` | `pkg/system/handler.go`（`GetOverview`） | — |
| Pod/节点监控图表 | `ui/src/components/pod-monitoring.tsx`、`node-monitoring.tsx` | `ui/src/lib/api/observability.ts` | `pkg/prometheus` | — |
| 日志查看 | `ui/src/components/log-viewer.tsx`、`log-viewer-content.tsx` | `ui/src/lib/api/core.ts`、`ui/src/lib/useWebSocket.ts` | `pkg/resources/logs_handler.go`、`pkg/wsutil` | — |
| 终端（Pod/节点/kubectl） | `ui/src/components/terminal.tsx`、`terminal-content.tsx`、`floating-terminal.tsx`、`ui/src/contexts/terminal-context.tsx` | `ui/src/lib/useWebSocket.ts` | `pkg/terminal`、`pkg/kube/terminal.go` | — |
| Pod 文件浏览 | `ui/src/components/pod-file-browser.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/pod_handler.go` | `resource_histories`（文件操作审计） |
| Pod 调试 | `ui/src/components/pod-debug-dialog.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/pod_debug_handler.go` | — |
| 代理访问（k8s API 直连） | `ui/src/components/resource-iframe-dialog-content.tsx` | `ui/src/lib/api/core.ts` | `pkg/proxy` | — |
| 工作负载历史版本 | `ui/src/components/workload-history-tabs.tsx`、`workload-revisions-table.tsx` | `ui/src/lib/api/core.ts` | `pkg/resources/workload_revisions.go` | — |
| Helm 仓库/Release/自动升级 | `ui/src/pages/helm-chart-list-page.tsx`、`helm-chart-detail-page.tsx`、`helmrelease-*.tsx`、`ui/src/components/helm-install-dialog.tsx` | `ui/src/lib/api/core.ts` | `pkg/helm`、`pkg/helmutil`、`pkg/scheduler` | `helm_repositories`、`scheduled_tasks` |
| 版本信息 | `ui/src/components/version-info.tsx` | `ui/src/lib/api/system.ts` | `pkg/version` | — |

### 审计与合规

| 功能 | 前端 | 前端 API | 后端 | 数据 |
| --- | --- | --- | --- | --- |
| 操作/登录/改密日志 | `ui/src/components/settings/audit-log.tsx`、`login-log.tsx`、`password-change-log.tsx`、`audit-filters.tsx` | `ui/src/lib/api/admin.ts` | `pkg/audit/handler.go`、`pkg/audit/export.go`、`pkg/audit/retention.go` | `resource_histories`、`login_records`、`password_change_logs` |
| 审计保留策略 / syslog 外发 | `ui/src/components/settings/audit-setting.tsx` | `ui/src/lib/api/admin.ts` | `pkg/audit/retention.go`、`pkg/audit/syslog.go` | `audit_settings` |
| 管理操作审计写入 | — | — | `pkg/middleware/audit.go` | `resource_histories` |
| 敏感值落库加密 | — | — | `pkg/model/custom_type.go`（`SecretString`）、`pkg/model/encryption_key.go` | 各表密文字段 |
| 改密历史/复用策略 | `ui/src/components/settings/password-change-log.tsx` | `ui/src/lib/api/admin.ts` | `pkg/model/password_policy.go`、`pkg/model/password_change_log.go` | `password_histories`、`password_change_logs` |

### AI

| 功能 | 前端 | 前端 API | 后端 | 数据 |
| --- | --- | --- | --- | --- |
| AI 对话 | `ui/src/components/ai-chat/ai-chat-panel.tsx`、`ai-chatbox.tsx`、`ai-chat-messages.tsx`、`ui/src/contexts/ai-chat-context.tsx`、`ui/src/hooks/use-ai-chat.ts` | `ui/src/lib/api/core.ts` | `pkg/ai/agent.go`、`pkg/ai/handler.go`、`pkg/ai/interaction.go` | — |
| 工具授权与执行 | `ui/src/components/ai-chat/ai-chat-messages.tsx`（确认卡片） | `ui/src/lib/api/core.ts` | `pkg/ai/tool_authorization.go`、`tool_resource_execution.go`、`tool_prometheus.go` | `resource_histories`（source=ai） |
| 待确认会话（工具执行中途） | — | — | `pkg/ai/pending_session.go`、`pkg/model/pending_session.go` | `pending_sessions` |
| AI 配置（模型/连通性测试） | `ui/src/components/settings/general-management.tsx` | `ui/src/lib/api/admin.ts` | `pkg/ai/config.go` | `general_settings` |
| AI 会话历史（持久化） | `ui/src/components/ai-chat/ai-chat-history-panel.tsx`（**当前浏览器侧**） | — | — | 无（后端未持久化） |

### 系统与外观

| 功能 | 前端 | 前端 API | 后端 | 数据 |
| --- | --- | --- | --- | --- |
| 通用设置（品牌/JWT/各类默认值） | `ui/src/components/settings/general-management.tsx`、`ui/src/contexts/branding-context.tsx` | `ui/src/lib/api/admin.ts`、`ui/src/lib/api/bootstrap.ts` | `pkg/settings`、`internal/config.go` | `general_settings` |
| 外观（主题/字体/显示比例） | `ui/src/components/theme-provider.tsx`、`font-provider.tsx`、`appearance-provider.tsx`、`display-scale-provider.tsx`、`color-theme-provider.tsx` | —（仅 localStorage） | — | localStorage |
| 侧边栏自定义 | `ui/src/components/sidebar-customizer.tsx`（对话框 / 设置页 `inline` 两态）、`ui/src/contexts/sidebar-config-context.tsx`、`ui/src/contexts/sidebar-config-defaults.ts`（分组目录与版本迁移，“集群”分组 v6 起独立）、`ui/src/components/settings/navigation-management.tsx`（独立设置章节，管理员入口） | `ui/src/lib/api/system.ts` | `pkg/users/handler.go`（`UpdateSidebarPreference`、`UpdateGlobalSidebarPreference`、`ClearGlobalSidebarPreference`） | `users.sidebar_preference`、`general_settings.global_sidebar_preference` |
| 设置页框架（标签 + 权限门） | `ui/src/components/settings/settings-sections.tsx`、`ui/src/pages/settings.tsx` | — | — | — |
| 定时任务 | `ui/src/pages/helmrelease-auto-upgrade-dialog.tsx` | `ui/src/lib/api/admin.ts` | `pkg/scheduler` | `scheduled_tasks` |

---

## 3. 前端共享骨架（新增页面前先看这里）

按层次复用，**不要**在页面里重复实现：

1. **原子件**：`ui/src/components/ui/*`（shadcn 托管，只在需要改原语本身时动它）
2. **表格三层**：
   - `ui/src/components/resource-table.tsx`：列表状态、筛选、选择、工具栏、分页
   - `ui/src/components/resource-table-view.tsx`：行渲染入口（多数列表页走它）
   - `ui/src/components/action-table.tsx`：设置类表格
   - `ui/src/components/resource-table-toolbar.tsx`：筛选/刷新间隔/列显示
   - 立刻刷新：`ui/src/components/refresh-button.tsx`（`resource-table` 把数据层的 `refetch` 透传成 `onRefresh`，按钮只负责反馈与去抖，**不要在里面另开请求**）
   - 行操作菜单：`ui/src/components/resource-row-actions.tsx`（工作负载六类 + Service + ConfigMap / Secret + PV / StorageClass 共用；某类不支持某项就关掉 `resourceTraits` 里对应的开关，**不要**在每个页面另写一份菜单）；列表页只负责加一列 `columnHelper.display({ id: 'actions' })`，且必须是最后一列
   - 不受控长度的单元格：`ui/src/components/data-keys-cell.tsx`（ConfigMap / Secret 的「键」列，单行截断 + tooltip；集群里出现过 150+ 个键的 ConfigMap，铺开能把表格撑宽一倍）
3. **表单与编辑器**：
   - 表单数据层（类型 + 初值 + 生成 + 编辑时的合并）：`ui/src/lib/pv-yaml.ts`、
     `storageclass-yaml.ts`、`configmap-yaml.ts`、`service-yaml.ts`；页面只消费它们，
     转换逻辑（尤其编辑时的合并）放进去才好单测
   - `ui/src/components/editors/deployment-form.ts`：类型 + 默认值 + build/parse（数据层）
   - `ui/src/components/workload-container-sections.tsx`、`workload-container-security.tsx`：容器分区编辑器
   - `ui/src/components/key-value-rows.tsx`：键值行 + 文件读取（`maskValues` 控制是否打码）
   - `ui/src/components/command-list-input.tsx`：空格分隔数组 ↔ 输入框（**不要退回 `value={arr.join(' ')}` 直连写法，会打不出空格**）
   - `ui/src/components/kv-editor.tsx`、`label-selector-editor.tsx`、`transfer-box.tsx`、`single-select.tsx`、`multi-select.tsx`
4. **选择器**：`ui/src/components/selector/*`（命名空间、容器、Pod）
5. **状态与上下文**：`ui/src/contexts/*`、`ui/src/hooks/*`
   - 应用内前进/后退：`ui/src/contexts/navigation-context.tsx`（自维护栈 + sessionStorage；**不要**改用 `window.history.back()`，仓库里大量 `navigate(..., { replace: true })` 会让浏览器历史栈与“上一页”对不上）+ `ui/src/components/navigation-controls.tsx`
6. **通用行为**：`ui/src/lib/unsaved-edits.ts`（切集群前未保存确认）、`ui/src/lib/current-cluster.ts`（集群维度 localStorage key 前缀）、`ui/src/hooks/use-page-title.ts`、`ui/src/lib/utils.ts`（`translateError`）
   - **快捷键登记表**（新增快捷键必须写在这里，避免与已有冲突）：`⌘K` 全局搜索（`global-search-provider.tsx`）；`⌘[` / `⌘]` 与 `Alt+←` / `Alt+→` 应用内前进后退（`navigation-context.tsx`，在输入框 / Monaco / xterm 内不拦截）
7. **未保存 / 危险操作**：
   - 关闭会丢草稿的弹窗（表单、YAML 编辑器）：`ui/src/hooks/use-unsaved-changes-guard.ts`（`useUnsavedChangesGuard` 拦遮罩点击 / Esc / 右上角 X，`useDraftDirty` 判「有没有改过」）+ `ui/src/components/unsaved-changes-confirm-dialog.tsx`（确认弹窗，`i18nPrefix` 可换文案）。**不要**让关闭路径绕开它，也不要在 `ui/src/components/ui/dialog.tsx` 里改原语。
   - `ui/src/components/delete-confirmation-dialog.tsx`、`resource-delete-confirmation-dialog.tsx`

---

## 4. 后端约定（改接口前先看这里）

- **加表**：在 `pkg/model/<x>.go` 定义结构体 → 加进 `pkg/model/model.go` 的 `models` 列表（启动时逐模型 AutoMigrate）
- **列类型**：可能超过 64 KB 的文本用 `model.LongText` / `JSONField`（MySQL `TEXT` 上限 64 KiB，超长写入直接报错）；时间列用 GORM 默认 `datetime(3)`，不要写 `type:timestamp`；二进制用裸 `[]byte`（不要带 `type:` 标签，GORM 会按方言落成 `longblob` / `bytea` / `blob`）
- **大字段单独成表**：`users` 这类会被高频整行读取的表里不要放 blob/长文本（头像走 `user_avatars`，见 `plans/2026-09-20-avatar-upload.md`）；主键不是自增列时写 `gorm:"primaryKey;autoIncrement:false"`
- **资源类型**：`pkg/common/resource.go` + `pkg/resources/handler.go` + `ui/src/lib/resource-catalog.ts` 三处必须同步
- **权限**：接口在 `routes.go` 的分组上挂门；资源级判定走 `pkg/rbac`（`CanAccess`）；前端 `useCan()` 只是展示判定，不是安全边界
- **审计**：管理类写操作由 `pkg/middleware/audit.go` 统一落 `resource_histories`；资源操作在 handler 内显式写（`recordHistory`）
- **敏感值**：一律 `model.SecretString`，且不要打日志
- **配置**：环境变量同时看 `pkg/common/common.go` 与 `charts/kite`（values/templates）；`internal/config.go` 管理的设置在 UI 上必须只读
- **后台任务**：统一在 `app.go` 的 `initializeApp()` 启动（`scheduler.Start`、`auth.StartLDAPSync`、`notification.StartDailyChecker`、`audit.StartRetentionWorker`、`audit.StartSyslogForwarder`、`ai.StartPendingSessionCleanup`）——新增常驻任务放这里，不要在请求路径上起 goroutine

---

## 5. 常见改动的落点清单（how-to）

| 我要做什么 | 需要动的文件 |
| --- | --- |
| 新增资源类型 | `pkg/common/resource.go` → `pkg/resources/handler.go` → `ui/src/lib/resource-catalog.ts` →（如需专用页面）`ui/src/pages/resource-definitions.tsx` |
| 新增"创建页" | 照 `ui/src/pages/secret-create-page.tsx`（表单页范式）；路由加到 `ui/src/routes.tsx`；列表页加 `showCreateButton`/`onCreateClick` |
| 给某类资源加「编辑」 | 路由 `…/:namespace/:name/edit` **复用创建页**（同一个组件靠 `:name` 切换）→ 表单数据层加「线上对象 → 表单」与「叠加回线上对象」两个函数（如 `lib/service-yaml.ts` 的 `formFromService` / `mergeServiceUpdate`）→ 详情页加编辑入口（通用详情页把路径传到 `ResourceDetailShell` 的 `editPath`）→ 在 `ui/src/lib/resource-catalog.ts` 的 `formEditableResourceTypes` 里登记（漏登记时列表与详情页都不会出现编辑入口，单测会报错）。**不可变字段与表单没建模的字段必须从线上对象带过去**，否则 API 会以 `field is immutable` 拒绝；反过来，表单能清空的字段（如 Service 的 selector）要显式删掉，不能只做覆盖合并。 |
| 新增设置项 | 后端 `pkg/settings/*` + `pkg/model/*_setting.go`；前端 `ui/src/components/settings/*` + `settings-sections.tsx`（标签与权限门）+ 两个 locale |
| 新增通知事件 | `pkg/model/notification.go`（事件常量 + 默认模板 + `NotificationEventList`）→ 触发点（`pkg/notification/*`）→ i18n |
| 改「通知发给谁」 | `pkg/model/notification.go`（接收者类型常量 + `ListEnabledUsers`）→ `pkg/notification/service.go` 的 `resolveRecipients`（投递时展开）→ `pkg/notification/handler.go`（创建订阅的校验）→ `ui/src/components/settings/notification-management.tsx`；口径见 `plans/2026-09-20-notification-all-users-recipient.md` |
| 新增审计字段 | `pkg/model/resource_history.go` → 写入点（`pkg/middleware/audit.go` 或 handler）→ `pkg/audit/export.go` → 前端表格列 |
| 新增环境变量 | `pkg/common/common.go` → `charts/kite/values.yaml` + `charts/kite/templates/deployment.yaml` → 两个 README 参数表 |
| 新增后端接口 | `routes.go`（选对分组/权限门）→ handler → `pkg/model`（如需落库）→ `ui/src/lib/api/*.ts` |
| 新增前端页面 | `ui/src/pages/*.tsx` → `ui/src/routes.tsx` → 文案进两个 locale |
| 表格列显隐偏好 | `ui/src/hooks/use-table-column-visibility.ts` + `ui/src/components/table-column-toggle.tsx` |
| 用户可配置偏好 | 见 `plans/2026-09-18-server-side-user-preferences.md`（当前分散在 localStorage） |
| 改「谁必须绑定 MFA」/ 自助绑定口径 | `pkg/model/security_setting.go`（`MFARequiredFor`）→ `pkg/auth/middleware.go`（绑定引导拦截）→ `pkg/auth/login_handler.go`（登录挑战）→ `pkg/users/handler.go`（自助绑定）→ `ui/src/lib/mfa-enrollment.ts`（前端镜像）；口径见 `plans/2026-09-20-directory-user-mfa-enrollment.md` |
| 换数据库（如切到 PostgreSQL 以扩副本） | `tools/dbmigrate`（搬数据）→ `pkg/common/common.go` 的 `DB_TYPE`/`DB_DSN` 环境变量 → `dev.env` / `charts/kite` 的 `db.*`；步骤与校验见 `plans/2026-09-20-sqlite-to-postgres-migration.md` |

---

## 6. 验证命令

```bash
make dev                 # 本地开发（前端 HMR + 后端自动重启）
make build               # 完整构建（会重建 static/）
make frontend            # 只重建前端资源
make pre-commit          # format + lint（提交前必须过）

go test ./pkg/...                                          # 后端测试（按包跑更省时间）
pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json
pnpm --dir ui exec eslint <files>
pnpm --dir ui run test                                     # vitest

make e2e-test            # Playwright + kind（spec 见 e2e/specs/*.spec.ts）
```

对着**跑起来的实例**做一遍回归（换数据库版本、大改动前；写检查要显式给可破坏的命名空间）：

```bash
go run ./tools/apismoke -base-url http://127.0.0.1:8080 -cluster dev -namespace devops \
  -log-file /data/logs/kite.log            # 只读；加 -write-namespace/-ai/-smtp 会再跑写路径、AI 工具、邮件投递
```

后端改动的常见验证靶点：`pkg/resources`（资源与创建）、`pkg/audit`（审计与保留策略）、`pkg/model`（模型与缓存）、`pkg/rbac`（授权）。

---

## 7. 容易踩的坑

- `static/`、`kite`、`bin/` 是生成物，不要手改；前端改动要生效必须 `make frontend` / `make build`
- `vendor/` 已入库，改依赖要同时处理 `go.mod`/`go.sum` 与 `vendor/`
- `ui/src/lib/api.ts` 与 `ui/src/lib/api/` 目录同时存在（前者聚合导出），新增 API 模块别搞混
- 根目录 `AGENTS.md` 与 `CLAUDE.md` 都是代理约定文件，改一个记得同步另一个
- 前端 localStorage key 有集群前缀约定（`ui/src/lib/current-cluster.ts` 的 `getClusterScopedStorageKey`），新增 key 请沿用
- 权限、审计、集群维度（`_all`/命名空间范围）任何一处漏掉，都会变成安全或合规缺陷
