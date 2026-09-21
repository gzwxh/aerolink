package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"k8s.io/klog/v2"
)

// duckdbPathEnv 可指定 DuckDB CLI 的绝对路径；未设置时用 PATH 里的 `duckdb`。
//
// 这个文件**没有构建 tag**：CLI 驱动是纯 Go 的，任何构建下都编译得进来。它有两重身份——
// 默认构建下它就是唯一实现；带 `-tags duckdb_cgo` 时它是 SDK 初始化失败后的兜底，所以
// 不能因为「切到 SDK」就把它删掉，否则一旦 SDK 不可用（缺扩展、裁过的镜像）就彻底没有检索。
const duckdbPathEnv = "KITE_DUCKDB_PATH"

// duckdbCLIRunner 通过 exec 一个 duckdb 子进程执行 SQL。
//
// 好处是主程序保持纯 Go、静态单二进制、可交叉编译；代价是每次查询多一次进程启动
// （实测约 20–50ms，相对 S3 查询的网络往返可以忽略）。
type duckdbCLIRunner struct {
	// path 是解析后的可执行文件路径（LookPath 后的结果）。
	path string
}

// newDuckDBCLIRunner 构造 CLI 驱动；本机没有可执行文件时返回 ErrDuckDBUnavailable。
func newDuckDBCLIRunner() (*duckdbCLIRunner, error) {
	resolved, err := exec.LookPath(duckdbExecutable())
	if err != nil {
		return nil, ErrDuckDBUnavailable
	}
	return &duckdbCLIRunner{path: resolved}, nil
}

// duckdbExecutable 返回可执行文件路径（环境变量优先）。
func duckdbExecutable() string {
	if custom := strings.TrimSpace(os.Getenv(duckdbPathEnv)); custom != "" {
		return custom
	}
	return "duckdb"
}

// duckdbCLIAvailable 报告本机是否有 CLI 可执行文件。
func duckdbCLIAvailable() bool {
	_, err := exec.LookPath(duckdbExecutable())
	return err == nil
}

// Query 执行 SQL 并解析 JSON 输出。
//
// setup 必须与 SELECT 拼成**同一次调用**：子进程每次都是全新的引擎，分两次调用的话 SET 与
// INSTALL 的效果不会保留到查询里。
//
// 走 exec.Command 直接传参（不经过 shell），所以 SQL 本身不会成为命令注入面；SQL 层面的
// 注入防护见 archive_condition.go 的白名单与转义。
func (r *duckdbCLIRunner) Query(ctx context.Context, setup []string, statement string) ([]map[string]any, error) {
	queryCtx, cancel := context.WithTimeout(ctx, duckdbQueryTimeout)
	defer cancel()

	statements := make([]string, 0, len(setup)+1)
	statements = append(statements, setup...)
	statements = append(statements, statement)

	cmd := exec.CommandContext(queryCtx, r.path, "-json", "-c", strings.Join(statements, "; "))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		stderrText := stderr.String()
		// glob 无匹配时 DuckDB 直接报错而不是返回空集。我们无法预知 S3 上哪些日期确实有文件，
		// 所以把这种情况当成「该时间段没有归档」，而不是让整次查询失败。
		if strings.Contains(stderrText, duckdBNothingMatched) {
			return nil, nil
		}
		klog.Warningf("duckdb archive query failed: %v", err)
		return nil, fmt.Errorf("duckdb query failed: %w (stderr: %s)", err, truncateForError(stderrText))
	}
	return parseDuckDBJSON(stdout.Bytes())
}

// truncateForError 截断 CLI 的 stderr，避免把整段输出塞进接口错误里。
func truncateForError(message string) string {
	trimmed := strings.TrimSpace(message)
	if len(trimmed) > 300 {
		return trimmed[:300] + "..."
	}
	return trimmed
}

// parseDuckDBJSON 解析 CLI 的 `-json` 输出。
//
// 同一次调用里可能执行了多条语句（先 SET 后 SELECT），输出会是多段 JSON；因此先试整体解析，
// 失败再从最后一个 `[` 起找可解析的数组（只关心 SELECT 的结果）。不同 DuckDB 版本的输出
// 细节有差异，这里保持宽容，避免因为一行日志输出就判定失败。
func parseDuckDBJSON(raw []byte) ([]map[string]any, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, nil
	}

	var rows []map[string]any
	if err := json.Unmarshal(trimmed, &rows); err == nil {
		return rows, nil
	}

	for start := bytes.LastIndexByte(trimmed, '['); start >= 0; start = bytes.LastIndexByte(trimmed[:start], '[') {
		decoder := json.NewDecoder(bytes.NewReader(trimmed[start:]))
		var candidate []map[string]any
		if err := decoder.Decode(&candidate); err == nil {
			return candidate, nil
		}
	}
	return nil, errors.New("failed to parse duckdb output as JSON")
}
