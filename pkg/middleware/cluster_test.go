package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"aerolink/pkg/cluster"
	"aerolink/pkg/kube"
	"github.com/gin-gonic/gin"
)

// 集群名经 x-cluster-name 传输时是 URL 编码的（HTTP 头只能带 ASCII）：写审计记录、
// 选集群都必须先解码，否则库里存的是编码串（界面乱码、按集群筛选也匹配不上）。
func TestDecodeClusterName(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"编码过的中文名还原", "%E7%94%9F%E4%BA%A7%E7%8E%AF%E5%A2%83", "生产环境"},
		{"未编码的名称原样返回", "prod-cluster", "prod-cluster"},
		{"空值返回空", "", ""},
		{"非法转义原样返回（不带病落库，也不拦请求）", "%E7%ZZ", "%E7%ZZ"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := DecodeClusterName(test.input); got != test.want {
				t.Errorf("DecodeClusterName(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

type stubClientSetProvider struct {
	clientSet *cluster.ClientSet
}

func (p stubClientSetProvider) GetClientSet(string) (*cluster.ClientSet, error) {
	return p.clientSet, nil
}

// 集群数据可能陈旧时，任何集群作用域的响应都要带陈旧信号头：
// 前端靠它立刻提示「本页数据可能已过期」，不必等下一次拉集群列表。
func TestClusterMiddlewareReportsStaleDataHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name      string
		clientSet *cluster.ClientSet
		wantStale string
		wantAge   string
	}{
		{
			name:      "从未确认可达的集群按陈旧处理",
			clientSet: &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{}},
			wantStale: "1",
			// 没有成功记录就没有「数据年龄」可言，宁可不给，也不编一个 0。
			wantAge: "",
		},
		{
			name: "刚探活成功的集群不带陈旧信号",
			clientSet: func() *cluster.ClientSet {
				client := &kube.K8sClient{}
				client.Health().RecordProbeOK(time.Now())
				return &cluster.ClientSet{Name: "prod", K8sClient: client}
			}(),
			wantStale: "",
			wantAge:   "0",
		},
		{
			name: "探活超时的集群带陈旧信号与数据年龄",
			clientSet: func() *cluster.ClientSet {
				client := &kube.K8sClient{}
				client.Health().RecordProbeOK(time.Now().Add(-2 * time.Minute))
				return &cluster.ClientSet{Name: "prod", K8sClient: client}
			}(),
			wantStale: "1",
			wantAge:   "120",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := gin.New()
			router.Use(ClusterMiddleware(stubClientSetProvider{clientSet: test.clientSet}))
			router.GET("/nodes", func(c *gin.Context) { c.Status(http.StatusOK) })

			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/nodes", nil))

			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
			}
			if got := recorder.Header().Get(ClusterDataStaleHeader); got != test.wantStale {
				t.Errorf("%s = %q, want %q", ClusterDataStaleHeader, got, test.wantStale)
			}
			if got := recorder.Header().Get(ClusterDataAgeHeader); got != test.wantAge {
				t.Errorf("%s = %q, want %q", ClusterDataAgeHeader, got, test.wantAge)
			}
		})
	}
}
