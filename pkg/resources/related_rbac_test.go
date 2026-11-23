package resources

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// TestRelatedResourcesHandlerCoversRBAC 钉住“接了线”：上面那些发现函数写得再对，
// 忘在 GetRelatedResources 的 switch 里加 case 就等于没有（D-123 原本就是这个状态）。
// 那道逐条 rbac.CanAccess 是纯角色比较，读 user.Roles，所以给一个通配角色就能跑完整路径。
func TestRelatedResourcesHandlerCoversRBAC(t *testing.T) {
	gin.SetMode(gin.TestMode)

	previous := handlers
	handlers = newResourceHandlers()
	t.Cleanup(func() { handlers = previous })

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("adding corev1 to scheme: %v", err)
	}
	if err := rbacv1.AddToScheme(scheme); err != nil {
		t.Fatalf("adding rbacv1 to scheme: %v", err)
	}
	k8sClient := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(
		&corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: "deployer", Namespace: "team-a"}},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "job-1", Namespace: "team-a"},
			Spec:       corev1.PodSpec{ServiceAccountName: "deployer"},
		},
		&rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "team-a-edit", Namespace: "team-a"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "editor"},
			Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: "deployer", Namespace: "team-a"}},
		},
	).Build()
	cs := &cluster.ClientSet{Name: "prod", K8sClient: &kube.K8sClient{Client: k8sClient}}

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/related", nil)
	ctx.Params = gin.Params{{Key: "namespace", Value: "team-a"}, {Key: "name", Value: "deployer"}}
	ctx.Set("cluster", cs)
	ctx.Set("user", model.User{Username: "alice", Roles: []common.Role{{
		Name:      model.DefaultAdminRole.Name,
		Clusters:  []string{"*"},
		Resources: []string{"*"},
		Verbs:     []string{"*"},
	}}})
	ctx.Set("resource", string(common.ServiceAccounts))

	GetRelatedResources(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("/related 返回 %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	var related []common.RelatedResource
	if err := json.Unmarshal(recorder.Body.Bytes(), &related); err != nil {
		t.Fatalf("decoding related payload: %v; body=%s", err, recorder.Body.String())
	}
	got := relatedLabels(related)
	for _, want := range []string{"pods/team-a/job-1", "rolebindings/team-a/team-a-edit"} {
		if !containsLabel(got, want) {
			t.Errorf("ServiceAccount 详情页的相关资源缺少 %q, got %v（handler 里是否漏了这个 case？）", want, got)
		}
	}
}

// 回归（验收台账 D-123）：RBAC 五个面（ServiceAccount / Role / RoleBinding /
// ClusterRole / ClusterRoleBinding）在 GetRelatedResources 里一个分支都没有，
// 于是详情页的「相关资源」页签永远空着 —— 而「这个角色 / 身份被用在哪里」正是
// 排查权限时最想知道的答案。
//
// 这里直接测发现与组装逻辑本身：handler 末尾还会逐条过 rbac.CanAccess（那道门是
// 既有的防泄漏设计，不让关联发现替人确认无权对象的存在性），它依赖运行期加载的
// RBACConfig，单测里没那份配置，测 handler 只会测出一片假空。

func newRBACFixture(t *testing.T, objects ...runtime.Object) *kube.K8sClient {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("adding corev1 to scheme: %v", err)
	}
	if err := rbacv1.AddToScheme(scheme); err != nil {
		t.Fatalf("adding rbacv1 to scheme: %v", err)
	}
	return &kube.K8sClient{
		Client: fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(objects...).Build(),
	}
}

func relatedLabels(items []common.RelatedResource) []string {
	labels := make([]string, 0, len(items))
	for _, item := range items {
		label := item.Type + "/" + item.Name
		if item.Namespace != "" {
			label = item.Type + "/" + item.Namespace + "/" + item.Name
		}
		labels = append(labels, label)
	}
	return labels
}

func containsLabel(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}

func TestServiceAccountRelatedFindsPodsAndBindings(t *testing.T) {
	fixture := newRBACFixture(t,
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "job-1", Namespace: "team-a"},
			Spec:       corev1.PodSpec{ServiceAccountName: "deployer"},
		},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "team-a"},
			Spec:       corev1.PodSpec{ServiceAccountName: "default"},
		},
		&rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "team-a-edit", Namespace: "team-a"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "editor"},
			Subjects: []rbacv1.Subject{{
				Kind: "ServiceAccount", Name: "deployer", Namespace: "team-a",
			}},
		},
		// 同名 SA 在别的命名空间，不该被同一条 RoleBinding 匹配上。
		&rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "team-b-edit", Namespace: "team-b"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "editor"},
			Subjects: []rbacv1.Subject{{
				Kind: "ServiceAccount", Name: "deployer", Namespace: "team-b",
			}},
		},
		&rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "global-view"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "view"},
			Subjects: []rbacv1.Subject{{
				Kind: "ServiceAccount", Name: "deployer", Namespace: "team-a",
			}},
		},
	)
	ctx := context.Background()

	pods := relatedLabels(discoverPodsByServiceAccount(ctx, fixture, "team-a", "deployer"))
	if !containsLabel(pods, "pods/team-a/job-1") {
		t.Errorf("应列出使用该 ServiceAccount 的 Pod, got %v", pods)
	}
	if containsLabel(pods, "pods/team-a/other") {
		t.Errorf("不该把用别的 ServiceAccount 的 Pod 也算进来, got %v", pods)
	}

	roleBindings := relatedLabels(discoverRoleBindingsForServiceAccount(ctx, fixture, "team-a", "deployer"))
	if !containsLabel(roleBindings, "rolebindings/team-a/team-a-edit") {
		t.Errorf("应列出绑定它的 RoleBinding, got %v", roleBindings)
	}
	if containsLabel(roleBindings, "rolebindings/team-b/team-b-edit") {
		t.Errorf("RoleBinding 只能引用同命名空间的 SA，不该跨命名空间匹配, got %v", roleBindings)
	}

	clusterBindings := relatedLabels(discoverClusterRoleBindingsForServiceAccount(ctx, fixture, "team-a", "deployer"))
	if !containsLabel(clusterBindings, "clusterrolebindings/global-view") {
		t.Errorf("应列出把角色绑到它的 ClusterRoleBinding, got %v", clusterBindings)
	}
}

func TestRoleRelatedFindsOnlyItsOwnBindings(t *testing.T) {
	fixture := newRBACFixture(t,
		&rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "bind-editor", Namespace: "team-a"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "editor"},
		},
		&rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "bind-reader", Namespace: "team-a"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "reader"},
		},
	)

	got := relatedLabels(discoverRoleBindingsForRole(context.Background(), fixture, "team-a", "editor"))
	if len(got) != 1 || got[0] != "rolebindings/team-a/bind-editor" {
		t.Fatalf("只该找到绑定该 Role 的那一条, got %v", got)
	}
}

func TestClusterRoleRelatedIncludesNamespacedBindings(t *testing.T) {
	fixture := newRBACFixture(t,
		// 把 ClusterRole 降级绑到单个命名空间是常见做法，只看当前命名空间会漏掉它。
		&rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "bind-cluster-role", Namespace: "team-b"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "metrics-reader"},
		},
		&rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "bind-global"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "metrics-reader"},
		},
		&rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "bind-other"},
			RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "other"},
		},
	)
	ctx := context.Background()

	fromRoleBindings := relatedLabels(discoverRoleBindingsForClusterRole(ctx, fixture, "metrics-reader"))
	if !containsLabel(fromRoleBindings, "rolebindings/team-b/bind-cluster-role") {
		t.Errorf("应找到别的命名空间里对该 ClusterRole 的降级绑定, got %v", fromRoleBindings)
	}

	fromClusterBindings := relatedLabels(discoverClusterRoleBindingsForClusterRole(ctx, fixture, "metrics-reader"))
	if !containsLabel(fromClusterBindings, "clusterrolebindings/bind-global") {
		t.Errorf("应找到绑定该 ClusterRole 的 ClusterRoleBinding, got %v", fromClusterBindings)
	}
	if containsLabel(fromClusterBindings, "clusterrolebindings/bind-other") {
		t.Errorf("不该把绑定别的角色的 ClusterRoleBinding 也算进来, got %v", fromClusterBindings)
	}
}

func TestBindingRelatedListsRoleAndAccountsOnly(t *testing.T) {
	roleBinding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "mixed-subjects", Namespace: "team-a"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: "editor"},
		Subjects: []rbacv1.Subject{
			{Kind: "ServiceAccount", Name: "deployer", Namespace: "team-a"},
			// User / Group 在集群里没有可跳转的实体（平台也没有对应资源面），
			// 列出来只会得到点不动的死链。
			{Kind: "User", Name: "alice"},
			{Kind: "Group", Name: "devops"},
		},
	}

	got := relatedLabels(getRoleBindingRelatedResources(roleBinding))
	if !containsLabel(got, "roles/team-a/editor") {
		t.Errorf("应列出 roleRef 指向的 Role（命名空间取绑定自己的）, got %v", got)
	}
	if !containsLabel(got, "serviceaccounts/team-a/deployer") {
		t.Errorf("应列出 subjects 里的 ServiceAccount, got %v", got)
	}
	if len(got) != 2 {
		t.Errorf("User / Group 不该出现在结果里, got %v", got)
	}

	clusterRoleBinding := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "global"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "view"},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: "sa", Namespace: "team-b"}},
	}
	gotCluster := relatedLabels(getClusterRoleBindingRelatedResources(clusterRoleBinding))
	if !containsLabel(gotCluster, "clusterroles/view") {
		t.Errorf("ClusterRole 是集群作用域，条目不该带命名空间, got %v", gotCluster)
	}
	if !containsLabel(gotCluster, "serviceaccounts/team-b/sa") {
		t.Errorf("应列出 subjects 里的 ServiceAccount, got %v", gotCluster)
	}
}
