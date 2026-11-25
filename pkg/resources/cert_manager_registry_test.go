package resources

import (
	"testing"

	certmanageracmev1 "github.com/cert-manager/cert-manager/pkg/apis/acme/v1"
	certmanagerapiv1 "github.com/cert-manager/cert-manager/pkg/apis/certmanager/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/kube"
)

func TestCertManagerResourcesRegistered(t *testing.T) {
	for _, test := range []struct {
		alias         string
		kind          string
		group         string
		clusterScoped bool
	}{
		{alias: "certificates", kind: "Certificate", group: "cert-manager.io", clusterScoped: false},
		{alias: "certificaterequests", kind: "CertificateRequest", group: "cert-manager.io", clusterScoped: false},
		{alias: "issuers", kind: "Issuer", group: "cert-manager.io", clusterScoped: false},
		{alias: "clusterissuers", kind: "ClusterIssuer", group: "cert-manager.io", clusterScoped: true},
		{alias: "orders", kind: "Order", group: "acme.cert-manager.io", clusterScoped: false},
		{alias: "challenges", kind: "Challenge", group: "acme.cert-manager.io", clusterScoped: false},
	} {
		t.Run(test.alias, func(t *testing.T) {
			meta := common.LookupResource(test.alias)
			if meta == nil {
				t.Fatalf("%s not registered in resource registry", test.alias)
			}
			if string(meta.Plural) != test.alias || meta.Kind != test.kind || meta.Group != test.group {
				t.Fatalf("meta = %s/%s/%s, want %s/%s/%s", meta.Kind, meta.Group, meta.Plural, test.kind, test.group, test.alias)
			}
			if meta.ClusterScoped != test.clusterScoped {
				t.Fatalf("%s clusterScoped = %t, want %t", test.alias, meta.ClusterScoped, test.clusterScoped)
			}
			if newResourceHandlers()[test.alias] == nil {
				t.Fatalf("%s has no resource handler", test.alias)
			}
		})
	}
}

func TestCertManagerSchemeRegistered(t *testing.T) {
	kinds, _, err := kube.GetScheme().ObjectKinds(&certmanagerapiv1.Certificate{})
	if err != nil {
		t.Fatalf("Certificate not registered in scheme: %v", err)
	}
	if kinds[0] != (schema.GroupVersionKind{Group: "cert-manager.io", Version: "v1", Kind: "Certificate"}) {
		t.Fatalf("Certificate GVK = %s", kinds[0])
	}
	kinds, _, err = kube.GetScheme().ObjectKinds(&certmanageracmev1.Challenge{})
	if err != nil {
		t.Fatalf("Challenge not registered in scheme: %v", err)
	}
	if kinds[0] != (schema.GroupVersionKind{Group: "acme.cert-manager.io", Version: "v1", Kind: "Challenge"}) {
		t.Fatalf("Challenge GVK = %s", kinds[0])
	}
}
