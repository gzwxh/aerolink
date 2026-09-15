package main

import (
	"context"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/internal"
	"github.com/zxh326/kite/pkg/auth"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/middleware"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/notification"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/scheduler"
	"github.com/zxh326/kite/pkg/templates"
	"k8s.io/klog/v2"
)

func initializeApp(ctx context.Context) (*cluster.ClusterManager, error) {
	common.LoadEnvs()
	if klog.V(1).Enabled() {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	model.InitDB()
	if _, err := model.GetGeneralSetting(); err != nil {
		klog.Warningf("Failed to load general setting: %v", err)
	}
	// Reconcile the encryption key right after the settings row exists (the
	// fingerprint is stored there): switching away from the built-in default
	// key rewrites the stored ciphertext, and a mismatched key is reported
	// instead of failing one secret at a time.
	model.EnsureEncryptionKey()

	// By now the session secret is the environment value, the stored one or a
	// freshly generated random value. Reaching this point with the published
	// sentinel means every path failed, and signing sessions with it would let
	// anyone forge an admin token.
	if common.JwtSecret == common.DefaultJWTSecret {
		klog.Fatalf("refusing to start: no usable JWT secret (set JWT_SECRET, or KITE_ALLOW_INSECURE_SECRETS=true for local development)")
	}

	rbac.InitRBAC()
	templates.InitTemplates()
	// 问候模板必须在后台任务前播种，否则定时通知会因缺少模板被跳过。
	if _, err := model.EnsureNotificationTemplates(); err != nil {
		klog.Warningf("Failed to seed notification templates: %v", err)
	}
	internal.LoadConfigFromFile(common.ConfigFilePath)
	if common.ConfigFilePath == "" {
		internal.LoadConfigFromEnv()
	}

	cm, err := cluster.NewClusterManager()
	if err != nil {
		return nil, err
	}
	if err := internal.StartConfigWatcher(ctx, common.ConfigFilePath); err != nil {
		klog.Warningf("Failed to watch config file: %v", err)
	}
	scheduler.Start(ctx, cm)
	auth.StartLDAPSync(ctx)
	notification.StartDailyChecker(ctx)
	return cm, nil
}

func buildEngine(cm *cluster.ClusterManager) *gin.Engine {
	r := gin.New()
	middleware.ConfigureRawPathRouting(r)
	configureTrustedProxies(r)
	r.Use(middleware.Metrics())
	if !common.DisableGZIP {
		klog.Info("GZIP compression is enabled")
		r.Use(gzip.Gzip(gzip.DefaultCompression, gzip.WithExcludedPaths([]string{"/metrics"})))
	}
	r.Use(gin.Recovery())
	r.Use(middleware.SecurityHeaders())
	r.Use(middleware.Logger())
	r.Use(middleware.DevCORS(common.CORSAllowedOrigins))

	base := r.Group(common.Base)
	setupAPIRouter(base, cm)
	setupStatic(r)

	return r
}

func configureTrustedProxies(r *gin.Engine) {
	var trustedProxies []string
	if len(common.TrustedProxies) > 0 {
		trustedProxies = common.TrustedProxies
	}
	if err := r.SetTrustedProxies(trustedProxies); err != nil {
		klog.Fatalf("Failed to configure trusted proxies: %v", err)
	}
}
