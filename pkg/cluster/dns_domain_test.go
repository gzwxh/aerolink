package cluster

import (
	"context"
	"testing"

	"aerolink/pkg/kube"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

func TestDNSDomainFromCorefile(t *testing.T) {
	for _, tc := range []struct {
		name     string
		corefile string
		want     string
	}{
		{
			name: "kubeadm 标准 Corefile",
			corefile: `.:53 {
    errors
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
    }
    forward . /etc/resolv.conf
}`,
			want: "cluster.local",
		},
		{
			name: "自定义集群域",
			corefile: `.:53 {
    kubernetes k8s.example.internal in-addr.arpa ip6.arpa {
       pods insecure
    }
}`,
			want: "k8s.example.internal",
		},
		{
			name: "RKE2 形式（参数换行，大括号在下一行）",
			corefile: `.:53 {
    kubernetes k8s.example.internal in-addr.arpa ip6.arpa
    forward . /etc/resolv.conf
}`,
			want: "k8s.example.internal",
		},
		{
			name:     "没有 kubernetes 插件时解析不出",
			corefile: `.:53 { forward . /etc/resolv.conf }`,
			want:     "",
		},
		{
			name:     "空 Corefile",
			corefile: "",
			want:     "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := dnsDomainFromCorefile(tc.corefile); got != tc.want {
				t.Errorf("dnsDomainFromCorefile() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClientSetDNSDomain(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	corefile := `.:53 {
    kubernetes k8s.example.internal in-addr.arpa ip6.arpa {
       pods insecure
    }
}`
	gets := 0
	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(&corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "coredns"},
			Data:       map[string]string{"Corefile": corefile},
		}).
		WithInterceptorFuncs(interceptor.Funcs{
			Get: func(ctx context.Context, underlying client.WithWatch, key client.ObjectKey, object client.Object, opts ...client.GetOption) error {
				gets++
				return underlying.Get(ctx, key, object, opts...)
			},
		}).
		Build()

	cs := &ClientSet{K8sClient: &kube.K8sClient{Client: fakeClient, DirectClient: fakeClient}}
	ctx := context.Background()

	// 首次解析读 coredns 配置；失败候选自动跳过。
	if got := cs.DNSDomain(ctx); got != "k8s.example.internal" {
		t.Fatalf("DNSDomain() = %q, want k8s.example.internal", got)
	}
	// TTL 缓存：第二次调用不再访问 apiserver。
	if got := cs.DNSDomain(ctx); got != "k8s.example.internal" {
		t.Fatalf("cached DNSDomain() = %q, want k8s.example.internal", got)
	}
	if gets != 1 {
		t.Fatalf("coredns Get calls = %d, want 1（TTL 内必须走缓存）", gets)
	}

	// 无客户端 / 读不到配置时回落默认域，与旧行为一致。
	if got := (*ClientSet)(nil).DNSDomain(ctx); got != DefaultClusterDNSDomain {
		t.Errorf("nil ClientSet DNSDomain() = %q, want %q", got, DefaultClusterDNSDomain)
	}
	empty := &ClientSet{K8sClient: &kube.K8sClient{
		Client:       fake.NewClientBuilder().WithScheme(scheme).Build(),
		DirectClient: fake.NewClientBuilder().WithScheme(scheme).Build(),
	}}
	if got := empty.DNSDomain(ctx); got != DefaultClusterDNSDomain {
		t.Errorf("missing coredns DNSDomain() = %q, want %q", got, DefaultClusterDNSDomain)
	}
}
