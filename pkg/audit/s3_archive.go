package audit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/zxh326/kite/pkg/model"
)

// ErrS3ArchiveDisabled 表示 S3 归档未启用。调用方据此跳过上传，而不是当成故障。
var ErrS3ArchiveDisabled = errors.New("s3 archiving is disabled")

// S3Sink 把 flush 好的 parquet 文件上传到 S3 兼容对象存储
// （MinIO / RustFS / Ceph RGW / 腾讯 COS / 华为 OBS / 阿里 OSS / JuiceFS / SeaweedFS…）。
//
// 它只做「上传一个本地文件」这一件事：调用方（parquet archiver）在 flush 完成后
// 把相对 object key 与本地路径交给它。因此本文件不依赖归档目录布局，也不持有
// 本地文件的生命周期（是否「上传成功即删本地」由调用方按 DeleteLocalAfterUpload 决定），
// 可以脱离 writer 单独测试。
type S3Sink struct {
	client *minio.Client
	config model.S3Archive
}

// NewS3Sink 按配置构造 S3 客户端。未启用时返回 ErrS3ArchiveDisabled。
//
// 各家 S3 兼容存储只差 endpoint / pathStyle / region 三项，统一走 minio-go，
// 不写厂商专属 driver（见方案 §8.1）。
func NewS3Sink(config model.S3Archive) (*S3Sink, error) {
	if !config.Enabled {
		return nil, ErrS3ArchiveDisabled
	}
	if strings.TrimSpace(config.Endpoint) == "" || strings.TrimSpace(config.Bucket) == "" {
		return nil, errors.New("s3 endpoint and bucket are required")
	}

	endpoint, secure := normalizeS3Endpoint(config.Endpoint, config.UseTLS)
	client, err := minio.New(endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(config.AccessKey, string(config.SecretKey), ""),
		Secure:       secure,
		Region:       config.Region,
		BucketLookup: bucketLookup(config.PathStyle),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create s3 client: %w", err)
	}
	return &S3Sink{client: client, config: config}, nil
}

// normalizeS3Endpoint 归一化 endpoint（剥掉协议头），并据此对齐 secure。
//
// minio-go 要求 secure 与 endpoint 的 scheme **一致**，否则直接报错；而错误信息对管理员很不友好
// （"Endpoint url scheme \"https\" conflicts with the secure option"）。填 `https://...` 却忘了
// 打开「使用 TLS」是很容易犯的错，既然 endpoint 里已经写明了协议，就以它为准。
func normalizeS3Endpoint(endpoint string, useTLS bool) (string, bool) {
	trimmed := strings.TrimSpace(endpoint)
	switch {
	case strings.HasPrefix(trimmed, "https://"):
		return strings.TrimSuffix(strings.TrimPrefix(trimmed, "https://"), "/"), true
	case strings.HasPrefix(trimmed, "http://"):
		return strings.TrimSuffix(strings.TrimPrefix(trimmed, "http://"), "/"), false
	default:
		return strings.TrimSuffix(trimmed, "/"), useTLS
	}
}

// bucketLookup 把「path-style 」配置映射成 minio-go 的桶寻址模式。
//
// 必须显式指定，不能依赖 minio-go 的自动探测：腾讯 COS **强制 virtual-hosted**，
// 自动探测一旦退化成 path-style，请求会被拒（`The bucket you are attempting to access
// must be addressed using COS virtual-styled domain.`），且错误只在运行时出现——配置保存、
// 客户端构造都不会报错。该版本里 virtual-hosted 对应 minio.BucketLookupDNS。
func bucketLookup(pathStyle bool) minio.BucketLookupType {
	if pathStyle {
		return minio.BucketLookupPath
	}
	return minio.BucketLookupDNS
}

// Bucket 返回目标桶名。
func (s *S3Sink) Bucket() string { return s.config.Bucket }

// DeleteLocalAfterUpload 表示上传成功后是否删除本地文件（默认由配置决定）。
func (s *S3Sink) DeleteLocalAfterUpload() bool { return s.config.DeleteLocalAfterUpload }

// ListKeys 列出某个前缀下的对象键（递归）。
//
// 用于「分层检索」的探测：DuckDB 的 read_parquet 在 glob 匹配不到文件时会**直接报错**，
// 所以必须先确认 S3 上哪些日期确实有归档，再决定把哪些路径写进查询。
func (s *S3Sink) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	keys := make([]string, 0, 64)
	for object := range s.client.ListObjects(ctx, s.config.Bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	}) {
		if object.Err != nil {
			return nil, fmt.Errorf("failed to list %s: %w", prefix, object.Err)
		}
		keys = append(keys, object.Key)
	}
	return keys, nil
}

// ObjectKey 把相对名（`<类型>/<年>/<月>/<日>/<文件名>`）拼成最终 object key，
// 前缀为空时直接用相对名。始终以 `/` 分隔，不跟随宿主 OS 的路径分隔符。
func (s *S3Sink) ObjectKey(name string) string {
	name = strings.Trim(strings.ReplaceAll(name, "\\", "/"), "/")
	// 前缀同样规范化：sink 可能被直接构造（不经 model.Normalize），不能假设已 trim。
	prefix := strings.Trim(strings.ReplaceAll(s.config.Prefix, "\\", "/"), "/")
	if prefix == "" {
		return name
	}
	return prefix + "/" + name
}

// Upload 上传一个本地文件到对象存储。失败时本地文件保持不变，由上层重试补传，不丢数据。
func (s *S3Sink) Upload(ctx context.Context, name, localPath string) error {
	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("failed to open archive file: %w", err)
	}
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat archive file: %w", err)
	}

	key := s.ObjectKey(name)
	if _, err := s.client.PutObject(ctx, s.config.Bucket, key, file, info.Size(), minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	}); err != nil {
		return fmt.Errorf("failed to upload %s: %w", key, err)
	}
	return nil
}

// UploadBytes 上传一段内存里的对象数据（用于「本地不落盘」的内存直传）。
//
// 与 Upload 的区别：不读本地文件，直接从内存字节流上传。object key 的拼法与 Upload 一致。
func (s *S3Sink) UploadBytes(ctx context.Context, name string, data []byte) error {
	key := s.ObjectKey(name)
	if _, err := s.client.PutObject(ctx, s.config.Bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	}); err != nil {
		return fmt.Errorf("failed to upload %s: %w", key, err)
	}
	return nil
}

// Exists 判断对象是否已在桶里。
//
// 上传失败的文件会留在本地等待补传，补传前先问一次，避免把已经上传成功的对象重传一遍
// （尤其是 deleteLocalAfterUpload=false 时，本地会一直留着已上传的文件）。
func (s *S3Sink) Exists(ctx context.Context, name string) (bool, error) {
	key := s.ObjectKey(name)
	if _, err := s.client.StatObject(ctx, s.config.Bucket, key, minio.StatObjectOptions{}); err != nil {
		response := minio.ToErrorResponse(err)
		if response.Code == "NoSuchKey" || response.Code == "NotFound" ||
			response.StatusCode == http.StatusNotFound {
			return false, nil
		}
		return false, fmt.Errorf("failed to stat s3 object %s: %w", key, err)
	}
	return true, nil
}

// EnsureBucket 在桶不存在时创建。用于本地 RustFS/MinIO 联调与首次部署；
// 生产环境通常由运维预先建桶并配好策略，这里只是兜底。
func (s *S3Sink) EnsureBucket(ctx context.Context) error {
	exists, err := s.client.BucketExists(ctx, s.config.Bucket)
	if err != nil {
		return fmt.Errorf("failed to check s3 bucket %s: %w", s.config.Bucket, err)
	}
	if exists {
		return nil
	}
	if err := s.client.MakeBucket(ctx, s.config.Bucket, minio.MakeBucketOptions{Region: s.config.Region}); err != nil {
		return fmt.Errorf("failed to create s3 bucket %s: %w", s.config.Bucket, err)
	}
	return nil
}
