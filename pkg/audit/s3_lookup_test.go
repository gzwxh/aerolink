package audit

import (
	"testing"

	"github.com/minio/minio-go/v7"
)

// PathStyle 必须真正影响桶寻址方式。
//
// 它曾经是个「摆设」：NewS3Sink 构造客户端时根本没把这个配置传给 minio-go，于是自动探测
// 在腾讯 COS（强制 virtual-hosted）上退化成 path-style，上传被拒——而配置保存与客户端
// 构造都不会报错，问题只在上传时才暴露。
func TestBucketLookupFollowsPathStyleOption(t *testing.T) {
	if got := bucketLookup(true); got != minio.BucketLookupPath {
		t.Errorf("bucketLookup(true) = %v, want BucketLookupPath", got)
	}
	if got := bucketLookup(false); got != minio.BucketLookupDNS {
		t.Errorf("bucketLookup(false) = %v, want minio.BucketLookupDNS (virtual-hosted)", got)
	}
}

// endpoint 里的协议头决定 secure。
//
// minio-go 要求两者一致，否则直接报错；填 `https://...` 却忘了打开「使用 TLS」是很容易犯的
// 错，不该让它变成一句晦涩的启动失败。
func TestNormalizeS3EndpointAlignsSecure(t *testing.T) {
	cases := []struct {
		endpoint string
		useTLS   bool
		wantHost string
		wantTLS  bool
	}{
		{"https://cos.ap-guangzhou.myqcloud.com", false, "cos.ap-guangzhou.myqcloud.com", true},
		{"https://cos.ap-guangzhou.myqcloud.com/", true, "cos.ap-guangzhou.myqcloud.com", true},
		{"http://minio:9000", true, "minio:9000", false},
		{"http://127.0.0.1:9000", false, "127.0.0.1:9000", false},
		// 不带协议头时以配置项为准。
		{"minio:9000", true, "minio:9000", true},
		{"minio:9000", false, "minio:9000", false},
	}

	for _, tc := range cases {
		host, secure := normalizeS3Endpoint(tc.endpoint, tc.useTLS)
		if host != tc.wantHost || secure != tc.wantTLS {
			t.Errorf("normalizeS3Endpoint(%q, %v) = (%q, %v), want (%q, %v)",
				tc.endpoint, tc.useTLS, host, secure, tc.wantHost, tc.wantTLS)
		}
	}
}
