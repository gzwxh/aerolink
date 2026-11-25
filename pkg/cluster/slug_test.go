package cluster

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/model"
	"k8s.io/client-go/tools/clientcmd/api"
)

func TestValidateSlugFormat(t *testing.T) {
	for _, slug := range []string{"prod", "a1", "a-b-c", strings.Repeat("a", 48)} {
		if err := ValidateSlugFormat(slug); err != nil {
			t.Errorf("ValidateSlugFormat(%q) = %v, want nil", slug, err)
		}
	}
	for _, slug := range []string{"", "-prod", "pro d", "Prod", "生产环境", strings.Repeat("a", 49)} {
		if err := ValidateSlugFormat(slug); err == nil {
			t.Errorf("ValidateSlugFormat(%q) = nil, want error", slug)
		}
	}
}

func TestGenerateUniqueSlug(t *testing.T) {
	taken := map[string]bool{"cluster": true, "cluster-2": true}
	if got := GenerateUniqueSlug("生产环境", taken); got != "cluster-3" {
		t.Errorf("GenerateUniqueSlug dedup = %q, want cluster-3", got)
	}
	if got := GenerateUniqueSlug("Prod Cluster", nil); got != "prod-cluster" {
		t.Errorf("GenerateUniqueSlug = %q, want prod-cluster", got)
	}
}

// 创建：手填短名入库、自动生成去重、非法/冲突显式报错。
func TestCreateClusterSlugHandling(t *testing.T) {
	setupClusterHandlerTestDB(t)
	manager := &ClusterManager{clusters: map[string]*ClientSet{}, errors: map[string]string{}}
	router := gin.New()
	router.POST("/clusters", manager.CreateCluster)
	router.GET("/clusters", manager.GetClusterList)
	router.PUT("/clusters/:id", manager.UpdateCluster)

	create := performClusterRequest(router, http.MethodPost, "/clusters", `{"name":"生产环境","slug":"prod"}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want %d: %s", create.Code, http.StatusCreated, create.Body.String())
	}
	stored, err := model.GetClusterBySlug("prod")
	if err != nil {
		t.Fatalf("loading cluster by slug: %v", err)
	}

	// 手填冲突：409，不静默改写
	dup := performClusterRequest(router, http.MethodPost, "/clusters", `{"name":"another","slug":"prod"}`)
	if dup.Code != http.StatusConflict {
		t.Fatalf("duplicate slug status = %d, want %d", dup.Code, http.StatusConflict)
	}
	// 非法字符：400
	bad := performClusterRequest(router, http.MethodPost, "/clusters", `{"name":"another","slug":"Prod!"}`)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid slug status = %d, want %d", bad.Code, http.StatusBadRequest)
	}
	// 中文名自动生成：第一套 cluster，第二套 cluster-2
	auto1 := performClusterRequest(router, http.MethodPost, "/clusters", `{"name":"测试环境"}`)
	if auto1.Code != http.StatusCreated {
		t.Fatalf("auto slug create status = %d: %s", auto1.Code, auto1.Body.String())
	}
	auto2 := performClusterRequest(router, http.MethodPost, "/clusters", `{"name":"开发环境"}`)
	if auto2.Code != http.StatusCreated {
		t.Fatalf("auto slug create 2 status = %d: %s", auto2.Code, auto2.Body.String())
	}
	got, err := model.GetClusterByName("测试环境")
	if err != nil {
		t.Fatalf("loading auto-slug cluster: %v", err)
	}
	if got.Slug == nil || *got.Slug != "cluster" {
		t.Fatalf("auto slug = %#v, want cluster", got.Slug)
	}
	got2, err := model.GetClusterByName("开发环境")
	if err != nil {
		t.Fatalf("loading auto-slug cluster 2: %v", err)
	}
	if got2.Slug == nil || *got2.Slug != "cluster-2" {
		t.Fatalf("auto slug 2 = %#v, want cluster-2", got2.Slug)
	}

	// 管理列表下发 slug
	list := performClusterRequest(router, http.MethodGet, "/clusters", "")
	var listed []map[string]any
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decoding list response: %v", err)
	}
	byName := map[string]map[string]any{}
	for _, item := range listed {
		byName[item["name"].(string)] = item
	}
	if byName["生产环境"]["slug"] != "prod" {
		t.Fatalf("list slug = %#v, want prod", byName["生产环境"]["slug"])
	}

	// 改名不重算 slug（slug 创建时固化）
	update := performClusterRequest(router, http.MethodPut, fmt.Sprintf("/clusters/%d", stored.ID), `{"name":"renamed-prod"}`)
	if update.Code != http.StatusOK {
		t.Fatalf("rename status = %d: %s", update.Code, update.Body.String())
	}
	after, err := model.GetClusterByID(stored.ID)
	if err != nil {
		t.Fatalf("loading renamed cluster: %v", err)
	}
	if after.Slug == nil || *after.Slug != "prod" {
		t.Fatalf("slug after rename = %#v, want prod", after.Slug)
	}
}

// 导入：整批校验 fail-closed；已存在的集群即使被指定短名也不改动。
func TestImportClustersFromKubeconfigSlugs(t *testing.T) {
	setupClusterHandlerTestDB(t)

	newConfig := func() *api.Config {
		return &api.Config{
			Contexts: map[string]*api.Context{
				"生产环境":    {Cluster: "c1", AuthInfo: "u1"},
				"staging": {Cluster: "c2", AuthInfo: "u2"},
			},
			Clusters:  map[string]*api.Cluster{"c1": {}, "c2": {}},
			AuthInfos: map[string]*api.AuthInfo{"u1": {}, "u2": {}},
		}
	}

	// 批内两个 context 填同一个 slug：整批失败，一条都不写
	_, err := ImportClustersFromKubeconfig(newConfig(), false, map[string]string{
		"生产环境":    "prod",
		"staging": "prod",
	})
	if err == nil {
		t.Fatal("duplicate slugs in batch should fail the whole import")
	}
	if count, err := model.CountClusters(); err != nil || count != 0 {
		t.Fatalf("clusters after failed import = %d (err %v), want 0", count, err)
	}

	// 合法：逐行短名生效
	n, err := ImportClustersFromKubeconfig(newConfig(), false, map[string]string{
		"生产环境":    "prod",
		"staging": "stg",
	})
	if err != nil || n != 2 {
		t.Fatalf("valid import = %d, %v, want 2, nil", n, err)
	}

	// 再次导入同名集群：即使指定了不同的短名也不改动（slug 创建时固化）
	if _, err := ImportClustersFromKubeconfig(newConfig(), false, map[string]string{
		"生产环境": "changed",
	}); err != nil {
		t.Fatalf("re-import with conflicting slug should not fail (existing cluster keeps its slug): %v", err)
	}
	stored, err := model.GetClusterByName("生产环境")
	if err != nil {
		t.Fatalf("loading re-imported cluster: %v", err)
	}
	if stored.Slug == nil || *stored.Slug != "prod" {
		t.Fatalf("slug after re-import = %#v, want prod", stored.Slug)
	}
}
