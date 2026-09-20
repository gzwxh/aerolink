package images

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
)

func TestGetRegistry(t *testing.T) {
	tests := []struct {
		name       string
		image      string
		wantDocker bool
		wantRepo   string
		wantBase   string
	}{
		{name: "implicit docker hub", image: "nginx:latest", wantDocker: true, wantRepo: "library/nginx"},
		{name: "explicit docker hub", image: "docker.io/library/nginx:latest", wantDocker: true, wantRepo: "library/nginx"},
		{name: "custom registry", image: "ghcr.io/org/image:1.0", wantDocker: false, wantBase: "ghcr.io", wantRepo: "org/image"},
		{name: "custom registry with port", image: "localhost:5000/org/image:1.0", wantDocker: false, wantBase: "localhost:5000", wantRepo: "org/image"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := getRegistry(tt.image)
			if tt.wantDocker {
				dockerReg, ok := reg.(dockerRegistry)
				if !ok {
					t.Fatalf("getRegistry(%q) returned %T, want dockerRegistry", tt.image, reg)
				}
				if dockerReg.repo != tt.wantRepo {
					t.Fatalf("dockerRegistry.repo = %q, want %q", dockerReg.repo, tt.wantRepo)
				}
				return
			}

			v2Reg, ok := reg.(containerRegistryV2)
			if !ok {
				t.Fatalf("getRegistry(%q) returned %T, want containerRegistryV2", tt.image, reg)
			}
			if v2Reg.baseURL != tt.wantBase {
				t.Fatalf("containerRegistryV2.baseURL = %q, want %q", v2Reg.baseURL, tt.wantBase)
			}
			if v2Reg.repo != tt.wantRepo {
				t.Fatalf("containerRegistryV2.repo = %q, want %q", v2Reg.repo, tt.wantRepo)
			}
		})
	}
}

func imageTagCtx(image string, clusters []string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	target := "/image-tags"
	if image != "" {
		target += "?image=" + url.QueryEscape(image)
	}
	ctx.Request = httptest.NewRequest(http.MethodGet, target, nil)
	if clusters != nil {
		ctx.Set("user", model.User{Roles: []common.Role{{Name: "admin", Clusters: clusters}}})
		ctx.Set("cluster", &cluster.ClientSet{Name: "test"})
	}
	return ctx, rec
}

func TestGetImageTagsRequiresImage(t *testing.T) {
	ctx, rec := imageTagCtx("", []string{"*"})

	GetImageTags(ctx)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status code = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestGetImageTagsRequiresClusterAccess(t *testing.T) {
	// 已登录，但没有任何集群权限。
	ctx, rec := imageTagCtx("nginx:latest", []string{"other-cluster"})

	GetImageTags(ctx)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status code = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestGetImageTagsRejectsInternalHosts(t *testing.T) {
	cases := []string{
		"127.0.0.1:5000/app:1.0",
		"169.254.169.254/latest/meta-data:1.0",
		"10.0.0.5:5000/app:1.0",
		"localhost:5000/app:1.0",
	}
	for _, image := range cases {
		ctx, rec := imageTagCtx(image, []string{"*"})
		GetImageTags(ctx)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("image %q: status code = %d, want %d", image, rec.Code, http.StatusBadRequest)
		}
	}
}

func TestDockerRegistryGetTags(t *testing.T) {
	origTransport := registryHTTPClient.Transport
	registryHTTPClient.Transport = roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		wantURL := "https://hub.docker.com/v2/repositories/library/nginx/tags?page_size=10&ordering=last_updated"
		if req.URL.String() != wantURL {
			return nil, fmt.Errorf("unexpected URL %q", req.URL.String())
		}
		body := `{"results":[{"name":"latest","last_updated":"2026-03-27T10:00:00Z"},{"name":"1.0","last_updated":"2026-03-27T11:00:00Z"}]}`
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})
	t.Cleanup(func() {
		registryHTTPClient.Transport = origTransport
	})

	tags, err := dockerRegistry{repo: "library/nginx"}.GetTags(context.Background())
	if err != nil {
		t.Fatalf("GetTags() error = %v", err)
	}
	if len(tags) != 2 {
		t.Fatalf("GetTags() len = %d, want 2", len(tags))
	}
	if tags[0].Name != "latest" || tags[0].Timestamp == nil || tags[0].Timestamp.UTC() != time.Date(2026, 3, 27, 10, 0, 0, 0, time.UTC) {
		t.Fatalf("first tag = %#v", tags[0])
	}
	if tags[1].Name != "1.0" || tags[1].Timestamp == nil || tags[1].Timestamp.UTC() != time.Date(2026, 3, 27, 11, 0, 0, 0, time.UTC) {
		t.Fatalf("second tag = %#v", tags[1])
	}
}

func TestContainerRegistryV2GetTags(t *testing.T) {
	origTransport := registryHTTPClient.Transport
	registryHTTPClient.Transport = roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		wantURL := "https://ghcr.io/v2/org/image/tags/list"
		if req.URL.String() != wantURL {
			return nil, fmt.Errorf("unexpected URL %q", req.URL.String())
		}
		body := `{"tags":["v1","sha256:deadbeef","v2"]}`
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})
	t.Cleanup(func() {
		registryHTTPClient.Transport = origTransport
	})

	tags, err := containerRegistryV2{baseURL: "ghcr.io", repo: "org/image"}.GetTags(context.Background())
	if err != nil {
		t.Fatalf("GetTags() error = %v", err)
	}
	if len(tags) != 2 {
		t.Fatalf("GetTags() len = %d, want 2", len(tags))
	}
	if tags[0].Name != "v1" || tags[1].Name != "v2" {
		t.Fatalf("GetTags() = %#v", tags)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
