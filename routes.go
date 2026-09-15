package main

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	promclient "github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/zxh326/kite/pkg/ai"
	"github.com/zxh326/kite/pkg/apikeys"
	"github.com/zxh326/kite/pkg/audit"
	"github.com/zxh326/kite/pkg/auth"
	"github.com/zxh326/kite/pkg/cluster"
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

// metricsAuth optionally protects /metrics with a bearer token.
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
	// Metrics stay reachable for Prometheus, which cannot carry a session
	// cookie. Set KITE_METRICS_TOKEN to require "Authorization: Bearer <token>"
	// instead of leaving the endpoint fully open.
	metricsToken := strings.TrimSpace(os.Getenv("KITE_METRICS_TOKEN"))
	if metricsToken == "" {
		klog.Warningf("KITE_METRICS_TOKEN is not set: /metrics is exposed without authentication")
	}
	r.GET("/metrics", metricsAuth(metricsToken), gin.WrapH(promhttp.HandlerFor(promclient.Gatherers{
		promclient.DefaultGatherer,
		ctrlmetrics.Registry,
	}, promhttp.HandlerOpts{})))
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	r.GET("/api/v1/version", version.GetVersion)
}

func registerAuthRoutes(r *gin.RouterGroup, authHandler *auth.AuthHandler) {
	authGroup := r.Group("/api/auth")
	authGroup.POST("/setup/create_super_user", authHandler.CreateSuperUser)
	authGroup.POST("/login/password", authHandler.PasswordLogin)
	authGroup.GET("/captcha", authHandler.Captcha)
	authGroup.POST("/login/ldap", authHandler.LDAPLogin)
	authGroup.GET("/login", authHandler.Login)
	authGroup.GET("/callback", authHandler.Callback)
	authGroup.POST("/logout", authHandler.Logout)
	authGroup.POST("/refresh", authHandler.RefreshToken)
	authGroup.GET("/user", authHandler.RequireAuth(), authHandler.GetUser)
}

func registerUserRoutes(r *gin.RouterGroup, authHandler *auth.AuthHandler) {
	userGroup := r.Group("/api/users")
	userGroup.PUT("/me", authHandler.RequireAuth(), users.UpdateCurrentUser)
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

	adminAPI.GET("/groups", rbac.ListGroups)
	adminAPI.POST("/groups", rbac.CreateGroup)
	adminAPI.GET("/groups/:name/members", rbac.ListGroupMembers)
	adminAPI.PUT("/groups/:name", rbac.RenameGroup)
	adminAPI.DELETE("/groups/:name", rbac.DeleteGroup)

	adminAPI.GET("/audit-logs", audit.ListAuditLogs)
	adminAPI.GET("/login-logs", audit.ListLoginLogs)
	adminAPI.GET("/password-change-logs", audit.ListPasswordChangeLogs)

	oauthProviderAPI := adminAPI.Group("/oauth-providers")
	oauthProviderAPI.GET("/", authHandler.ListOAuthProviders)
	oauthProviderAPI.POST("/", authHandler.CreateOAuthProvider)
	oauthProviderAPI.GET("/:id", authHandler.GetOAuthProvider)
	oauthProviderAPI.PUT("/:id", authHandler.UpdateOAuthProvider)
	oauthProviderAPI.DELETE("/:id", authHandler.DeleteOAuthProvider)

	ldapSettingAPI := adminAPI.Group("/ldap-setting")
	ldapSettingAPI.GET("/", authHandler.GetLDAPSetting)
	ldapSettingAPI.PUT("/", authHandler.UpdateLDAPSetting)
	ldapSettingAPI.POST("/sync", authHandler.SyncLDAPUsers)
	ldapSettingAPI.GET("/sync", authHandler.GetLDAPSyncStatus)
	ldapSettingAPI.GET("/users", authHandler.ListLDAPImportCandidates)
	ldapSettingAPI.POST("/users/import", authHandler.ImportLDAPUsers)

	clusterAPI := adminAPI.Group("/clusters")
	clusterAPI.GET("/", cm.GetClusterList)
	clusterAPI.GET("/:name/namespaces", cm.ListClusterNamespaces)
	clusterAPI.GET("/:name/nodeport-range", cm.GetNodePortRange)
	clusterAPI.POST("/", cm.CreateCluster)
	clusterAPI.POST("/import", cm.ImportClustersFromKubeconfig)
	clusterAPI.PUT("/:id", cm.UpdateCluster)
	clusterAPI.DELETE("/:id", cm.DeleteCluster)
	// 查看已存的 kubeconfig 属于凭据暴露操作：开启 MFA 后需要二次校验动态码。
	// 注意参数名必须是 :name（GET 树中已有 /:name/namespaces 等通配）。
	clusterAPI.GET("/:name/kubeconfig",
		authHandler.RequireMFAStepUp(), cm.GetClusterKubeconfig)

	rbacAPI := adminAPI.Group("/roles")
	rbacAPI.GET("/", rbac.ListRoles)
	rbacAPI.POST("/", rbac.CreateRole)
	rbacAPI.GET("/:id", rbac.GetRole)
	rbacAPI.PUT("/:id", rbac.UpdateRole)
	rbacAPI.DELETE("/:id", rbac.DeleteRole)
	rbacAPI.POST("/:id/assign", rbac.AssignRole)
	rbacAPI.DELETE("/:id/assign", rbac.UnassignRole)

	userAPI := adminAPI.Group("/users")
	userAPI.GET("/", users.ListUsers)
	userAPI.POST("/", users.CreatePasswordUser)
	userAPI.PUT("/:id", users.UpdateUser)
	userAPI.DELETE("/:id", users.DeleteUser)
	userAPI.POST("/:id/reset_password", users.ResetPassword)
	userAPI.POST("/:id/enable", users.SetUserEnabled)
	adminAPI.POST("/sidebar_preference/global", users.UpdateGlobalSidebarPreference)
	adminAPI.DELETE("/sidebar_preference/global", users.ClearGlobalSidebarPreference)

	apiKeyAPI := adminAPI.Group("/apikeys")
	apiKeyAPI.GET("/", apikeys.ListAPIKeys)
	apiKeyAPI.POST("/", apikeys.CreateAPIKey)
	apiKeyAPI.DELETE("/:id", apikeys.DeleteAPIKey)

	generalSettingAPI := adminAPI.Group("/general-setting")
	generalSettingAPI.GET("/", settings.HandleGetGeneralSetting)
	generalSettingAPI.PUT("/", settings.HandleUpdateGeneralSetting)

	securitySettingAPI := adminAPI.Group("/security-setting")
	securitySettingAPI.GET("/", settings.HandleGetSecuritySetting)
	securitySettingAPI.PUT("/", settings.HandleUpdateSecuritySetting)
	securitySettingAPI.GET("/locked-ips", settings.HandleGetLockedLoginIPs)

	notificationSettingAPI := adminAPI.Group("/notification-setting")
	notificationSettingAPI.GET("/", notification.HandleGetNotificationSetting)
	notificationSettingAPI.PUT("/", notification.HandleUpdateNotificationSetting)
	notificationSettingAPI.POST("/test-mail", notification.HandleSendTestNotification)
	notificationSettingAPI.POST("/run-daily-checks", notification.HandleRunDailyChecks)
	notificationSettingAPI.GET("/disabled-users", notification.HandleListAutoDisabledUsers)

	notificationTemplateAPI := adminAPI.Group("/notification-templates")
	notificationTemplateAPI.GET("/", notification.HandleListNotificationTemplates)
	notificationTemplateAPI.PUT("/:event", notification.HandleUpdateNotificationTemplate)

	notificationSubscriptionAPI := adminAPI.Group("/notification-subscriptions")
	notificationSubscriptionAPI.GET("/", notification.HandleListNotificationSubscriptions)
	notificationSubscriptionAPI.POST("/", notification.HandleCreateNotificationSubscription)
	notificationSubscriptionAPI.PUT("/:id", notification.HandleUpdateNotificationSubscription)
	notificationSubscriptionAPI.DELETE("/:id", notification.HandleDeleteNotificationSubscription)

	templateAPI := adminAPI.Group("/templates")
	templateAPI.POST("/", templates.CreateTemplate)
	templateAPI.PUT("/:id", templates.UpdateTemplate)
	templateAPI.DELETE("/:id", templates.DeleteTemplate)

	helmChartsHandler.RegisterAdminRoutes(adminAPI)
}

func registerProtectedRoutes(r *gin.RouterGroup, authHandler *auth.AuthHandler, cm *cluster.ClusterManager, helmChartsHandler *helm.HelmChartHandler) {
	api := r.Group("/api/v1")
	api.GET("/clusters", authHandler.RequireAuth(), cm.GetClusters)
	api.GET("/notifications", authHandler.RequireAuth(), notification.HandleListNotifications)
	api.GET("/notifications/unread-count", authHandler.RequireAuth(), notification.HandleNotificationUnreadCount)
	api.POST("/notifications/read", authHandler.RequireAuth(), notification.HandleMarkNotificationsRead)
	api.POST("/notifications/client-events", authHandler.RequireAuth(), notification.HandleCreateClientNotification)
	api.POST("/notifications/clear", authHandler.RequireAuth(), notification.HandleClearNotifications)
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

	// These endpoints expose cluster wide information but have no single
	// Kubernetes resource for RBACMiddleware to map onto, so they carry their
	// own cluster level check instead of relying on the group middleware below.
	clusterWideAPI := api.Group("")
	clusterWideAPI.Use(middleware.RequireClusterAccess())
	clusterWideAPI.GET("/image/tags", images.GetImageTags)
	clusterWideAPI.GET("/templates", templates.ListTemplates)
	helmChartsHandler.RegisterRoutes(clusterWideAPI)

	proxyHandler := proxy.NewProxyHandler()
	proxyHandler.RegisterRoutes(api)

	api.POST("/ai/chat", ai.HandleChat)
	api.POST("/ai/continue", ai.HandleContinue)

	// Gin freezes a route's handler chain when the route is registered, so this
	// Use only covers the routes declared *after* it. Anything registered
	// earlier must do its own authorization — keep new registrations below.
	api.Use(middleware.RBACMiddleware())
	resources.RegisterRoutes(api)
}
