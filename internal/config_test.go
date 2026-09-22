package internal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/auth"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/utils"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// setupTestDB 初始化用于测试的内存 SQLite 数据库。
// 它会返回一个恢复原始 DB 的清理函数。
func setupTestDB(t *testing.T) {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("failed to open test database: %v", err)
	}
	if err := db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
		t.Fatalf("failed to enable foreign keys: %v", err)
	}

	models := []any{
		model.User{},
		model.Cluster{},
		model.GeneralSetting{},
		model.SecuritySetting{},
		model.PasswordHistory{},
		model.LDAPSetting{},
		model.OAuthProvider{},
		model.Role{},
		model.RoleAssignment{},
	}
	for _, m := range models {
		if err := db.AutoMigrate(m); err != nil {
			t.Fatalf("failed to migrate: %v", err)
		}
	}

	oldDB := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = oldDB })
}

// saveManagedSections 保存并恢复全局 ManagedSections map。
func saveManagedSections(t *testing.T) {
	t.Helper()
	orig := common.ManagedSections
	common.ManagedSections = map[string]bool{}
	t.Cleanup(func() { common.ManagedSections = orig })
}

const testConfigYAML = `clusters:
  - name: prod
    description: "Production cluster"
    config: |
      apiVersion: v1
      kind: Config
      clusters:
        - cluster:
            server: https://k8s.example.com
          name: prod
    prometheusURL: "http://prom:9090"
    default: true
  - name: local
    inCluster: true

oauth:
  - name: google
    clientId: "test-client-id"
    clientSecret: "test-secret"
    issuer: "https://accounts.google.com"
    scopes: "openid,profile,email"
    usernameClaim: "email"
    enabled: true

ldap:
  enabled: true
  serverUrl: "ldaps://ldap.example.com:636"
  bindDn: "cn=admin,dc=example,dc=com"
  bindPassword: "test-bind-password"
  userBaseDn: "ou=users,dc=example,dc=com"
  userFilter: "(uid=%s)"
  groupBaseDn: "ou=groups,dc=example,dc=com"
  groupFilter: "(member=%s)"

rbac:
  roles:
    - name: admin
      description: "Full access"
      clusters: ["*"]
      namespaces: ["*"]
      resources: ["*"]
      verbs: ["*"]
    - name: viewer
      description: "Read-only"
      clusters: ["*"]
      namespaces: ["*"]
      resources: ["*"]
      verbs: ["get", "log"]
    - name: dev-team
      description: "Dev team access"
      clusters: ["dev-*", "staging-*"]
      namespaces: ["*"]
      resources: ["*"]
      verbs: ["get", "create", "update", "delete", "log"]
  roleMapping:
    - name: admin
      users: ["alice", "bob"]
      oidcGroups: ["platform-admins"]
    - name: viewer
      users: ["*"]
    - name: dev-team
      oidcGroups: ["developers"]
`

// TestApplyAuditSinkIgnoresRuntimeChanges：sink 只在启动时确定，配置文件热更新试图切换时必须
// 保持原值（半生效会丢记录：写入还在旧通道，查询已经切到新通道）。
func TestApplyAuditSinkIgnoresRuntimeChanges(t *testing.T) {
	originalSink := model.AuditSink
	t.Cleanup(func() {
		model.AuditSink = originalSink
		auditSinkResolved = false
	})
	auditSinkResolved = false
	model.AuditSink = model.AuditSinkDatabase

	applyAuditSink("parquet")
	if model.AuditSink != model.AuditSinkParquet {
		t.Fatalf("首次应用应生效, got %q", model.AuditSink)
	}

	// 热重载（applyConfig 会在配置文件变化时再跑一次）尝试切到别的存储。
	applyAuditSink("elasticsearch")
	if model.AuditSink != model.AuditSinkParquet {
		t.Errorf("热重载不得改变 sink（会变成半生效状态、丢审计记录）, got %q", model.AuditSink)
	}

	// 同一个值重复应用是正常的（每次重载都会跑），不该有任何副作用。
	applyAuditSink("parquet")
	if model.AuditSink != model.AuditSinkParquet {
		t.Errorf("重复应用同一个 sink 应保持不变, got %q", model.AuditSink)
	}
}

// 只设环境变量、不挂配置文件时，AEROLINK_AUDIT_SINK 也必须生效：app.go 在「有配置文件」与「只有环境
// 变量」两条路里只会走一条，两边都得认得这个变量，否则部署者以为配了、实际还是 database。
func TestLoadConfigFromEnvAppliesAuditSink(t *testing.T) {
	setupTestDB(t)

	originalSink := model.AuditSink
	t.Cleanup(func() {
		model.AuditSink = originalSink
		auditSinkResolved = false
	})
	auditSinkResolved = false
	model.AuditSink = model.AuditSinkDatabase

	t.Setenv("AEROLINK_AUDIT_SINK", "parquet")
	// 指向一个不存在的 kubeconfig：避免用例去读开发机上的 ~/.kube/config。
	t.Setenv("KUBECONFIG", filepath.Join(t.TempDir(), "absent-kubeconfig"))

	LoadConfigFromEnv()

	if model.AuditSink != model.AuditSinkParquet {
		t.Fatalf("AEROLINK_AUDIT_SINK=parquet 未生效, sink = %q", model.AuditSink)
	}
}

// TestLoadConfigFromFile_EndToEnd 用真实数据库测试完整的配置文件加载流程。
func TestLoadConfigFromFile_EndToEnd(t *testing.T) { //nolint:gocyclo // 该用例用多个子测试做端到端覆盖
	setupTestDB(t)
	saveManagedSections(t)

	// 排空 SyncNow，让 applyRBAC 中的 TriggerSync 不会阻塞
	oldSyncNow := rbac.SyncNow
	rbac.SyncNow = make(chan struct{}, 10)
	t.Cleanup(func() { rbac.SyncNow = oldSyncNow })

	// 先创建系统角色（通常由 InitRBAC 完成）
	if err := model.InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}

	// 把配置文件写入临时目录
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(testConfigYAML), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// 加载配置
	LoadConfigFromFile(configPath)

	// --- 校验受管分区 ---
	t.Run("ManagedSections", func(t *testing.T) {
		for _, section := range []string{"clusters", "oauth", "ldap", "rbac"} {
			if !common.IsSectionManaged(section) {
				t.Errorf("expected section %q to be managed", section)
			}
		}
	})

	// --- 校验集群 ---
	t.Run("Clusters", func(t *testing.T) {
		clusters, err := model.ListClusters()
		if err != nil {
			t.Fatalf("ListClusters: %v", err)
		}
		if len(clusters) != 2 {
			t.Fatalf("expected 2 clusters, got %d", len(clusters))
		}

		byName := map[string]*model.Cluster{}
		for _, c := range clusters {
			byName[c.Name] = c
		}

		prod := byName["prod"]
		if prod == nil {
			t.Fatal("prod cluster not found")
		}
		if prod.PrometheusURL != "http://prom:9090" {
			t.Errorf("prod prometheus URL = %q, want %q", prod.PrometheusURL, "http://prom:9090")
		}
		if !prod.IsDefault {
			t.Error("prod should be default")
		}
		if prod.Description != "Production cluster" {
			t.Errorf("prod description = %q", prod.Description)
		}

		local := byName["local"]
		if local == nil {
			t.Fatal("local cluster not found")
		}
		if !local.InCluster {
			t.Error("local should be inCluster")
		}
	})

	// --- 校验 OAuth ---
	t.Run("OAuth", func(t *testing.T) {
		providers, err := model.GetAllOAuthProviders()
		if err != nil {
			t.Fatalf("GetAllOAuthProviders: %v", err)
		}
		if len(providers) != 1 {
			t.Fatalf("expected 1 OAuth provider, got %d", len(providers))
		}
		p := providers[0]
		if string(p.Name) != "google" {
			t.Errorf("provider name = %q, want %q", p.Name, "google")
		}
		if p.ClientID != "test-client-id" {
			t.Errorf("clientId = %q", p.ClientID)
		}
		if !p.Enabled {
			t.Error("provider should be enabled")
		}
		if p.Issuer != "https://accounts.google.com" {
			t.Errorf("issuer = %q", p.Issuer)
		}
		if p.UsernameClaim != "email" {
			t.Errorf("usernameClaim = %q", p.UsernameClaim)
		}
	})

	// --- 校验 LDAP ---
	t.Run("LDAP", func(t *testing.T) {
		setting, err := model.GetLDAPSetting()
		if err != nil {
			t.Fatalf("GetLDAPSetting: %v", err)
		}
		if !setting.Enabled {
			t.Error("LDAP should be enabled")
		}
		if setting.ServerURL != "ldaps://ldap.example.com:636" {
			t.Errorf("serverUrl = %q", setting.ServerURL)
		}
		if setting.BindDN != "cn=admin,dc=example,dc=com" {
			t.Errorf("bindDn = %q", setting.BindDN)
		}
		if setting.UserBaseDN != "ou=users,dc=example,dc=com" {
			t.Errorf("userBaseDn = %q", setting.UserBaseDN)
		}
		if setting.GroupBaseDN != "ou=groups,dc=example,dc=com" {
			t.Errorf("groupBaseDn = %q", setting.GroupBaseDN)
		}
	})

	// --- 校验 RBAC 角色 ---
	t.Run("RBAC_Roles", func(t *testing.T) {
		var roles []model.Role
		if err := model.DB.Find(&roles).Error; err != nil {
			t.Fatalf("Find roles: %v", err)
		}
		// 4 个内置系统角色（管理员/审计员/安全管理员/只读管理员）+ 配置里的 dev-team。
		// 代次 3 起内置超级角色已并入管理员，不再是独立角色。
		if len(roles) != 5 {
			t.Fatalf("expected 5 roles, got %d", len(roles))
		}
		byName := map[string]model.Role{}
		for _, r := range roles {
			byName[r.Name] = r
		}

		admin := byName["admin"]
		if admin.Description != "Full access" {
			t.Errorf("admin description = %q", admin.Description)
		}
		if !admin.IsSystem {
			t.Error("admin should still be system role")
		}

		viewer := byName["viewer"]
		if viewer.Description != "Read-only" {
			t.Errorf("viewer description = %q", viewer.Description)
		}

		devTeam := byName["dev-team"]
		if devTeam.Description != "Dev team access" {
			t.Errorf("dev-team description = %q", devTeam.Description)
		}
	})

	// --- 校验 RBAC 角色分配 ---
	t.Run("RBAC_Assignments", func(t *testing.T) {
		var assignments []model.RoleAssignment
		if err := model.DB.Find(&assignments).Error; err != nil {
			t.Fatalf("Find assignments: %v", err)
		}
		// admin：alice、bob（用户）+ platform-admins（组）= 3
		// viewer：*（用户）= 1
		// dev-team：developers（组）= 1
		// 合计 = 5
		if len(assignments) != 5 {
			t.Fatalf("expected 5 assignments, got %d", len(assignments))
		}
	})
}

// TestLoadConfigFromFile_EnvExpansion 测试 ${ENV_VAR} 占位符展开。
func TestLoadConfigFromFile_EnvExpansion(t *testing.T) {
	setupTestDB(t)
	saveManagedSections(t)

	t.Setenv("TEST_OAUTH_SECRET", "expanded-secret-value")

	configYAML := `oauth:
  - name: test-provider
    clientId: "my-client"
    clientSecret: "${TEST_OAUTH_SECRET}"
    issuer: "https://example.com"
    enabled: true
`

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configYAML), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	LoadConfigFromFile(configPath)

	providers, err := model.GetAllOAuthProviders()
	if err != nil {
		t.Fatalf("GetAllOAuthProviders: %v", err)
	}
	if len(providers) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(providers))
	}
	if string(providers[0].ClientSecret) != "expanded-secret-value" {
		t.Errorf("clientSecret = %q, want %q", providers[0].ClientSecret, "expanded-secret-value")
	}
}

// TestLoadConfigFromFile_PartialConfig 测试只有已配置的分区才会变为受管。
func TestLoadConfigFromFile_PartialConfig(t *testing.T) {
	setupTestDB(t)
	saveManagedSections(t)

	// 只配置 clusters 分区
	configYAML := `clusters:
  - name: test-only
    inCluster: true
`
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configYAML), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	LoadConfigFromFile(configPath)

	if !common.IsSectionManaged("clusters") {
		t.Error("clusters should be managed")
	}
	for _, section := range []string{"oauth", "ldap", "rbac"} {
		if common.IsSectionManaged(section) {
			t.Errorf("section %q should NOT be managed", section)
		}
	}
}

// TestLoadConfigFromFile_EmptyPath 测试空路径时不做任何事。
func TestLoadConfigFromFile_EmptyPath(t *testing.T) {
	saveManagedSections(t)

	LoadConfigFromFile("")

	for _, section := range []string{"clusters", "oauth", "ldap", "rbac"} {
		if common.IsSectionManaged(section) {
			t.Errorf("section %q should NOT be managed with empty path", section)
		}
	}
}

// TestLoadConfigFromFile_StartupOverwrite 测试配置文件会覆盖已有的 DB 数据。
func TestLoadConfigFromFile_StartupOverwrite(t *testing.T) {
	setupTestDB(t)
	saveManagedSections(t)

	// 预置一个已有集群
	existing := &model.Cluster{
		Name:      "old-cluster",
		InCluster: true,
		Enable:    true,
	}
	if err := model.AddCluster(existing); err != nil {
		t.Fatalf("AddCluster: %v", err)
	}

	configYAML := `clusters:
  - name: new-cluster
    inCluster: true
`
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configYAML), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	LoadConfigFromFile(configPath)

	clusters, _ := model.ListClusters()
	if len(clusters) != 1 {
		t.Fatalf("expected 1 cluster after overwrite, got %d", len(clusters))
	}
	if clusters[0].Name != "new-cluster" {
		t.Errorf("cluster name = %q, want %q", clusters[0].Name, "new-cluster")
	}
}

// TestBootstrapWithManagedClusters 测试在集群受管且存在用户时
// bootstrap 返回 initialized=true。
func TestBootstrapWithManagedClusters(t *testing.T) {
	setupTestDB(t)
	saveManagedSections(t)
	common.ManagedSections["clusters"] = true

	// 排空 SyncNow，让 TriggerSync 不会阻塞
	oldSyncNow := rbac.SyncNow
	rbac.SyncNow = make(chan struct{}, 10)
	t.Cleanup(func() { rbac.SyncNow = oldSyncNow })

	// 创建一个用户，让 bootstrap 认为第 1 步（用户）已完成
	if err := model.InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}
	if err := model.AddSuperUser(&model.User{Username: "admin", Password: "pass"}); err != nil {
		t.Fatalf("AddSuperUser: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/v1/bootstrap", auth.NewAuthHandler().Bootstrap)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	setup, ok := result["setup"].(map[string]any)
	if !ok {
		t.Fatalf("setup = %v, want object", result["setup"])
	}
	if init, ok := setup["initialized"].(bool); !ok || !init {
		t.Errorf("initialized = %v, want true", setup["initialized"])
	}
	if step, ok := setup["step"].(float64); !ok || step != 2 {
		t.Errorf("step = %v, want 2", setup["step"])
	}
}

// TestBootstrapWithManagedClustersNoUsers 测试在集群受管但不存在用户时
// bootstrap 返回 initialized=false。
func TestBootstrapWithManagedClustersNoUsers(t *testing.T) {
	setupTestDB(t)
	saveManagedSections(t)
	common.ManagedSections["clusters"] = true

	// 保存并恢复 AnonymousUserEnabled
	origAnon := common.AnonymousUserEnabled
	common.AnonymousUserEnabled = false
	t.Cleanup(func() { common.AnonymousUserEnabled = origAnon })

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/v1/bootstrap", auth.NewAuthHandler().Bootstrap)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	setup, ok := result["setup"].(map[string]any)
	if !ok {
		t.Fatalf("setup = %v, want object", result["setup"])
	}
	if init, ok := setup["initialized"].(bool); !ok || init {
		t.Errorf("initialized = %v, want false (no users)", setup["initialized"])
	}
	if step, ok := setup["step"].(float64); !ok || step != 0 {
		t.Errorf("step = %v, want 0 (no users)", setup["step"])
	}
}

// TestLoadConfigFromFile_SuperUser 测试首次启动时会创建 superUser。
func TestLoadConfigFromFile_SuperUser(t *testing.T) {
	setupTestDB(t)
	saveManagedSections(t)

	// 排空 SyncNow，让 TriggerSync 不会阻塞
	oldSyncNow := rbac.SyncNow
	rbac.SyncNow = make(chan struct{}, 10)
	t.Cleanup(func() { rbac.SyncNow = oldSyncNow })

	// 创建系统角色（AddSuperUser -> AddRoleAssignment 需要）
	if err := model.InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}

	configYAML := `superUser:
  username: "testadmin"
  password: "testpass123"
clusters:
  - name: test
    inCluster: true
`
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configYAML), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	LoadConfigFromFile(configPath)

	// 校验超级用户已创建
	uc, _ := model.CountUsers()
	if uc != 1 {
		t.Fatalf("expected 1 user, got %d", uc)
	}

	user, err := model.GetUserByUsername("testadmin")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if user.Username != "testadmin" {
		t.Errorf("username = %q, want %q", user.Username, "testadmin")
	}
}

// TestLoadConfigFromFile_SuperUserUpdatesPassword 测试重启时会更新 superUser 密码。
func TestLoadConfigFromFile_SuperUserUpdatesPassword(t *testing.T) {
	setupTestDB(t)
	saveManagedSections(t)

	oldSyncNow := rbac.SyncNow
	rbac.SyncNow = make(chan struct{}, 10)
	t.Cleanup(func() { rbac.SyncNow = oldSyncNow })

	if err := model.InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}

	// 首次启动：创建超级用户
	configYAML := `superUser:
  username: "myadmin"
  password: "old-password"
`
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configYAML), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	LoadConfigFromFile(configPath)

	// 第二次启动：更新密码
	configYAML2 := `superUser:
  username: "myadmin"
  password: "new-password"
`
	if err := os.WriteFile(configPath, []byte(configYAML2), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	LoadConfigFromFile(configPath)

	// 仍然应当只有 1 个用户
	uc, _ := model.CountUsers()
	if uc != 1 {
		t.Fatalf("expected 1 user, got %d", uc)
	}

	// 校验密码已更新（可以用新密码登录）
	user, err := model.GetUserByUsername("myadmin")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if !utils.CheckPasswordHash("new-password", user.Password) {
		t.Error("password should have been updated to new-password")
	}
}

// TestLoadConfigFromFile_SuperUserWithRBAC 测试即使 RBAC roleMapping
// 没有显式包含 superUser，超级用户仍保留管理员角色。
func TestLoadConfigFromFile_SuperUserWithRBAC(t *testing.T) {
	setupTestDB(t)
	saveManagedSections(t)

	oldSyncNow := rbac.SyncNow
	rbac.SyncNow = make(chan struct{}, 10)
	t.Cleanup(func() { rbac.SyncNow = oldSyncNow })

	if err := model.InitDefaultRole(); err != nil {
		t.Fatalf("InitDefaultRole: %v", err)
	}

	// 配置里同时有 superUser 和 RBAC，但 roleMapping 不包含该 superUser
	configYAML := `superUser:
  username: "myadmin"
  password: "mypass"
rbac:
  roles:
    - name: admin
      description: "Full access"
      clusters: ["*"]
      namespaces: ["*"]
      resources: ["*"]
      verbs: ["*"]
    - name: viewer
      description: "Read-only"
      clusters: ["*"]
      namespaces: ["*"]
      resources: ["*"]
      verbs: ["get", "log"]
  roleMapping:
    - name: viewer
      users: ["*"]
`
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configYAML), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	LoadConfigFromFile(configPath)

	// 校验超级用户已创建
	user, err := model.GetUserByUsername("myadmin")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if user.Username != "myadmin" {
		t.Errorf("username = %q", user.Username)
	}

	// 校验超级用户拥有管理员角色分配
	// （superUser 在 RBAC 之后应用，所以不应被抹掉）
	adminRole, err := model.GetRoleByName("admin")
	if err != nil {
		t.Fatalf("GetRoleByName(admin): %v", err)
	}

	var assignment model.RoleAssignment
	err = model.DB.Where("role_id = ? AND subject_type = ? AND subject = ?",
		adminRole.ID, model.SubjectTypeUser, "myadmin").First(&assignment).Error
	if err != nil {
		t.Fatalf("super user should have admin role assignment, but got: %v", err)
	}

	// 模拟第二次启动：applyRBAC 会抹掉所有分配，之后 applySuperUser
	// 必须重新创建管理员角色分配。
	LoadConfigFromFile(configPath)

	var assignment2 model.RoleAssignment
	err = model.DB.Where("role_id = ? AND subject_type = ? AND subject = ?",
		adminRole.ID, model.SubjectTypeUser, "myadmin").First(&assignment2).Error
	if err != nil {
		t.Fatalf("after second startup, super user should still have admin role, but got: %v", err)
	}
}
