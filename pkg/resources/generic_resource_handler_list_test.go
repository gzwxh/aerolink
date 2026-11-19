package resources

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
