package resources

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// listErrorClient 模拟 informer 缓存对分页的无能：List 直接报错，
// 与 controller-runtime 的 cache reader 带 continue 时的行为一致。
type listErrorClient struct {
	client.Client
	err error
}

func (c listErrorClient) List(context.Context, client.ObjectList, ...client.ListOption) error {
	return c.err
}

// cacheLikeClient 复刻 cache reader 的另一个特征：limit 请求在本地截断后
// 塞一个假的 continue token。
type cacheLikeClient struct {
	client.Client
}

func (c cacheLikeClient) List(ctx context.Context, out client.ObjectList, opts ...client.ListOption) error {
	listOpts := client.ListOptions{}
	listOpts.ApplyOptions(opts)
	if listOpts.Continue != "" {
		return errors.New("continue list option is not supported by the cache")
	}
	if err := c.Client.List(ctx, out, opts...); err != nil {
		return err
	}
	if listMeta, err := meta.ListAccessor(out); err == nil {
		listMeta.SetContinue(cacheContinueToken)
	}
	return nil
}

func newPaginationTestClientSet(cached, direct client.Client) *cluster.ClientSet {
	return &cluster.ClientSet{
		Name: "cluster-a",
		K8sClient: &kube.K8sClient{
			Client:       cached,
			DirectClient: direct,
		},
	}
}

func performListRequest(cs *cluster.ClientSet, handler resourceHandler, query string) *httptest.ResponseRecorder {
	user := model.User{
		Username: "alice",
		Roles: []common.Role{{
			Name: "configmap-reader",
			// 空 Namespaces 表示不限制命名空间（新式角色口径）。
			Clusters:  []string{"cluster-a"},
			Resources: []string{string(common.ConfigMaps)},
			Verbs:     []string{string(common.VerbGet)},
		}},
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/v1/configmaps/_all"+query, nil)
	ctx.Params = gin.Params{{Key: "namespace", Value: common.AllNamespaces}}
	ctx.Set("cluster", cs)
	ctx.Set("user", user)
	handler.List(ctx)
	return recorder
}

func newConfigMapHandler() resourceHandler {
	return newResourceHandlers()[string(common.ConfigMaps)]
}

// 回归：带分页的列表请求必须绕过 informer 缓存。
// 上一次「加载更多」就是死在缓存的
// "continue list option is not supported by the cache" 上。
func TestGenericListUsesDirectClientForPagination(t *testing.T) {
	gin.SetMode(gin.TestMode)

	direct := fake.NewClientBuilder().WithObjects(
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cm", Namespace: "default"}},
	).Build()
	cs := newPaginationTestClientSet(
		listErrorClient{Client: direct, err: errors.New("continue list option is not supported by the cache")},
		direct,
	)
	handler := newConfigMapHandler()

	// 只带 limit、没有分页标志：沿用缓存客户端，这里会命中模拟的缓存报错。
	if response := performListRequest(cs, handler, "?limit=1"); response.Code != http.StatusInternalServerError {
		t.Fatalf("list without paginate flag returned %d, want %d; body=%s",
			response.Code, http.StatusInternalServerError, response.Body.String())
	}

	// 分页标志：走直连客户端，不应该碰到缓存的分页限制。
	response := performListRequest(cs, handler, "?paginate=true&limit=1")
	if response.Code != http.StatusOK {
		t.Fatalf("paginated list returned %d, want %d; body=%s",
			response.Code, http.StatusOK, response.Body.String())
	}
	var list corev1.ConfigMapList
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode configmap list: %v", err)
	}
	if len(list.Items) != 1 || list.Items[0].Name != "cm" {
		t.Fatalf("paginated list returned %#v, want the cm configmap", list.Items)
	}

	// 翻页（continue 非空）同样走直连。
	if response := performListRequest(cs, handler, "?continue=token"); response.Code != http.StatusOK {
		t.Fatalf("continued list returned %d, want %d; body=%s",
			response.Code, http.StatusOK, response.Body.String())
	}
}

// 回归：缓存路径的 limit 会带回假 token，不能被当成真的翻页游标返回。
func TestGenericListStripsInformerCacheContinueToken(t *testing.T) {
	gin.SetMode(gin.TestMode)

	direct := fake.NewClientBuilder().WithObjects(
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cm", Namespace: "default"}},
	).Build()
	cs := newPaginationTestClientSet(cacheLikeClient{Client: direct}, direct)

	response := performListRequest(cs, newConfigMapHandler(), "?limit=1")
	if response.Code != http.StatusOK {
		t.Fatalf("cached list returned %d, want %d; body=%s",
			response.Code, http.StatusOK, response.Body.String())
	}
	var list corev1.ConfigMapList
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode configmap list: %v", err)
	}
	if list.Continue != "" {
		t.Fatalf("cached list leaked continue token %q, want empty", list.Continue)
	}
}

// pagingFakeClient 给 fake client 补上真分页（limit / continue）：
// controller-runtime 的 fake client 不支持 continue，无法验证集合过滤的合并翻页。
type pagingFakeClient struct {
	client.Client
	objs []client.Object
}

func (c *pagingFakeClient) List(_ context.Context, list client.ObjectList, opts ...client.ListOption) error {
	listOpts := &client.ListOptions{}
	listOpts.ApplyOptions(opts)

	filtered := make([]client.Object, 0, len(c.objs))
	for _, obj := range c.objs {
		if listOpts.Namespace != "" && obj.GetNamespace() != listOpts.Namespace {
			continue
		}
		filtered = append(filtered, obj.DeepCopyObject().(client.Object))
	}

	start := 0
	if listOpts.Continue != "" {
		offset, err := strconv.Atoi(listOpts.Continue)
		if err != nil {
			return err
		}
		start = offset
	}
	end := len(filtered)
	if listOpts.Limit > 0 && start+int(listOpts.Limit) < end {
		end = start + int(listOpts.Limit)
	}

	items := make([]runtime.Object, 0, end-start)
	for _, obj := range filtered[start:end] {
		items = append(items, obj)
	}
	if err := meta.SetList(list, items); err != nil {
		return err
	}
	if end < len(filtered) {
		if listMeta, err := meta.ListAccessor(list); err == nil {
			listMeta.SetContinue(strconv.Itoa(end))
		}
	}
	return nil
}

func deployment(ns, name string, created time.Time) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Namespace:         ns,
			Name:              name,
			CreationTimestamp: metav1.NewTime(created),
		},
	}
}

// newDeploymentListContext 构造一个对 deployment 有 get 权限的跨命名空间请求。
func newDeploymentListContext(t *testing.T, cs *cluster.ClientSet, query string) *gin.Context {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/deployments/_all?"+query, nil)
	c.Params = gin.Params{{Key: "namespace", Value: common.AllNamespaces}}
	c.Set("cluster", cs)
	c.Set("user", model.User{
		Username: "alice",
		Roles: []common.Role{{
			Clusters:  []string{"cluster-a"},
			Resources: []string{string(common.Deployments)},
			Verbs:     []string{string(common.VerbGet)},
		}},
	})
	return c
}

// 回归：选中的命名空间排在列表靠后时，服务端必须继续翻页并合并，直到凑够 limit；
// 否则前端拿到的第一页全是未选中的命名空间，客户端过滤后就是空表。
func TestDeploymentListNamespaceFilterMergesPages(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatalf("add appsv1 to scheme: %v", err)
	}

	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var objs []client.Object
	// 前 6 条全部落在未选中的命名空间：分页窗口被它们占满，必须往后翻才会命中。
	for i := 0; i < 6; i++ {
		objs = append(objs, deployment("other", "other-"+strconv.Itoa(i), base.Add(time.Duration(i)*time.Minute)))
	}
	for i := 0; i < 3; i++ {
		objs = append(objs, deployment("ns-a", "a-"+strconv.Itoa(i), base.Add(time.Duration(10+i)*time.Minute)))
	}
	for i := 0; i < 3; i++ {
		objs = append(objs, deployment("ns-b", "b-"+strconv.Itoa(i), base.Add(time.Duration(20+i)*time.Minute)))
	}

	paging := &pagingFakeClient{
		Client: fake.NewClientBuilder().WithScheme(scheme).Build(),
		objs:   objs,
	}
	cs := newPaginationTestClientSet(paging, paging)
	handler := NewGenericResourceHandler[*appsv1.Deployment, *appsv1.DeploymentList](common.Deployments)

	first, err := handler.list(newDeploymentListContext(t, cs, "limit=3&paginate=true&namespaces=ns-a,ns-b"))
	if err != nil {
		t.Fatalf("list first batch: %v", err)
	}
	if len(first.Items) != 3 {
		t.Fatalf("first batch returned %d items, want 3", len(first.Items))
	}
	for _, item := range first.Items {
		if item.Namespace != "ns-a" {
			t.Fatalf("first batch item %s/%s is outside the selected namespaces", item.Namespace, item.Name)
		}
	}
	if first.Continue == "" {
		t.Fatal("merged pagination must keep a continue token")
	}

	second, err := handler.list(newDeploymentListContext(t, cs,
		"limit=3&paginate=true&continue="+first.Continue+"&namespaces=ns-a,ns-b"))
	if err != nil {
		t.Fatalf("list second batch: %v", err)
	}
	if len(second.Items) != 3 {
		t.Fatalf("second batch returned %d items, want 3", len(second.Items))
	}
	for _, item := range second.Items {
		if item.Namespace != "ns-b" {
			t.Fatalf("second batch item %s/%s is outside the selected namespaces", item.Namespace, item.Name)
		}
	}
	if second.Continue != "" {
		t.Fatalf("second batch leaked continue token %q, want empty", second.Continue)
	}
}

// 不传 namespaces 时行为与之前一致：只取一页，不做集合过滤。
func TestDeploymentListWithoutNamespaceFilterKeepsSinglePage(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatalf("add appsv1 to scheme: %v", err)
	}

	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	objs := []client.Object{
		deployment("other", "other-0", base),
		deployment("ns-a", "a-0", base.Add(time.Minute)),
	}

	paging := &pagingFakeClient{
		Client: fake.NewClientBuilder().WithScheme(scheme).Build(),
		objs:   objs,
	}
	cs := newPaginationTestClientSet(paging, paging)
	handler := NewGenericResourceHandler[*appsv1.Deployment, *appsv1.DeploymentList](common.Deployments)

	out, err := handler.list(newDeploymentListContext(t, cs, "limit=1&paginate=true"))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(out.Items) != 1 {
		t.Fatalf("single page returned %d items, want 1", len(out.Items))
	}
	if out.Continue == "" {
		t.Fatal("single page should keep the underlying continue token")
	}
}
