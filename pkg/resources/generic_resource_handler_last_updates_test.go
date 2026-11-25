package resources

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"aerolink/pkg/rbac"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// lastUpdatesTestDB 建一套只含审计表的内存库，并写入列表「平台操作时间」要用的记录。
func lastUpdatesTestDB(t *testing.T) *gorm.DB {
	t.Helper()

	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get database: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	t.Cleanup(func() {
		model.DB = originalDB
		_ = sqlDB.Close()
	})
	if err := db.AutoMigrate(&model.User{}, &model.ResourceHistory{}); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	base := time.Date(2026, 10, 20, 8, 0, 0, 0, time.UTC)
	rows := []model.ResourceHistory{
		// nginx：早的一次 update、晚的一次 apply，取最新的那条。
		{CreatedAt: base, ClusterName: "prod", ResourceType: "deployments", ResourceName: "nginx", Namespace: "default", OperationType: "update", Success: true},
		{CreatedAt: base.Add(time.Hour), ClusterName: "prod", ResourceType: "deployments", ResourceName: "nginx", Namespace: "default", OperationType: "apply", Success: true},
		// 失败的写入不算一次修改。
		{CreatedAt: base.Add(2 * time.Hour), ClusterName: "prod", ResourceType: "deployments", ResourceName: "nginx", Namespace: "default", OperationType: "update", Success: false},
		// 删除不进列表，同名新对象会另起一条 create。
		{CreatedAt: base.Add(3 * time.Hour), ClusterName: "prod", ResourceType: "deployments", ResourceName: "nginx", Namespace: "default", OperationType: "delete", Success: true},
		{CreatedAt: base.Add(30 * time.Minute), ClusterName: "prod", ResourceType: "deployments", ResourceName: "web", Namespace: "team-a", OperationType: "patch", Success: true},
		// 别的资源类型/集群不得串味。
		{CreatedAt: base.Add(4 * time.Hour), ClusterName: "prod", ResourceType: "statefulsets", ResourceName: "db", Namespace: "default", OperationType: "update", Success: true},
		{CreatedAt: base.Add(4 * time.Hour), ClusterName: "staging", ResourceType: "deployments", ResourceName: "other", Namespace: "default", OperationType: "update", Success: true},
	}
	for i := range rows {
		if err := db.Create(&rows[i]).Error; err != nil {
			t.Fatalf("seed audit record: %v", err)
		}
	}
	return db
}

// lastUpdatesRequest 走一次真实路由，确保 Param("namespace") 的取法与线上一致。
func lastUpdatesRequest(t *testing.T, user model.User, path string) *httptest.ResponseRecorder {
	t.Helper()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler := NewDeploymentHandler()
	router.Use(func(c *gin.Context) {
		c.Set("cluster", &cluster.ClientSet{Name: "prod"})
		c.Set("user", user)
		c.Next()
	})
	router.GET("/deployments/:namespace/last-updates", handler.ListLastUpdates)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

func decodeLastUpdates(t *testing.T, recorder *httptest.ResponseRecorder) map[string]string {
	t.Helper()

	var response struct {
		Data []struct {
			ResourceName  string    `json:"resourceName"`
			Namespace     string    `json:"namespace"`
			LastUpdatedAt time.Time `json:"lastUpdatedAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, recorder.Body.String())
	}

	updates := map[string]string{}
	for _, item := range response.Data {
		if item.LastUpdatedAt.IsZero() {
			t.Fatalf("lastUpdatedAt 解析成零值; body=%s", recorder.Body.String())
		}
		updates[item.Namespace+"/"+item.ResourceName] = item.LastUpdatedAt.UTC().Format(time.RFC3339)
	}
	return updates
}

// TestListLastUpdatesScopedToNamespace 覆盖单命名空间视图：只回该命名空间里
// 成功写操作的最大时间，失败的、删除的、别的资源类型与别的集群都不参与。
func TestListLastUpdatesScopedToNamespace(t *testing.T) {
	lastUpdatesTestDB(t)
	originalSink := model.AuditSink
	originalConfig := rbac.RBACConfig
	t.Cleanup(func() {
		model.AuditSink = originalSink
		rbac.RBACConfig = originalConfig
	})
	model.AuditSink = model.AuditSinkDatabase

	recorder := lastUpdatesRequest(t, model.User{Username: "alice"}, "/deployments/default/last-updates")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}

	updates := decodeLastUpdates(t, recorder)
	if len(updates) != 1 {
		t.Fatalf("updates = %+v, want only default/nginx", updates)
	}
	if got := updates["default/nginx"]; got != time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC).Format(time.RFC3339) {
		t.Fatalf("default/nginx = %q, want 2026-10-20T09:00:00Z（最新一次成功写入）", got)
	}
}

// TestListLastUpdatesFiltersAllNamespaces 覆盖 `_all` 视图：跨命名空间取数时
// 逐条判读权限，与 list 处理器同一口径——只授权 default 的账号看不到 team-a。
func TestListLastUpdatesFiltersAllNamespaces(t *testing.T) {
	lastUpdatesTestDB(t)
	originalSink := model.AuditSink
	originalConfig := rbac.RBACConfig
	t.Cleanup(func() {
		model.AuditSink = originalSink
		rbac.RBACConfig = originalConfig
	})
	model.AuditSink = model.AuditSinkDatabase

	roles := []common.Role{{
		Name:       "deployment-default-reader",
		Clusters:   []string{"prod"},
		Namespaces: []string{"default"},
		Resources:  []string{string(common.Deployments)},
		Verbs:      []string{string(common.VerbGet)},
	}}

	limited := decodeLastUpdates(t, lastUpdatesRequest(t, model.User{Username: "alice", Roles: roles}, "/deployments/_all/last-updates"))
	if len(limited) != 1 {
		t.Fatalf("limited updates = %+v, want only default/nginx", limited)
	}

	broadened := append([]common.Role{}, roles...)
	broadened = append(broadened, common.Role{
		Name:       "deployment-team-reader",
		Clusters:   []string{"prod"},
		Namespaces: []string{"team-a"},
		Resources:  []string{string(common.Deployments)},
		Verbs:      []string{string(common.VerbGet)},
	})
	all := decodeLastUpdates(t, lastUpdatesRequest(t, model.User{Username: "alice", Roles: broadened}, "/deployments/_all/last-updates"))
	if len(all) != 2 || all["team-a/web"] == "" || all["default/nginx"] == "" {
		t.Fatalf("all updates = %+v, want default/nginx 与 team-a/web 两条", all)
	}
}

// TestListLastUpdatesRequiresDatabaseSink 覆盖 sink≠database 的拒绝路径：
// 审计不落库时这个能力不存在，界面要拿到明确信号而不是空列表。
func TestListLastUpdatesRequiresDatabaseSink(t *testing.T) {
	lastUpdatesTestDB(t)
	originalSink := model.AuditSink
	originalConfig := rbac.RBACConfig
	t.Cleanup(func() {
		model.AuditSink = originalSink
		rbac.RBACConfig = originalConfig
	})
	model.AuditSink = model.AuditSinkParquet

	recorder := lastUpdatesRequest(t, model.User{Username: "alice"}, "/deployments/default/last-updates")
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", recorder.Code, recorder.Body.String())
	}
}
