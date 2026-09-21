package main

import (
	"context"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/internal"
	"github.com/zxh326/kite/pkg/ai"
	"github.com/zxh326/kite/pkg/audit"
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

// loadGeneralSettingAfterKeyMigration 读入通用设置，并在需要时先校正加密密钥。
//
// 前半段必须在设置行存在之后马上跑：加密密钥的指纹就保存在那一行，从内置默认
// 密钥切换到 KITE_ENCRYPT_KEY 时要重写已存的密文，密钥不匹配则明确报错，而不是
// 逐个 secret 地失败。而后半段的重读不能省：密钥刚切换时第一次读取会因为解不开
// jwt_secret 而失败，只有迁移后重读才能把存库的会话密钥取回来，否则下面的哨兵
// 检查会拒绝启动（表现为「切换密钥后首次启动起不来，重启一次才行」）。
func loadGeneralSettingAfterKeyMigration() {
	if _, err := model.GetGeneralSetting(); err != nil {
		klog.Warningf("Failed to load general setting: %v", err)
	}
	model.EnsureEncryptionKey()
	if _, err := model.GetGeneralSetting(); err != nil {
		klog.Warningf("Failed to reload general setting after encryption key migration: %v", err)
	}
}

func initializeApp(ctx context.Context) (*cluster.ClusterManager, error) {
	common.LoadEnvs()
	if klog.V(1).Enabled() {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	model.InitDB()
	loadGeneralSettingAfterKeyMigration()

	// 此时会话密钥是环境变量值、已存储的值，或者
	// 一个新生成的随机值。走到这一步如果仍是公开的
	// 哨兵值，说明所有路径都失败了，用它签发会话
	// 会让任何人都能伪造管理员令牌。
	if common.JwtSecret == common.DefaultJWTSecret {
		klog.Fatalf("refusing to start: no usable JWT secret (set JWT_SECRET, or KITE_ALLOW_INSECURE_SECRETS=true for local development)")
	}

	rbac.InitRBAC()
	// 「管理员必收」的站内信要靠 rbac 的角色判定才能算全（含权限绑定组授权），
	// 而 pkg/rbac 依赖 pkg/notification，反向 import 会成环，所以在这里注入。
	notification.SetAdminUserResolver(rbac.AdminUserIDs)
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
	// 超级管理员的超管角色与「超级权限绑定」组（幂等）：必须在系统角色播种、
	// 集群导入与超级用户创建之后执行。
	if err := model.EnsureSuperAdminProvisioning(); err != nil {
		klog.Warningf("Failed to provision super administrator bindings: %v", err)
	}
	// 上面的角色分配是直接写库的，重建内存 RBAC 配置，避免启动后一小段时间内
	// 超级角色还没生效。
	rbac.TriggerSync()
	if err := internal.StartConfigWatcher(ctx, common.ConfigFilePath); err != nil {
		klog.Warningf("Failed to watch config file: %v", err)
	}
	scheduler.Start(ctx, cm)
	auth.StartLDAPSync(ctx)
	notification.StartDailyChecker(ctx)
	// 审计记录保留策略（按天滚动，默认 0 = 永久保留）与 syslog 外发（默认关闭）。
	audit.StartRetentionWorker(ctx)
	audit.StartSyslogForwarder()
	// 审计事件 → 标准输出（默认开启）：让只采集 stdout 的日志平台也能查到谁做了什么。
	audit.StartAuditStdout()
	// 审计链路的自监控指标（丢弃 / 失败 / 补传积压）挂到 /metrics。
	audit.RegisterAuditMetrics()
	// 归档链（本地 parquet + 可选 S3/ES）：通道由 sink 唯一决定（三者互斥）。
	// 启动前先确认**唯一落点**可用：目标不可用（如 sink=parquet 却没有归档目录、sink=elasticsearch
	// 却没有节点地址）就等于所有审计记录无处可去，此时宁可起不来，也不要起一个静默丢记录的实例。
	if err := audit.ValidateSinkTarget(common.AuditArchiveDir); err != nil {
		klog.Fatalf("refusing to start: %v", err)
	}
	audit.StartParquetArchiver(ctx, common.AuditArchiveDir)
	// AI 待确认会话的过期回收。
	ai.StartPendingSessionCleanup(ctx)
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
	// 请求关联 ID 必须排在访问日志之前：访问日志与审计事件都要带上它才能串成一条链。
	r.Use(middleware.RequestID())
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
