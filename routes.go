package main

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	promclient "github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/zxh326/kite/pkg/ai"
	"github.com/zxh326/kite/pkg/announcement"
	"github.com/zxh326/kite/pkg/apikeys"
	"github.com/zxh326/kite/pkg/audit"
	"github.com/zxh326/kite/pkg/auth"
	"github.com/zxh326/kite/pkg/bindinggroups"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/helm"
	"github.com/zxh326/kite/pkg/images"
	"github.com/zxh326/kite/pkg/metrics"
	"github.com/zxh326/kite/pkg/middleware"
	"github.com/zxh326/kite/pkg/notification"
	"github.com/zxh326/kite/pkg/proxy"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/resources"
	"github.com/zxh326/kite/pkg/search"
	"github.com/zxh326/kite/pkg/settings"
	"github.com/zxh326/kite/pkg/system"
	"github.com/zxh326/kite/pkg/templates"
	"github.com/zxh326/kite/pkg/terminal"
	"github.com/zxh326/kite/pkg/transportkey"
	"github.com/zxh326/kite/pkg/users"
	"github.com/zxh326/kite/pkg/version"
	"k8s.io/klog/v2"
	ctrlmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
)

func setupAPIRouter(r *gin.RouterGroup, cm *cluster.ClusterManager) {
	authHandler := auth.NewAuthHandler()
	helmChartsHandler := helm.NewHelmChartHandler()

	registerBaseRoutes(r)
	r.GET("/api/v1/bootstrap", authHandler.Bootstrap)
	r.GET("/api/v1/cluster-agent/connect", cm.ConnectClusterAgent)
	r.POST("/api/v1/cluster-agent/register", cm.RegisterClusterAgent)
	r.GET("/api/v1/cluster-agent/manifest", cm.GetClusterAgentManifest)
	registerAuthRoutes(r, authHandler)
	registerUserRoutes(r, authHandler)
	registerAdminRoutes(r, authHandler, cm, helmChartsHandler)
	registerProtectedRoutes(r, authHandler, cm, helmChartsHandler)
}

// metricsAuth 可选地用 bearer token 保护 /metrics。
func metricsAuth(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if token == "" {
			c.Next()
			return
		}
		presented := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer"))
		if subtle.ConstantTimeCompare([]byte(presented), []byte(token)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}
		c.Next()
	}
}

func registerBaseRoutes(r *gin.RouterGroup) {
	// 指标端点需要能被 Prometheus 访问，而它无法携带会话
	// cookie。设置 AEROLINK_METRICS_TOKEN 可要求 "Authorization: Bearer <token>"，
	// 而不是让该端点完全开放。
	metricsToken := strings.TrimSpace(common.Getenv("METRICS_TOKEN"))
	if metricsToken == "" {
		klog.Warningf("AEROLINK_METRICS_TOKEN is not set: /metrics is exposed without authentication")
	}
	r.GET("/metrics", metricsAuth(metricsToken), gin.WrapH(promhttp.HandlerFor(promclient.Gatherers{
		promclient.DefaultGatherer,
		ctrlmetrics.Registry,
	}, promhttp.HandlerOpts{})))
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	r.GET("/api/v1/version", version.GetVersion)
	// 登录表单在拿到会话之前就要用它加密口令，因此必须免认证。
	r.GET("/api/v1/transport-key", transportkey.PublicKeyHandler)
}

func registerAuthRoutes(r *gin.RouterGroup, authHandler *auth.AuthHandler) {
	authGroup := r.Group("/api/auth")
	authGroup.POST("/setup/create_super_user", authHandler.CreateSuperUser)
	authGroup.POST("/login/password", authHandler.PasswordLogin)
	authGroup.GET("/captcha", authHandler.Captcha)
	authGroup.POST("/login/ldap", authHandler.LDAPLogin)
	authGroup.GET("/login", authHandler.Login)
	authGroup.GET("/callback", authHandler.Callback)
	// 第三方登录补验动态码：回调签发的短时票据 + 动态码换会话（见 VerifyPendingMFA）。
	authGroup.POST("/mfa/verify", authHandler.VerifyPendingMFA)
	authGroup.POST("/logout", authHandler.Logout)
	authGroup.POST("/refresh", authHandler.RefreshToken)
	authGroup.GET("/user", authHandler.RequireAuth(), authHandler.GetUser)
	// 会话心跳：前端轮询它来及时感知「会话被其他设备顶替」（单点登录），
	// 见 SessionHeartbeat 的说明。
	authGroup.GET("/session", authHandler.RequireAuth(), authHandler.SessionHeartbeat)
}

func registerUserRoutes(r *gin.RouterGroup, authHandler *auth.AuthHandler) {
	userGroup := r.Group("/api/users")
	userGroup.PUT("/me", authHandler.RequireAuth(), users.UpdateCurrentUser)
	// 头像上传：字节落 user_avatars 表，并把 users.avatar_url 指向取图接口
	// （见 pkg/users/avatar.go 与 docs/dev/plans/2026-09-20-头像上传.md）。
	userGroup.POST("/me/avatar", authHandler.RequireAuth(), users.UploadCurrentUserAvatar)
	userGroup.DELETE("/me/avatar", authHandler.RequireAuth(), users.DeleteCurrentUserAvatar)
	// 取图只要登录：头像不敏感，按「只能读自己」判定会让用户列表里的头像全部 404。
	userGroup.GET("/:id/avatar", authHandler.RequireAuth(), users.GetUserAvatar)
	userGroup.POST("/me/password", authHandler.RequireAuth(), users.ChangeCurrentUserPassword)
	userGroup.POST("/me/mfa/setup", authHandler.RequireAuth(), users.SetupCurrentUserMFA)
	userGroup.POST("/me/mfa/enable", authHandler.RequireAuth(), users.EnableCurrentUserMFA)
	userGroup.POST("/me/mfa/disable", authHandler.RequireAuth(), users.DisableCurrentUserMFA)
	userGroup.POST("/me/mfa/verify", authHandler.RequireAuth(), users.VerifyCurrentUserMFA)
	userGroup.POST("/sidebar_preference", authHandler.RequireAuth(), users.UpdateSidebarPreference)
}

func registerAdminRoutes(r *gin.RouterGroup, authHandler *auth.AuthHandler, cm *cluster.ClusterManager, helmChartsHandler *helm.HelmChartHandler) {
	adminAPI := r.Group("/api/v1/admin")
	adminAPI.Use(authHandler.RequireAuth(), authHandler.RequireAdmin())
	// 系统设置与权限管理的写操作同样需要留痕，记录到「日志审计 → 操作日志」。
	adminAPI.Use(middleware.AdminAudit())

	// 控制台设置按章节授权：等保三级三权分立要求「系统配置（系统管理员）」「安全
	// 策略与授权（安全管理员）」「审计日志（审计管理员）」能各自授予，而不是挤在
	// 同一个 settings 开关里（见 pkg/middleware.RequireSettingsSection）。
	requireGeneral := middleware.RequireSettingsSection(common.SettingsSectionGeneral)
	requireClusters := middleware.RequireSettingsSection(common.SettingsSectionClusters)
	requireNotification := middleware.RequireSettingsSection(common.SettingsSectionNotification)
	requireTemplates := middleware.RequireSettingsSection(common.SettingsSectionTemplates)
	requireAPIKeys := middleware.RequireSettingsSection(common.SettingsSectionAPIKeys)
	requireAuthentication := middleware.RequireSettingsSection(common.SettingsSectionAuthentication)
	requireUsers := middleware.RequireSettingsSection(common.SettingsSectionUsers)
	requireRBAC := middleware.RequireSettingsSection(common.SettingsSectionRBAC)
	requireSecurity := middleware.RequireSettingsSection(common.SettingsSectionSecurity)
	requireAudit := middleware.RequireSettingsSection(common.SettingsSectionAudit)

	adminAPI.GET("/groups", requireUsers, rbac.ListGroups)
	// 所有用户组及其成员（权限绑定组列表按组展示成员用）
	adminAPI.GET("/group-members", requireUsers, rbac.ListAllGroupMembers)
	adminAPI.POST("/groups", requireUsers, rbac.CreateGroup)
	adminAPI.GET("/groups/:name/members", requireUsers, rbac.ListGroupMembers)
	adminAPI.POST("/groups/:name/members", requireUsers, rbac.AddGroupMember)
	adminAPI.DELETE("/groups/:name/members/:username", requireUsers, rbac.RemoveGroupMember)
	adminAPI.PUT("/groups/:name", requireUsers, rbac.RenameGroup)
	adminAPI.PUT("/groups/:name/description", requireUsers, rbac.UpdateGroupDescription)
	adminAPI.DELETE("/groups/:name", requireUsers, rbac.DeleteGroup)

	// 审计日志只读：审计管理员凭 settings.audit 的读权限即可，无需管理员角色。
	// 没有、也不会添加任何手工删除接口——删除只可能由保留策略按时间自动滚动发生。
	adminAPI.GET("/audit-logs", requireAudit, audit.ListAuditLogs)
	adminAPI.GET("/login-logs", requireAudit, audit.ListLoginLogs)
	adminAPI.GET("/password-change-logs", requireAudit, audit.ListPasswordChangeLogs)
	// 导出（CSV）：过滤条件与列表接口一致，响应头带条目数与时间范围。
	adminAPI.GET("/audit-logs/export", requireAudit, audit.ExportAuditLogs)
	adminAPI.GET("/login-logs/export", requireAudit, audit.ExportLoginLogs)
	adminAPI.GET("/password-change-logs/export", requireAudit, audit.ExportPasswordChangeLogs)

	// 审计章节的设置：保留策略 + syslog 外发（审计管理员唯一可写的东西）。
	auditSettingAPI := adminAPI.Group("/audit-setting", requireAudit)
	auditSettingAPI.GET("/", audit.GetAuditSetting)
	auditSettingAPI.PUT("/", audit.UpdateAuditSetting)

	// 归档检索：只读，走 ES（配置在「审计设置 → 归档」里）。与本地列表接口同构，
	// 但检索的是已被 rolling 清理/上传到外部存储的历史记录。
	// 可用后端列表：界面据此渲染后端选择器（Elasticsearch / DuckDB）。
	adminAPI.GET("/archive-backends", requireAudit, audit.ArchiveBackends)
	adminAPI.GET("/audit-history-archive", requireAudit, audit.QueryAuditHistoryArchive)
	adminAPI.GET("/login-record-archive", requireAudit, audit.QueryLoginRecordArchive)
	adminAPI.GET("/access-log-archive", requireAudit, audit.QueryAccessLogArchive)
	// 归档导出（CSV）：过滤条件与上面的检索接口一致，响应头带条目数、时间范围与指纹。
	adminAPI.GET("/audit-history-archive/export", requireAudit, audit.ExportAuditHistoryArchive)
	adminAPI.GET("/login-record-archive/export", requireAudit, audit.ExportLoginRecordArchive)
	adminAPI.GET("/access-log-archive/export", requireAudit, audit.ExportAccessLogArchive)

	oauthProviderAPI := adminAPI.Group("/oauth-providers", requireAuthentication)
	oauthProviderAPI.GET("/", authHandler.ListOAuthProviders)
	oauthProviderAPI.POST("/", authHandler.CreateOAuthProvider)
	oauthProviderAPI.GET("/:id", authHandler.GetOAuthProvider)
	oauthProviderAPI.PUT("/:id", authHandler.UpdateOAuthProvider)
	oauthProviderAPI.DELETE("/:id", authHandler.DeleteOAuthProvider)

	ldapSettingAPI := adminAPI.Group("/ldap-setting", requireAuthentication)
	ldapSettingAPI.GET("/", authHandler.GetLDAPSetting)
	ldapSettingAPI.PUT("/", authHandler.UpdateLDAPSetting)
	ldapSettingAPI.POST("/sync", authHandler.SyncLDAPUsers)
	ldapSettingAPI.GET("/sync", authHandler.GetLDAPSyncStatus)
	ldapSettingAPI.GET("/users", authHandler.ListLDAPImportCandidates)
	ldapSettingAPI.POST("/users/import", authHandler.ImportLDAPUsers)

	clusterAPI := adminAPI.Group("/clusters", requireClusters)
	clusterAPI.GET("/", cm.GetClusterList)
	clusterAPI.GET("/:name/namespaces", cm.ListClusterNamespaces)
	clusterAPI.GET("/:name/nodeport-range", cm.GetNodePortRange)
	clusterAPI.POST("/", cm.CreateCluster)
	clusterAPI.POST("/import", cm.ImportClustersFromKubeconfig)
	clusterAPI.PUT("/:id", cm.UpdateCluster)
	clusterAPI.DELETE("/:id", cm.DeleteCluster)
	// 徽章图标是二进制，走单独的 multipart 接口而不是 PUT /:id 的 JSON 体。
	// 上传会顺带打开 badge_icon_enabled，见 pkg/cluster/cluster_badge_icon.go。
	clusterAPI.POST("/:id/badge-icon", cluster.UploadClusterBadgeIcon)
	clusterAPI.DELETE("/:id/badge-icon", cluster.DeleteClusterBadgeIcon)
	// 查看已存的 kubeconfig 属于凭据暴露操作：开启 MFA 后需要二次校验动态码。
	// 注意参数名必须是 :name（GET 树中已有 /:name/namespaces 等通配）。
	clusterAPI.GET("/:name/kubeconfig",
		authHandler.RequireMFAStepUp(), cm.GetClusterKubeconfig)

	rbacAPI := adminAPI.Group("/roles", requireRBAC)
	rbacAPI.GET("/", rbac.ListRoles)
	rbacAPI.POST("/", rbac.CreateRole)
	// 职责分离巡检：列出同时持有互斥管理员角色的账号（等保三级）。
	adminAPI.GET("/role-conflicts", requireRBAC, rbac.ListRoleConflicts)

	// 权限绑定组：命名空间 + 用户/用户组 + 角色的授权容器
	bindingGroupHandler := bindinggroups.NewHandler(cm)
	bindingGroupAPI := adminAPI.Group("/binding-groups", requireRBAC)
	bindingGroupAPI.POST("/", bindingGroupHandler.CreateBindingGroup)
	bindingGroupAPI.GET("/", bindingGroupHandler.ListBindingGroups)
	// 重新导入集群后创建内置的默认授权配置（超级权限绑定组）
	bindingGroupAPI.POST("/defaults", bindingGroupHandler.EnsureClusterDefaults)
	bindingGroupAPI.GET("/:id", bindingGroupHandler.GetBindingGroup)
	bindingGroupAPI.PUT("/:id", bindingGroupHandler.UpdateBindingGroup)
	bindingGroupAPI.DELETE("/:id", bindingGroupHandler.DeleteBindingGroup)
	bindingGroupAPI.POST("/:id/bind", bindingGroupHandler.BindBindingGroup)
	bindingGroupAPI.PUT("/:id/namespaces", bindingGroupHandler.SetBindingGroupNamespaces)
	bindingGroupAPI.POST("/:id/namespaces/create", bindingGroupHandler.CreateBindingGroupNamespace)
	bindingGroupAPI.GET("/:id/members", bindingGroupHandler.GetBindingGroupMembers)
	bindingGroupAPI.PUT("/:id/members", bindingGroupHandler.SetBindingGroupMembers)
	rbacAPI.GET("/:id", rbac.GetRole)
	rbacAPI.PUT("/:id", rbac.UpdateRole)
	rbacAPI.DELETE("/:id", rbac.DeleteRole)
	rbacAPI.POST("/:id/assign", rbac.AssignRole)
	rbacAPI.DELETE("/:id/assign", rbac.UnassignRole)
	rbacAPI.POST("/:id/restore_defaults", rbac.RestoreRoleDefaults)

	userAPI := adminAPI.Group("/users", requireUsers)
	userAPI.GET("/", users.ListUsers)
	// 「不活跃自动禁用」的账号列表：与同组的 :id/enable 同属 settings.users，
	// 避免安全设置页的面板读不到数据（见 users.ListDisabledUsers 注释）。
	userAPI.GET("/disabled", users.ListDisabledUsers)
	// 面板里的「立即检查」：不必等每日定时任务就能验证策略。
	userAPI.POST("/disabled/check", users.CheckInactiveUsers)
	// 面板里按停用日期分组的「恢复本组 / 恢复所选」。
	userAPI.POST("/disabled/restore", users.RestoreDisabledUsers)
	userAPI.POST("/", users.CreatePasswordUser)
	userAPI.PUT("/:id", users.UpdateUser)
	userAPI.DELETE("/:id", users.DeleteUser)
	userAPI.POST("/:id/reset_password", users.ResetPassword)
	// 清除账号的动态码绑定（强制 MFA 策略的安全阀，仅限 settings.users 写权限）。
	userAPI.POST("/:id/reset_mfa", users.ResetUserMFA)
	userAPI.POST("/:id/enable", users.SetUserEnabled)

	apiKeyAPI := adminAPI.Group("/apikeys", requireAPIKeys)
	apiKeyAPI.GET("/", apikeys.ListAPIKeys)
	apiKeyAPI.POST("/", apikeys.CreateAPIKey)
	apiKeyAPI.DELETE("/:id", apikeys.DeleteAPIKey)

	generalSettingAPI := adminAPI.Group("/general-setting", requireGeneral)
	generalSettingAPI.GET("/", settings.HandleGetGeneralSetting)
	generalSettingAPI.PUT("/", settings.HandleUpdateGeneralSetting)

	// 侧边栏（导航）配置属于「系统配置」，与 general-setting 共用 settings.general 权限：
	// 发布全局布局会影响所有用户，只有持写权限的管理员才能设置或取消。
	sidebarPreferenceAPI := adminAPI.Group("/sidebar_preference", requireGeneral)
	sidebarPreferenceAPI.POST("/global", users.UpdateGlobalSidebarPreference)
	sidebarPreferenceAPI.DELETE("/global", users.ClearGlobalSidebarPreference)

	securitySettingAPI := adminAPI.Group("/security-setting", requireSecurity)
	securitySettingAPI.GET("/", settings.HandleGetSecuritySetting)
	securitySettingAPI.PUT("/", settings.HandleUpdateSecuritySetting)
	securitySettingAPI.GET("/locked-ips", settings.HandleGetLockedLoginIPs)
	// 锁定 IP 支持管理员手动解除与手动拉黑
	securitySettingAPI.POST("/locked-ips", settings.HandleBlockLoginIP)
	securitySettingAPI.DELETE("/locked-ips/:ip", settings.HandleUnlockLoginIP)
	// 锁定用户在用户维度上提供同样的手动解除与手动拉黑
	securitySettingAPI.GET("/locked-users", settings.HandleGetLockedLoginUsers)
	securitySettingAPI.POST("/locked-users", settings.HandleBlockLoginUser)
	securitySettingAPI.DELETE("/locked-users/:username", settings.HandleUnlockLoginUser)

	notificationSettingAPI := adminAPI.Group("/notification-setting", requireNotification)
	notificationSettingAPI.GET("/", notification.HandleGetNotificationSetting)
	notificationSettingAPI.PUT("/", notification.HandleUpdateNotificationSetting)
	notificationSettingAPI.POST("/test-mail", notification.HandleSendTestNotification)
	notificationSettingAPI.POST("/run-daily-checks", notification.HandleRunDailyChecks)

	notificationTemplateAPI := adminAPI.Group("/notification-templates", requireNotification)
	notificationTemplateAPI.GET("/", notification.HandleListNotificationTemplates)
	notificationTemplateAPI.PUT("/:event", notification.HandleUpdateNotificationTemplate)

	notificationSubscriptionAPI := adminAPI.Group("/notification-subscriptions", requireNotification)
	notificationSubscriptionAPI.GET("/", notification.HandleListNotificationSubscriptions)
	notificationSubscriptionAPI.POST("/", notification.HandleCreateNotificationSubscription)
	// 「全选」：一次为多个事件建同一套接收者（已存在的跳过）。
	notificationSubscriptionAPI.POST("/batch", notification.HandleCreateNotificationSubscriptions)
	notificationSubscriptionAPI.PUT("/:id", notification.HandleUpdateNotificationSubscription)
	notificationSubscriptionAPI.DELETE("/:id", notification.HandleDeleteNotificationSubscription)

	// 顶栏通知栏公告：与「通知管理」同属 settings.notification（横幅是发给用户看的投递面）。
	announcementAPI := adminAPI.Group("/announcements", requireNotification)
	announcementAPI.GET("/", announcement.HandleListAnnouncements)
	announcementAPI.POST("/", announcement.HandleCreateAnnouncement)
	announcementAPI.PUT("/:id", announcement.HandleUpdateAnnouncement)
	announcementAPI.DELETE("/:id", announcement.HandleDeleteAnnouncement)

	templateAPI := adminAPI.Group("/templates", requireTemplates)
	templateAPI.POST("/", templates.CreateTemplate)
	templateAPI.PUT("/:id", templates.UpdateTemplate)
	templateAPI.DELETE("/:id", templates.DeleteTemplate)

	helmChartsHandler.RegisterAdminRoutes(adminAPI)
}

func registerProtectedRoutes(r *gin.RouterGroup, authHandler *auth.AuthHandler, cm *cluster.ClusterManager, helmChartsHandler *helm.HelmChartHandler) {
	api := r.Group("/api/v1")
	api.GET("/clusters", authHandler.RequireAuth(), cm.GetClusters)
	// 徽章图标只要求登录（能进切换器的账号本来就看得见集群名），
	// 未上传过时 404，前端回落到默认图标或图标文本。
	api.GET("/clusters/:id/badge-icon", authHandler.RequireAuth(), cluster.GetClusterBadgeIcon)
	// 当前用户可见的权限绑定组（供导航与命名空间分组筛选）
	api.GET("/projects", authHandler.RequireAuth(), bindinggroups.NewHandler(cm).GetUserBindingGroups)
	api.GET("/notifications", authHandler.RequireAuth(), notification.HandleListNotifications)
	api.GET("/notifications/unread-count", authHandler.RequireAuth(), notification.HandleNotificationUnreadCount)
	api.POST("/notifications/read", authHandler.RequireAuth(), notification.HandleMarkNotificationsRead)
	api.POST("/notifications/clear", authHandler.RequireAuth(), notification.HandleClearNotifications)
	// 顶栏通知栏：当前生效的公告，所有登录用户可读（只读、无用户状态）。
	api.GET("/announcements", authHandler.RequireAuth(), announcement.HandleListActiveAnnouncements)
	defaultAPI := api.Group("")
	defaultAPI.Use(authHandler.RequireAuth(), middleware.ClusterMiddleware(cm))
	registerClusterProtectedRoutes(defaultAPI, helmChartsHandler)

	clusterAPI := api.Group("/_clusters/:cluster")
	clusterAPI.Use(authHandler.RequireAuth(), middleware.ClusterMiddleware(cm))
	registerClusterProtectedRoutes(clusterAPI, helmChartsHandler)
}

func registerClusterProtectedRoutes(api *gin.RouterGroup, helmChartsHandler *helm.HelmChartHandler) {
	api.GET("/overview", system.GetOverview)

	metricsHandler := metrics.NewHandler()
	api.GET("/prometheus/resource-usage-history", metricsHandler.GetResourceUsageHistory)
	api.GET("/prometheus/pods/:namespace/:podName/metrics", metricsHandler.GetPodMetrics)

	logsHandler := resources.NewLogsHandler()
	api.GET("/logs/:namespace/:podName/ws", logsHandler.HandleLogsWebSocket)

	terminalHandler := terminal.NewTerminalHandler()
	api.GET("/terminal/:namespace/:podName/ws", terminalHandler.HandleTerminalWebSocket)

	nodeTerminalHandler := terminal.NewNodeTerminalHandler()
	api.GET("/node-terminal/:nodeName/ws", nodeTerminalHandler.HandleNodeTerminalWebSocket)

	kubectlTerminalHandler := terminal.NewKubectlTerminalHandler()
	api.GET("/kubectl-terminal/ws", kubectlTerminalHandler.HandleKubectlTerminalWebSocket)

	searchHandler := search.NewSearchHandler(resources.SearchFuncs())
	api.GET("/search", searchHandler.GlobalSearch)

	resourceApplyHandler := resources.NewResourceApplyHandler()
	api.POST("/resources/apply", resourceApplyHandler.ApplyResource)

	// 这些端点会暴露集群级信息，但 RBACMiddleware 没有单一的
	// Kubernetes 资源可以映射，因此它们自带集群级校验，
	// 而不依赖下面那组中间件。
	clusterWideAPI := api.Group("")
	clusterWideAPI.Use(middleware.RequireClusterAccess())
	clusterWideAPI.GET("/image/tags", images.GetImageTags)
	clusterWideAPI.GET("/templates", templates.ListTemplates)
	helmChartsHandler.RegisterRoutes(clusterWideAPI)

	proxyHandler := proxy.NewProxyHandler()
	proxyHandler.RegisterRoutes(api)

	api.POST("/ai/chat", ai.HandleChat)
	api.POST("/ai/continue", ai.HandleContinue)

	// Gin 在路由注册时就固定其处理器链，因此这里的
	// Use 只覆盖在它*之后*声明的路由。更早注册的路由
	// 必须自己做鉴权——新增注册请放在下面。
	api.Use(middleware.RBACMiddleware())
	resources.RegisterRoutes(api)
}
