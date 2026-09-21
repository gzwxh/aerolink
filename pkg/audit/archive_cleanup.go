package audit

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"k8s.io/klog/v2"
)

// defaultArchiveCleanupInterval 是本地归档清理的巡检周期。审计与访问日志的保留期以
// 「天」为单位，不需要更频繁的检查。
const defaultArchiveCleanupInterval = 6 * time.Hour

// runArchiveCleanupLoop 周期性清理本地归档文件，随 ctx 退出。
func runArchiveCleanupLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanupArchives()
		}
	}
}

// cleanupArchives 按当前生效的运行时配置清理本地归档（审计与访问日志分开）。
func cleanupArchives() {
	archiveMu.RLock()
	runtime := archiveCurrent
	archiveMu.RUnlock()
	if runtime == nil {
		return
	}
	runtime.cleanup()
}

// cleanup 清理审计三类与访问日志：各自的保留天数与容量上限。
//
// 清理独立于写入协程：某个目录清理失败不会影响其它目录，也不会影响写入。
//
// 配了 S3 时（r.s3 != nil）只删**已确认上传成功**的文件：本地可能还承载着唯一副本
// （上传失败、尚未补传成功），按时间直接删就等于永久丢数据。
func (r *archiveRuntime) cleanup() {
	requireUpload := r.s3 != nil
	pruneArchiveKinds(r.dir,
		[]ParquetKind{KindAuditHistory, KindLoginRecord, KindPasswordChangeLog},
		r.retention, r.maxBytes, requireUpload)
	if r.access != nil {
		pruneArchiveKinds(r.dir, []ParquetKind{KindAccessLog}, r.accessRetain, r.accessMaxByte, requireUpload)
	}
}

// pruneArchiveKinds 对若干归档类型执行「按时间 + 按容量」清理。
// retentionDays / maxBytes 为 0 表示该项不清理；requireUpload 为真时只删已上传的文件。
func pruneArchiveKinds(archiveDir string, kinds []ParquetKind, retentionDays int, maxBytes int64, requireUpload bool) {
	for _, kind := range kinds {
		dir := filepath.Join(archiveDir, string(kind))
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		if retentionDays > 0 {
			pruneExpiredFiles(dir, time.Now().AddDate(0, 0, -retentionDays), requireUpload)
		}
		if maxBytes > 0 {
			enforceMaxBytes(dir, maxBytes, requireUpload)
		}
	}
}

// pruneExpiredFiles 删除 mtime 早于 cutoff 的终态文件，并清掉随之空掉的目录。
// 只处理 .parquet（终态）：.tmp 属于正在写入的文件，不在这里动。
//
// requireUpload 为真时，没有「已上传」标记的文件一律保留：它可能还是唯一副本。
func pruneExpiredFiles(kindDir string, cutoff time.Time, requireUpload bool) {
	removed := 0
	retained := 0
	_ = filepath.WalkDir(kindDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".parquet") {
			return nil //nolint:nilerr // 单个条目读不到（已被删/没权限）就跳过它，不中断整轮巡检。
		}
		info, err := entry.Info()
		if err != nil {
			return nil //nolint:nilerr // 同上：拿不到信息就不处理这一个文件。
		}
		if !info.ModTime().Before(cutoff) {
			return nil
		}
		if requireUpload && !isUploaded(path) {
			// 还没上传成功（或补传一直没成功）：宁可占着磁盘也不能删，否则永久丢数据。
			retained++
			return nil
		}
		if err := os.Remove(path); err == nil {
			removeUploadMarker(path)
			removed++
		}
		return nil
	})
	if retained > 0 {
		archiveRetainedUnuploaded.Store(int64(retained))
		klog.Warningf("archive cleanup kept %d expired file(s) under %s because they are not uploaded yet", retained, kindDir)
	}
	if removed > 0 {
		removeEmptyDirs(kindDir)
		klog.Infof("archive cleanup removed %d expired file(s) under %s", removed, kindDir)
	}
}

// enforceMaxBytes 超出容量上限时从最旧的文件开始删，直到降到上限以内。
//
// requireUpload 为真时跳过没有「已上传」标记的文件：超容量也不能删掉唯一副本，
// 由指标（retained_unuploaded_files）提醒运维去处理上传通道，而不是悄悄丢数据。
func enforceMaxBytes(kindDir string, maxBytes int64, requireUpload bool) {
	type archiveFile struct {
		path     string
		size     int64
		modTime  time.Time
		uploaded bool
	}

	var files []archiveFile
	var total int64
	_ = filepath.WalkDir(kindDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".parquet") {
			return nil //nolint:nilerr // 单个条目读不到就跳过它，不中断整轮清理。
		}
		info, err := entry.Info()
		if err != nil {
			return nil //nolint:nilerr // 同上：拿不到信息就不统计这一个文件。
		}
		files = append(files, archiveFile{
			path:     path,
			size:     info.Size(),
			modTime:  info.ModTime(),
			uploaded: !requireUpload || isUploaded(path),
		})
		total += info.Size()
		return nil
	})
	if total <= maxBytes {
		return
	}

	sort.Slice(files, func(i, j int) bool { return files[i].modTime.Before(files[j].modTime) })
	removed := 0
	skipped := 0
	for _, file := range files {
		if total <= maxBytes {
			break
		}
		if !file.uploaded {
			skipped++
			continue
		}
		if err := os.Remove(file.path); err == nil {
			removeUploadMarker(file.path)
			total -= file.size
			removed++
		}
	}
	if skipped > 0 {
		archiveRetainedUnuploaded.Add(int64(skipped))
		klog.Warningf("archive cleanup kept %d unuploaded file(s) in %s while enforcing the size limit", skipped, kindDir)
	}
	if removed > 0 {
		removeEmptyDirs(kindDir)
		klog.Infof("archive cleanup removed %d file(s) to stay under %d bytes in %s", removed, maxBytes, kindDir)
	}
}

// removeEmptyDirs 自底向上删除空的日期目录，避免归档目录里堆积空壳。
func removeEmptyDirs(root string) {
	var dirs []string
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.IsDir() && path != root {
			dirs = append(dirs, path)
		}
		return nil
	})
	// 深的优先，删掉子目录后父目录才可能变空。
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err == nil && len(entries) == 0 {
			_ = os.Remove(dir)
		}
	}
}

// archiveRetryInterval 是上传补传的巡检间隔。比清理频繁得多：上传失败后应当尽快补上，
// 而清理是「天」级策略。
const archiveRetryInterval = 5 * time.Minute

// uploadRetryMinAge 只补传「已经存在一会儿」的文件，避免和刚刚发起的首次上传抢同一个文件。
const uploadRetryMinAge = 30 * time.Second

// runArchiveRetryLoop 周期性补传上传失败的归档文件，随 ctx 退出。
func runArchiveRetryLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			archiveMu.RLock()
			runtime := archiveCurrent
			archiveMu.RUnlock()
			if runtime != nil {
				runtime.retryPendingUploads(ctx)
			}
		}
	}
}

// retryPendingUploads 扫描本地归档目录，把「S3 上还没有」的 parquet 补传上去。
//
// 上传失败的文件会被保留在本地（见 s3FlushHook），这里做**幂等补传**：先问对象是否存在，
// 不存在才上传，存在则直接按配置处理本地文件。它不依赖内存里的待办队列，所以进程重启后
// 依然能补齐之前失败的批次。
func (r *archiveRuntime) retryPendingUploads(ctx context.Context) {
	if r.s3 == nil {
		return
	}

	pending := 0
	uploaded := 0
	// 巡检结束后把积压量写进指标：持续增长说明上传一直没成功，需要告警介入。
	defer func() { archivePendingFiles.Store(int64(pending)) }()
	_ = filepath.WalkDir(r.dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".parquet") {
			return nil //nolint:nilerr // 单个条目读不到就跳过它，不中断整轮补传巡检。
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		info, err := entry.Info()
		if err != nil || time.Since(info.ModTime()) < uploadRetryMinAge {
			return nil //nolint:nilerr // 拿不到信息或文件还太新（可能正在上传）都跳过。
		}
		rel, err := filepath.Rel(r.dir, path)
		if err != nil {
			return nil //nolint:nilerr // 算不出相对路径就不补传这一个文件。
		}

		// 已标记上传的直接跳过：本地长期保留时文件可能成千上万，逐个做 S3 HEAD 太贵。
		if isUploaded(path) {
			return nil
		}

		pending++
		sent, err := s3UploadIfMissing(ctx, r.s3, filepath.ToSlash(rel), path)
		if err != nil {
			archiveUploadFailures.Add(1)
			klog.Warningf("archive upload retry failed for %s: %v", path, err)
			return nil
		}
		if sent {
			uploaded++
		}
		return nil
	})

	if uploaded > 0 {
		klog.Infof("archive upload retry: uploaded %d pending file(s) (scanned %d local file(s))", uploaded, pending)
	}
}

// s3UploadIfMissing 幂等上传一个本地文件：对象已存在就跳过上传，只按配置处理本地文件。
// 返回值表示这次是否真的执行了上传（用于日志统计）。
func s3UploadIfMissing(ctx context.Context, sink *S3Sink, name, localPath string) (bool, error) {
	exists, err := sink.Exists(ctx, name)
	if err != nil {
		return false, err
	}

	if !exists {
		if err := sink.Upload(ctx, name, localPath); err != nil {
			return false, err
		}
	}
	if !sink.DeleteLocalAfterUpload() {
		// 对象已在 S3 上（可能这次传的，也可能早就传过）：落标记，之后不再重复检查，
		// 本地清理也据此判断「这份有远端副本，可以删」。
		if err := markUploaded(localPath); err != nil {
			klog.Warningf("uploaded %s but failed to write the upload marker: %v", name, err)
		}
		return !exists, nil
	}
	if err := os.Remove(localPath); err != nil && !os.IsNotExist(err) {
		return !exists, fmt.Errorf("uploaded %s but failed to remove the local file: %w", name, err)
	}
	removeUploadMarker(localPath)
	return !exists, nil
}
