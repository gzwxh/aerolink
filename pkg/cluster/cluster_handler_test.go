package cluster

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestClusterConfigurationLifecyclePreservesSecretsAndDefault(t *testing.T) {
	setupClusterHandlerTestDB(t)
	manager := &ClusterManager{clusters: map[string]*ClientSet{}, errors: map[string]string{}}
	router := gin.New()
	router.POST("/clusters", manager.CreateCluster)
	router.GET("/clusters", manager.GetClusterList)
	router.PUT("/clusters/:id", manager.UpdateCluster)
	router.DELETE("/clusters/:id", manager.DeleteCluster)

	create := performClusterRequest(router, http.MethodPost, "/clusters", `{"name":"primary","description":"main","config":"secret-kubeconfig","isDefault":true}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want %d: %s", create.Code, http.StatusCreated, create.Body.String())
	}
	primary, err := model.GetClusterByName("primary")
	if err != nil {
		t.Fatalf("loading created cluster: %v", err)
	}
	if !primary.IsDefault || !primary.Enable || string(primary.Config) != "secret-kubeconfig" {
		t.Fatalf("created cluster = %#v", primary)
	}

	updateBody := `{"name":"renamed","description":"updated","config":"","prometheusURL":"https://prom.example.com","isDefault":true,"enabled":true}`
	update := performClusterRequest(router, http.MethodPut, fmt.Sprintf("/clusters/%d", primary.ID), updateBody)
	if update.Code != http.StatusOK {
		t.Fatalf("update status = %d, want %d: %s", update.Code, http.StatusOK, update.Body.String())
	}
	updated, err := model.GetClusterByID(primary.ID)
	if err != nil {
		t.Fatalf("loading updated cluster: %v", err)
	}
	if updated.Name != "renamed" || updated.Description != "updated" || updated.PrometheusURL != "https://prom.example.com" {
		t.Fatalf("updated cluster = %#v", updated)
	}
	if string(updated.Config) != "secret-kubeconfig" {
		t.Fatalf("blank update erased kubeconfig: %q", updated.Config)
	}

	manager.mu.Lock()
	manager.clusters["renamed"] = &ClientSet{Name: "renamed", Version: "v1.36.2"}
	manager.mu.Unlock()
	list := performClusterRequest(router, http.MethodGet, "/clusters", "")
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d, want %d", list.Code, http.StatusOK)
	}
	var listed []map[string]any
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decoding list response: %v", err)
	}
	if len(listed) != 1 || listed[0]["config"] != "" || listed[0]["version"] != "v1.36.2" {
		t.Fatalf("listed clusters = %#v", listed)
	}
	if strings.Contains(list.Body.String(), "secret-kubeconfig") {
		t.Fatal("cluster list exposed kubeconfig")
	}

	deleteDefault := performClusterRequest(router, http.MethodDelete, fmt.Sprintf("/clusters/%d", primary.ID), "")
	if deleteDefault.Code != http.StatusBadRequest {
		t.Fatalf("default delete status = %d, want %d", deleteDefault.Code, http.StatusBadRequest)
	}

	secondary := &model.Cluster{Name: "secondary", Config: "secondary-config", Enable: true}
	if err := model.AddCluster(secondary); err != nil {
		t.Fatalf("creating secondary cluster: %v", err)
	}
	deleteSecondary := performClusterRequest(router, http.MethodDelete, fmt.Sprintf("/clusters/%d", secondary.ID), "")
	if deleteSecondary.Code != http.StatusOK {
		t.Fatalf("secondary delete status = %d, want %d: %s", deleteSecondary.Code, http.StatusOK, deleteSecondary.Body.String())
	}
	if _, err := model.GetClusterByID(secondary.ID); err == nil {
		t.Fatal("deleted secondary cluster still exists")
	}
}

// 只改部分字段的请求不能把没给的字段按零值写回：以前 in_cluster / is_default /
// enabled 是非指针 bool，一个只改描述的请求会静默停用集群、清掉默认集群标记。
func TestUpdateClusterKeepsFieldsOmittedFromRequest(t *testing.T) {
	setupClusterHandlerTestDB(t)
	manager := &ClusterManager{clusters: map[string]*ClientSet{}, errors: map[string]string{}}
	router := gin.New()
	router.PUT("/clusters/:id", manager.UpdateCluster)

	cluster := &model.Cluster{
		Name:          "primary",
		Description:   "main",
		PrometheusURL: "https://prom.example.com",
		Config:        model.SecretString("secret-kubeconfig"),
		Enable:        true,
		IsDefault:     true,
	}
	if err := model.AddCluster(cluster); err != nil {
		t.Fatalf("creating cluster: %v", err)
	}

	response := performClusterRequest(router, http.MethodPut,
		fmt.Sprintf("/clusters/%d", cluster.ID), `{"description":"renamed"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("partial update status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}

	after, err := model.GetClusterByID(cluster.ID)
	if err != nil {
		t.Fatalf("reloading cluster: %v", err)
	}
	if after.Description != "renamed" {
		t.Errorf("description = %q, want the updated value", after.Description)
	}
	if !after.Enable {
		t.Error(`omitted "enabled" was written back as false and silently disabled the cluster`)
	}
	if !after.IsDefault {
		t.Error(`omitted "isDefault" was written back as false and cleared the default cluster`)
	}
	if after.PrometheusURL != "https://prom.example.com" || string(after.Config) != "secret-kubeconfig" {
		t.Errorf("omitted optional fields were overwritten: %#v", after)
	}

	// 显式给出的值仍然要生效，别被「保留旧值」掩盖掉。
	response = performClusterRequest(router, http.MethodPut,
		fmt.Sprintf("/clusters/%d", cluster.ID), `{"enabled":false,"isDefault":false,"prometheusURL":""}`)
	if response.Code != http.StatusOK {
		t.Fatalf("explicit update status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	after, err = model.GetClusterByID(cluster.ID)
	if err != nil {
		t.Fatalf("reloading cluster: %v", err)
	}
	if after.Enable || after.IsDefault {
		t.Errorf("explicit false values were ignored: enable=%v isDefault=%v", after.Enable, after.IsDefault)
	}
	if after.PrometheusURL != "" {
		t.Errorf("explicit empty prometheusURL was ignored: %q", after.PrometheusURL)
	}
}

func TestGetClustersFiltersByAccessAndSortsFailures(t *testing.T) {
	gin.SetMode(gin.TestMode)
	manager := &ClusterManager{
		clusters: map[string]*ClientSet{
			"secret": {Name: "secret", Version: "v1.35.0"},
			"public": {Name: "public", Version: "v1.36.0"},
		},
		errors:         map[string]string{"broken": "invalid kubeconfig", "hidden-error": "timeout"},
		defaultContext: "public",
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/clusters", nil)
	ctx.Set("user", model.User{Username: "alice", Roles: []common.Role{{
		Name:     "limited",
		Clusters: []string{"public", "broken"},
	}}})

	manager.GetClusters(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var result []common.ClusterInfo
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(result) != 2 || result[0].Name != "broken" || result[1].Name != "public" {
		t.Fatalf("clusters = %#v", result)
	}
	if result[0].Error != "invalid kubeconfig" || !result[1].IsDefault {
		t.Fatalf("cluster metadata = %#v", result)
	}
}

func TestClusterMutationsHonorManagedConfiguration(t *testing.T) {
	setupClusterHandlerTestDB(t)
	common.SetManagedSections(map[string]bool{"clusters": true})
	manager := &ClusterManager{clusters: map[string]*ClientSet{}, errors: map[string]string{}}
	router := gin.New()
	router.POST("/clusters", manager.CreateCluster)

	response := performClusterRequest(router, http.MethodPost, "/clusters", `{"name":"blocked","config":"secret"}`)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	var count int64
	if err := model.DB.Model(&model.Cluster{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("managed mutation persisted clusters: count=%d err=%v", count, err)
	}
}

// 徽章同样遵守「没给的字段不动」，并且非法颜色 / 超长文本要被拒绝：
// 颜色会进前端的内联样式，超限静默截断会让用户以为设置生效了。
//
//nolint:gocyclo // 该用例逐字段覆盖「部分更新 + 校验拒绝」的各条分支，拆开就看不到全貌。
func TestUpdateClusterBadgePartialUpdateAndValidation(t *testing.T) {
	setupClusterHandlerTestDB(t)
	manager := &ClusterManager{clusters: map[string]*ClientSet{}, errors: map[string]string{}}
	router := gin.New()
	router.PUT("/clusters/:id", manager.UpdateCluster)
	router.GET("/clusters", manager.GetClusterList)

	cluster := &model.Cluster{Name: "primary", Description: "main", Config: model.SecretString("secret-kubeconfig"), Enable: true}
	if err := model.AddCluster(cluster); err != nil {
		t.Fatalf("creating cluster: %v", err)
	}
	path := fmt.Sprintf("/clusters/%d", cluster.ID)

	response := performClusterRequest(router, http.MethodPut, path,
		`{"badgeEnabled":true,"badgeText":"  测试环境  ","badgeColor":"#0011ff","badgeIconEnabled":true,"badgeIconText":" 测试 "}`)
	if response.Code != http.StatusOK {
		t.Fatalf("badge update status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	after, err := model.GetClusterByID(cluster.ID)
	if err != nil {
		t.Fatalf("reloading cluster: %v", err)
	}
	if !after.BadgeEnabled || after.BadgeText != "测试环境" || after.BadgeColor != "#0011ff" ||
		!after.BadgeIconEnabled || after.BadgeIconText != "测试" {
		t.Fatalf("badge fields = %#v", after)
	}
	if !after.Enable || after.Description != "main" || string(after.Config) != "secret-kubeconfig" {
		t.Errorf("badge update touched unrelated fields: %#v", after)
	}

	// 只改说明：开关、颜色、图标都要保留。
	response = performClusterRequest(router, http.MethodPut, path, `{"badgeText":"生产环境"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("text-only update status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	after, err = model.GetClusterByID(cluster.ID)
	if err != nil {
		t.Fatalf("reloading cluster: %v", err)
	}
	if after.BadgeText != "生产环境" || !after.BadgeEnabled || after.BadgeColor != "#0011ff" || after.BadgeIconText != "测试" {
		t.Errorf("partial badge update lost values: %#v", after)
	}

	// 管理员编辑用的列表接口要原样回传，关闭徽章的集群也得能看到已填内容。
	list := performClusterRequest(router, http.MethodGet, "/clusters", "")
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d, want %d", list.Code, http.StatusOK)
	}
	var listed []map[string]any
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decoding list response: %v", err)
	}
	if len(listed) != 1 || listed[0]["badgeText"] != "生产环境" || listed[0]["badgeColor"] != "#0011ff" {
		t.Fatalf("listed cluster badge = %#v", listed)
	}

	for name, body := range map[string]string{
		"启用徽章但没写说明": `{"badgeEnabled":true,"badgeText":""}`,
		"颜色不是十六进制":  `{"badgeColor":"red"}`,
		"颜色带样式注入":   `{"badgeColor":"#fff;background:url(x)"}`,
		"说明超长":      fmt.Sprintf(`{"badgeText":%q}`, strings.Repeat("测", 17)),
		// 图标文本按「最多 6 个汉字」收，7 个就要拒。
		"图标文本超长": fmt.Sprintf(`{"badgeIconText":%q}`, strings.Repeat("测", 7)),
	} {
		response = performClusterRequest(router, http.MethodPut, path, body)
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want %d: %s", name, response.Code, http.StatusBadRequest, response.Body.String())
		}
	}

	// 正好 16 个字符要能存下：徽章按整段展示、不截断，界面宽度就是按这个长度留的。
	sixteen := strings.Repeat("测", 16)
	response = performClusterRequest(router, http.MethodPut, path, fmt.Sprintf(`{"badgeText":%q}`, sixteen))
	if response.Code != http.StatusOK {
		t.Fatalf("sixteen-character badge text status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if after, err = model.GetClusterByID(cluster.ID); err != nil {
		t.Fatalf("reloading cluster: %v", err)
	} else if after.BadgeText != sixteen {
		t.Errorf("badge text = %q, want it stored whole", after.BadgeText)
	}

	// 正好 6 个汉字要能存下：图标位宽度是给这个长度留的。
	response = performClusterRequest(router, http.MethodPut, path, `{"badgeIconText":"测试环境图标"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("six-character badge icon text status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if after, err = model.GetClusterByID(cluster.ID); err != nil {
		t.Fatalf("reloading cluster: %v", err)
	} else if after.BadgeIconText != "测试环境图标" {
		t.Errorf("badge icon text = %q, want it stored whole", after.BadgeIconText)
	}
}

// 切换器与顶栏取的是展示用数据：未启用徽章的集群不下发徽章字段，
// 前端因此不需要处理「拿到半套徽章数据」的情况。
//
// 图标是例外：它由 badge_icon_enabled 单独控制，徽章关着也要下发，
// 否则「只换了图标」的集群在界面上毫无变化。
func TestGetClustersIncludesBadgeOnlyWhenEnabled(t *testing.T) {
	setupClusterHandlerTestDB(t)
	for _, cluster := range []*model.Cluster{
		{Name: "tagged", Enable: true, BadgeEnabled: true, BadgeText: "测试环境", BadgeColor: "#0011ff", BadgeIconEnabled: true, BadgeIconText: "测试"},
		{Name: "icononly", Enable: true, BadgeIconEnabled: true, BadgeIconText: "独立图标", BadgeIconURL: "/api/v1/clusters/3/badge-icon?v=abc"},
		{Name: "plain", Enable: true, BadgeText: "不该下发", BadgeColor: "#ff0000"},
	} {
		if err := model.AddCluster(cluster); err != nil {
			t.Fatalf("creating cluster %s: %v", cluster.Name, err)
		}
	}

	manager := &ClusterManager{
		clusters: map[string]*ClientSet{
			"tagged":   {Name: "tagged", Version: "v1.36.0"},
			"icononly": {Name: "icononly", Version: "v1.36.0"},
			"plain":    {Name: "plain", Version: "v1.36.0"},
		},
		errors: map[string]string{},
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/clusters", nil)
	ctx.Set("user", model.User{Username: "alice", Roles: []common.Role{{
		Name:     "limited",
		Clusters: []string{"tagged", "icononly", "plain"},
	}}})

	manager.GetClusters(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var listed []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	byName := map[string]map[string]any{}
	for _, item := range listed {
		name, _ := item["name"].(string)
		byName[name] = item
	}
	if len(byName) != 3 {
		t.Fatalf("clusters = %#v", listed)
	}

	tagged := byName["tagged"]
	if tagged["badgeEnabled"] != true || tagged["badgeText"] != "测试环境" ||
		tagged["badgeColor"] != "#0011ff" || tagged["badgeIconEnabled"] != true || tagged["badgeIconText"] != "测试" {
		t.Errorf("enabled badge = %#v", tagged)
	}

	iconOnly := byName["icononly"]
	if iconOnly["badgeIconEnabled"] != true || iconOnly["badgeIconText"] != "独立图标" ||
		iconOnly["badgeIconUrl"] != "/api/v1/clusters/3/badge-icon?v=abc" {
		t.Errorf("icon-only cluster = %#v", iconOnly)
	}
	// 图标下发不等于徽章下发：徽章字段仍按自己的开关走。
	for _, key := range []string{"badgeEnabled", "badgeText", "badgeColor"} {
		if _, ok := iconOnly[key]; ok {
			t.Errorf("icon-only cluster leaked badge %q: %#v", key, iconOnly)
		}
	}

	for _, key := range []string{"badgeEnabled", "badgeText", "badgeColor", "badgeIconEnabled", "badgeIconText", "badgeIconUrl"} {
		if _, ok := byName["plain"][key]; ok {
			t.Errorf("disabled badge leaked %q into the cluster list: %#v", key, byName["plain"])
		}
	}
}

// 前端导航靠 slug 把 /_clusters/<slug> 对应到集群（切换器/兜底重定向都吃这份数据）：
// 展示用集群列表必须把 slug 一并下发；库里还没有 slug 的旧数据（迁移回填前的 nil）
// 则省略字段，前端走兜底逻辑。
func TestGetClustersIncludesSlug(t *testing.T) {
	setupClusterHandlerTestDB(t)
	slug := "kind-e2e"
	for _, cluster := range []*model.Cluster{
		{Name: "kind-e2e", Enable: true, Slug: &slug},
		{Name: "legacy", Enable: true},
	} {
		if err := model.AddCluster(cluster); err != nil {
			t.Fatalf("creating cluster %s: %v", cluster.Name, err)
		}
	}

	manager := &ClusterManager{
		clusters: map[string]*ClientSet{
			"kind-e2e": {Name: "kind-e2e", Version: "v1.31.2"},
			"legacy":   {Name: "legacy", Version: "v1.31.2"},
		},
		errors: map[string]string{},
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/clusters", nil)
	ctx.Set("user", model.User{Username: "alice", Roles: []common.Role{{
		Name:     "limited",
		Clusters: []string{"kind-e2e", "legacy"},
	}}})

	manager.GetClusters(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var listed []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	byName := map[string]map[string]any{}
	for _, item := range listed {
		name, _ := item["name"].(string)
		byName[name] = item
	}
	if got := byName["kind-e2e"]["slug"]; got != "kind-e2e" {
		t.Errorf("slug = %#v, want kind-e2e", got)
	}
	if _, ok := byName["legacy"]["slug"]; ok {
		t.Errorf("nil slug should be omitted, got %#v", byName["legacy"]["slug"])
	}
}

// 建得出客户端不等于数据是新的：apiserver 掉线后缓存会一直停在最后一刻，
// 而节点列表看起来完全正常。集群列表必须把陈旧信号带上，供切换器与横幅兜底提示。
func TestGetClustersReportsStaleData(t *testing.T) {
	gin.SetMode(gin.TestMode)
	fresh := &kube.K8sClient{}
	fresh.Health().RecordProbeOK(time.Now())
	stale := &kube.K8sClient{}
	stale.Health().RecordProbeOK(time.Now().Add(-3 * time.Minute))

	manager := &ClusterManager{
		clusters: map[string]*ClientSet{
			"fresh": {Name: "fresh", Version: "v1.36.0", K8sClient: fresh},
			"stale": {Name: "stale", Version: "v1.36.0", K8sClient: stale},
		},
		errors: map[string]string{},
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/clusters", nil)
	ctx.Set("user", model.User{Username: "alice", Roles: []common.Role{{
		Name:     "limited",
		Clusters: []string{"fresh", "stale"},
	}}})

	manager.GetClusters(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var listed []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	byName := map[string]map[string]any{}
	for _, item := range listed {
		name, _ := item["name"].(string)
		byName[name] = item
	}
	if len(byName) != 2 {
		t.Fatalf("clusters = %#v", listed)
	}

	for _, key := range []string{"stale", "staleSince", "staleReason"} {
		if _, ok := byName["fresh"][key]; ok {
			t.Errorf("fresh cluster must not report %q: %#v", key, byName["fresh"])
		}
	}
	staleInfo := byName["stale"]
	if staleInfo["stale"] != true || staleInfo["staleReason"] != kube.StaleReasonUnreachable {
		t.Errorf("stale cluster = %#v", staleInfo)
	}
	if since, _ := staleInfo["staleSince"].(string); since == "" {
		t.Errorf("stale cluster must report when its data was last fresh: %#v", staleInfo)
	} else if _, err := time.Parse(time.RFC3339, since); err != nil {
		t.Errorf("staleSince = %q, want RFC3339: %v", since, err)
	}
}

func setupClusterHandlerTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalEncryptKey := common.EncryptKey
	originalManagedSections := make(map[string]bool, len(common.ManagedSections))
	for section, managed := range common.ManagedSections {
		originalManagedSections[section] = managed
	}
	common.EncryptKey = "cluster-handler-test-key"
	common.SetManagedSections(nil)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	// 删除集群时也会处理该集群的权限绑定组、以及该集群的徽章图标字节，
	// 因此测试数据库中必须有这些表。
	if err := db.AutoMigrate(
		&model.Cluster{},
		&model.ClusterBadgeIcon{},
		&model.GeneralSetting{},
		&model.BindingGroup{},
		&model.BindingGroupNamespace{},
		&model.BindingGroupMember{},
	); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	model.DB = db
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		select {
		case <-syncNow:
		default:
		}
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
		model.DB = originalDB
		common.EncryptKey = originalEncryptKey
		common.SetManagedSections(originalManagedSections)
	})
}

func performClusterRequest(router *gin.Engine, method string, path string, body string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	router.ServeHTTP(recorder, request)
	return recorder
}

// 删除集群的审计详情必须带集群名与快照，且 kubeconfig 是凭据、绝不能进快照。
func TestDeleteClusterRecordsAuditDetail(t *testing.T) {
	setupClusterHandlerTestDB(t)
	manager := &ClusterManager{clusters: map[string]*ClientSet{}, errors: map[string]string{}}
	cluster := model.Cluster{Name: "doomed", Description: "dev", Config: "top-secret-kubeconfig", Enable: true}
	if err := model.DB.Create(&cluster).Error; err != nil {
		t.Fatalf("seeding cluster: %v", err)
	}

	var detail common.AdminAuditDetail
	router := gin.New()
	router.DELETE("/clusters/:id", func(c *gin.Context) {
		manager.DeleteCluster(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	response := performClusterRequest(router, http.MethodDelete, fmt.Sprintf("/clusters/%d", cluster.ID), "")
	if response.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if detail.ResourceName != "doomed" {
		t.Fatalf("audit resourceName = %q, want the cluster name", detail.ResourceName)
	}
	if !strings.Contains(detail.PreviousYAML, "name: doomed") {
		t.Fatalf("audit snapshot must describe the cluster, got %q", detail.PreviousYAML)
	}
	if strings.Contains(detail.PreviousYAML, "top-secret-kubeconfig") {
		t.Fatalf("audit snapshot must not leak the kubeconfig: %s", detail.PreviousYAML)
	}
}
