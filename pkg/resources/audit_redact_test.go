package resources

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// 回归（缺陷 D-33）：审计里的 Secret 快照只能留键名，不能留值。
// 值一旦进库，任何持 settings.audit 读权限的人都能从列表接口整份拿走
// （导出 CSV 早就剥掉了这两列，所以口径统一成两侧都不留）。
func TestRedactSecretYAML(t *testing.T) {
	yamlText := `apiVersion: v1
kind: Secret
metadata:
  name: db
  namespace: default
type: Opaque
stringData:
  password: super-secret-1
data:
  token: c3VwZXItc2VjcmV0LTI=
`

	got := redactSecretYAML(string(common.Secrets), yamlText)
	for _, leak := range []string{"super-secret-1", "c3VwZXItc2VjcmV0LTI="} {
		if strings.Contains(got, leak) {
			t.Fatalf("redacted YAML still carries %q:\n%s", leak, got)
		}
	}
	// 键名必须留着，否则「谁动了哪个字段」就查不出来了。
	for _, key := range []string{"password", "token"} {
		if !strings.Contains(got, key) {
			t.Fatalf("redacted YAML lost the key %q:\n%s", key, got)
		}
	}

	// 非 Secret 原样保留，别把普通资源的差异也抹了。
	plain := "data:\n  a: b\n"
	if kept := redactSecretYAML(string(common.ConfigMaps), plain); kept != plain {
		t.Fatalf("configmap YAML was modified: %q", kept)
	}

	// 解析不了就整段替换（fail-closed），不要把没洗干净的原样写进库。
	broken := redactSecretYAML(string(common.Secrets), "\t- : : {{")
	if !strings.Contains(broken, "已脱敏") {
		t.Fatalf("unparsable Secret YAML was not replaced: %q", broken)
	}

	// delete 等操作传空串，保持空串。
	if got := redactSecretYAML(string(common.Secrets), ""); got != "" {
		t.Fatalf("empty YAML became %q", got)
	}
}

// 端到端：改一次 Secret，落库的变更历史里不能出现新旧明文。
func TestSecretUpdateHistoryCarriesNoPlaintext(t *testing.T) {
	lastUpdatesTestDB(t)
	gin.SetMode(gin.TestMode)

	stored := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "default", ResourceVersion: "9"},
		Type:       corev1.SecretTypeOpaque,
		Data:       map[string][]byte{"password": []byte("old-secret-value")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(stored).Build()
	cs := &cluster.ClientSet{Name: "cluster-a", K8sClient: &kube.K8sClient{Client: k8sClient}}
	handler := newResourceHandlers()[string(common.Secrets)]

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPut, "/api/v1/secrets/default/db",
		strings.NewReader(`{"apiVersion":"v1","kind":"Secret","metadata":{"name":"db","namespace":"default","resourceVersion":"9"},"type":"Opaque","stringData":{"password":"new-secret-value"}}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	ctx.Params = gin.Params{{Key: "namespace", Value: "default"}, {Key: "name", Value: "db"}}
	ctx.Set("cluster", cs)
	ctx.Set("user", model.User{Username: "alice"})

	handler.Update(ctx)
	if recorder.Code != http.StatusOK {
		t.Fatalf("update returned %d, want %d; body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var histories []model.ResourceHistory
	if err := model.DB.Find(&histories).Error; err != nil {
		t.Fatalf("read resource history: %v", err)
	}
	if len(histories) == 0 {
		t.Fatal("no resource history recorded for the secret update")
	}

	wroteAnything := false
	for _, history := range histories {
		blob := string(history.ResourceYAML) + "\n" + string(history.PreviousYAML)
		for _, leak := range []string{"new-secret-value", "old-secret-value"} {
			if strings.Contains(blob, leak) {
				t.Fatalf("audit history leaked %q:\n%s", leak, blob)
			}
		}
		if strings.Contains(blob, "password") {
			wroteAnything = true
		}
	}
	if !wroteAnything {
		t.Fatal("audit history lost the key names, diff becomes useless")
	}
}
