package audit

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

func TestNewS3SinkDisabled(t *testing.T) {
	if _, err := NewS3Sink(model.S3Archive{Enabled: false}); !errors.Is(err, ErrS3ArchiveDisabled) {
		t.Fatalf("NewS3Sink(disabled) error = %v, want ErrS3ArchiveDisabled", err)
	}
}

func TestNewS3SinkRequiresEndpointAndBucket(t *testing.T) {
	if _, err := NewS3Sink(model.S3Archive{Enabled: true, Endpoint: "http://minio:9000"}); err == nil {
		t.Fatal("NewS3Sink() without bucket returned nil error")
	}
	if _, err := NewS3Sink(model.S3Archive{Enabled: true, Bucket: "kite-audit"}); err == nil {
		t.Fatal("NewS3Sink() without endpoint returned nil error")
	}
}

func TestS3SinkObjectKey(t *testing.T) {
	cases := []struct {
		name   string
		prefix string
		input  string
		want   string
	}{
		{name: "with prefix", prefix: "kite", input: "audit_history/2026/09/20/a.parquet", want: "kite/audit_history/2026/09/20/a.parquet"},
		{name: "empty prefix", prefix: "", input: "audit_history/2026/09/20/a.parquet", want: "audit_history/2026/09/20/a.parquet"},
		{name: "prefix keeps slashes normalized", prefix: "/kite/", input: "/audit_history/a.parquet", want: "kite/audit_history/a.parquet"},
		{name: "windows separators normalized", prefix: "kite", input: `audit_history\2026\a.parquet`, want: "kite/audit_history/2026/a.parquet"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sink := &S3Sink{config: model.S3Archive{Prefix: tc.prefix}}
			if got := sink.ObjectKey(tc.input); got != tc.want {
				t.Fatalf("ObjectKey(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestS3SinkDeleteLocalAfterUpload(t *testing.T) {
	enabled := &S3Sink{config: model.S3Archive{DeleteLocalAfterUpload: true}}
	if !enabled.DeleteLocalAfterUpload() {
		t.Error("DeleteLocalAfterUpload() = false, want true")
	}
	disabled := &S3Sink{config: model.S3Archive{DeleteLocalAfterUpload: false}}
	if disabled.DeleteLocalAfterUpload() {
		t.Error("DeleteLocalAfterUpload() = true, want false")
	}
}

// newFakeS3 起一个最小的 S3 端点：记录 HEAD/PUT 次数，并按 uploaded 状态回 404 或 200。
func newFakeS3(t *testing.T, uploaded *bool, heads, puts *int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodHead:
			*heads++
			if *uploaded {
				// minio-go 的 StatObject 会解析 Last-Modified，缺了会直接报错。
				w.Header().Set("Content-Length", "16")
				w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
				w.WriteHeader(http.StatusOK)
				return
			}
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>not found</Message></Error>`))
		case http.MethodPut:
			*puts++
			*uploaded = true
			w.Header().Set("ETag", `"abc"`)
			w.WriteHeader(http.StatusOK)
		default:
			// minio-go 可能先问 bucket location 等，一律 200 兜底。
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newTestS3Sink(t *testing.T, endpoint string, deleteLocal bool) *S3Sink {
	t.Helper()
	sink, err := NewS3Sink(model.S3Archive{
		Enabled:                true,
		Endpoint:               endpoint,
		Region:                 "us-east-1",
		Bucket:                 "kite-audit",
		PathStyle:              true,
		DeleteLocalAfterUpload: deleteLocal,
	})
	if err != nil {
		t.Fatalf("NewS3Sink() error = %v", err)
	}
	return sink
}

func TestS3SinkExistsReportsMissingObject(t *testing.T) {
	var uploaded bool
	var heads, puts int
	server := newFakeS3(t, &uploaded, &heads, &puts)
	sink := newTestS3Sink(t, server.URL, false)

	exists, err := sink.Exists(context.Background(), "audit_history/2026/09/20/a.parquet")
	if err != nil {
		t.Fatalf("Exists() error = %v", err)
	}
	if exists {
		t.Error("Exists() = true for a missing object")
	}
}

// 补传的幂等性：对象不存在才上传；已存在则跳过上传，只按配置处理本地文件。
func TestS3UploadIfMissingIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "audit_history", "2026", "09", "20", "a.parquet")
	writeArchiveFixture(t, localPath, 16, time.Now())

	var uploaded bool
	var heads, puts int
	server := newFakeS3(t, &uploaded, &heads, &puts)
	sink := newTestS3Sink(t, server.URL, true)

	name := "audit_history/2026/09/20/a.parquet"
	sent, err := s3UploadIfMissing(context.Background(), sink, name, localPath)
	if err != nil {
		t.Fatalf("first call error = %v", err)
	}
	if !sent || puts != 1 {
		t.Fatalf("first call should upload: sent=%v puts=%d", sent, puts)
	}
	if _, err := os.Stat(localPath); !os.IsNotExist(err) {
		t.Error("uploaded file should be removed locally when deleteLocalAfterUpload=true")
	}

	// 再放一份同名文件，模拟「上次上传成功但删本地失败」后残留的重复文件。
	writeArchiveFixture(t, localPath, 16, time.Now())
	sent, err = s3UploadIfMissing(context.Background(), sink, name, localPath)
	if err != nil {
		t.Fatalf("second call error = %v", err)
	}
	if sent {
		t.Error("second call should skip the upload because the object already exists")
	}
	if puts != 1 {
		t.Errorf("PUT count = %d, want 1 (no re-upload)", puts)
	}
	if _, err := os.Stat(localPath); !os.IsNotExist(err) {
		t.Error("redundant local file should still be cleaned up")
	}
}

// deleteLocalAfterUpload=false 时，补传后必须保留本地文件（本地是长期存储）。
func TestS3UploadIfMissingKeepsLocalWhenConfigured(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "access_log", "2026", "09", "20", "a.parquet")
	writeArchiveFixture(t, localPath, 16, time.Now())

	var uploaded bool
	var heads, puts int
	server := newFakeS3(t, &uploaded, &heads, &puts)
	sink := newTestS3Sink(t, server.URL, false)

	if _, err := s3UploadIfMissing(context.Background(), sink, "access_log/2026/09/20/a.parquet", localPath); err != nil {
		t.Fatalf("s3UploadIfMissing() error = %v", err)
	}
	if _, err := os.Stat(localPath); err != nil {
		t.Errorf("local file should be kept when deleteLocalAfterUpload=false: %v", err)
	}
}
