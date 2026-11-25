//go:build duckdb_cli

package audit

import "aerolink/pkg/model"

// 本文件是**纯 Go 构建**（`-tags duckdb_cli`）下的驱动选择：用 CLI 子进程查 parquet。
//
// 为什么保留它：
//   - **交叉编译**：SDK 驱动依赖按平台分发的 libduckdb 静态库与对应 C 工具链，而 CLI 驱动
//     是纯 Go，四个平台的交叉编译目标靠它才成立（见 Makefile 的 cross-compile）；
//   - **无 CGO 环境**：目标机器没有 gcc/g++、或不允许 CGO 的场景；
//   - **兜底**：SDK 驱动出问题时，换个 tag 就能退回纯 Go 版本，不必回滚代码。
//
// 默认构建（无 tag）用的是 SDK 驱动，见 archive_query_duckdb_cgo.go。

// newDuckDBRunner 返回 CLI 驱动：本机没有 duckdb 可执行文件时报 ErrDuckDBUnavailable。
func newDuckDBRunner(_ model.S3Archive) (duckdbRunner, error) {
	return newDuckDBCLIRunner()
}

// DuckDBAvailable 报告本机是否具备 DuckDB 检索能力（纯 Go 构建下取决于 PATH 里有没有 duckdb）。
func DuckDBAvailable() bool {
	return duckdbCLIAvailable()
}
