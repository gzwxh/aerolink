package audit

import "os"

// uploadMarkerSuffix 是「已成功上传到对象存储」标记的后缀。
//
// 为什么需要它：当 deleteLocalAfterUpload=false（配了 S3 但本地要长期保留一份）时，本地清理
// 只按「保留天数 / 容量」下手——如果某次上传失败了，到期后清理会把这份**唯一**的副本删掉，
// S3 上又没有，数据就永久丢了。上传成功后落一个同目录的空标记文件，清理**只删带标记的**；
// 补传巡检也据此跳过，省掉「每个文件一次 S3 HEAD」的开销。
//
// 后缀刻意不以 `.parquet` 结尾：本地检索与 DuckDB 的 `*.parquet` glob 不会把它当成归档文件。
const uploadMarkerSuffix = ".uploaded"

// uploadMarkerPath 返回某个归档文件对应的标记路径。
func uploadMarkerPath(path string) string {
	return path + uploadMarkerSuffix
}

// markUploaded 落「已上传」标记。
//
// 返回错误由调用方决定如何处理：写不上标记不该让这次上传算失败（对象已经在 S3 上了），
// 代价只是清理会更保守（保留本地文件）。
func markUploaded(path string) error {
	file, err := os.OpenFile(uploadMarkerPath(path), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	return file.Close()
}

// isUploaded 报告某个归档文件是否已有「已上传」标记。
func isUploaded(path string) bool {
	_, err := os.Stat(uploadMarkerPath(path))
	return err == nil
}

// removeUploadMarker 删除标记（本地归档文件被清理时顺手删掉，避免残留空壳）。
func removeUploadMarker(path string) {
	_ = os.Remove(uploadMarkerPath(path))
}
