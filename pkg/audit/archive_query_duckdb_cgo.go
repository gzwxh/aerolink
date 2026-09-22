//go:build !duckdb_cli

package audit

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	duckdb "github.com/duckdb/duckdb-go/v2"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// 本文件是 DuckDB 的 **SDK（cgo）驱动**，是**默认构建**用的驱动（`-tags duckdb_cli` 时改用
// CLI 驱动，见 archive_query_duckdb_cli_build.go）。
//
// 相比 CLI 驱动（exec 子进程）的区别：
//   - 不再依赖目标机装 duckdb 可执行文件：引擎（libduckdb，含 parquet 扩展）静态链进二进制；
//   - 省掉每次查询的进程启动，SQL 走 database/sql，天然带参数化能力；
//   - 代价是构建需要 CGO + C/C++ 工具链，产物不再是纯静态二进制（依赖 libstdc++/libc），
//     交叉编译要各平台预编译库。
//
// CLI 驱动仍保留在本文件之外，作为 SDK 起不来时的兜底（见 queryWithFallback）。

const (
	// duckdbSDKMaxConns 限制同时打开的 DuckDB 实例数。
	//
	// 关键认知：DuckDB 是**嵌入式**引擎，`database/sql` 的每个连接都是一个独立的 database
	// 实例（不共享 buffer pool、不共享已加载的数据）。所以这不是「连接池复用一个引擎」，而是
	// 「最多同时开几个引擎」：开太多会成倍吃内存。归档检索是低频操作，2 个足够覆盖
	// 「一个页面查询 + 一个导出」并发的场景。
	duckdbSDKMaxConns = 2

	// duckdbSDKThreads 是单个 DuckDB 实例的查询线程数。
	//
	// DuckDB 默认按 CPU 核数开线程；配合上面的多实例，不设上限会在并发查询时把机器打满，
	// 反而拖慢同机的请求处理。
	duckdbSDKThreads = 4

	// duckdbSDKMemoryLimit 是单个实例的内存上限。
	//
	// 作用对象是「一次大范围扫描」：DuckDB 默认会用可用的绝大部分内存做 hash/排序，单机部署
	// 里这个默认值不合适（它与鸢联 AeroLink 主进程抢内存）。
	duckdbSDKMemoryLimit = "1GB"

	// duckdbSDKIdleTimeout 是空闲连接的保留时长。
	//
	// 保留一会儿是有意的：打开一个引擎（加载 libduckdb、装扩展）比复用贵得多，而归档检索
	// 往往是「连着点几页」的形态。
	duckdbSDKIdleTimeout = 5 * time.Minute
)

// duckdbSDKRunner 用 cgo 绑定在进程内执行 SQL。
type duckdbSDKRunner struct {
	s3 model.S3Archive

	// once 保证连接池只建一次，且失败结果被记住——初始化（起引擎、装扩展）不便宜，
	// 不能在每次查询上重试。
	once sync.Once
	db   *sql.DB
	err  error

	// fallback 是 SDK 初始化失败后的兜底（CLI 驱动）。惰性构造：CLI 也不可用时，要把
	// 「SDK 为什么失败」和「CLI 为什么不可用」两个原因都报出来，而不是互相覆盖。
	fallbackMu  sync.Mutex
	fallback    duckdbRunner
	fallbackErr error

	warnOnce sync.Once
}

// newDuckDBSDKRunner 构造 SDK 驱动（此时不建立连接，第一次查询才初始化）。
func newDuckDBSDKRunner(s3 model.S3Archive) *duckdbSDKRunner {
	return &duckdbSDKRunner{s3: s3}
}

// Close 释放连接池（进程内缓存换配置时调用）。
func (r *duckdbSDKRunner) Close() error {
	if r == nil {
		return nil
	}
	r.fallbackMu.Lock()
	defer r.fallbackMu.Unlock()
	if r.db == nil {
		return nil
	}
	err := r.db.Close()
	r.db = nil
	return err
}

// open 惰性建立连接池，只执行一次。
func (r *duckdbSDKRunner) open() (*sql.DB, error) {
	r.once.Do(func() {
		connector, err := duckdb.NewConnector("", r.initialize)
		if err != nil {
			r.err = fmt.Errorf("failed to create the duckdb connector: %w", err)
			return
		}
		db := sql.OpenDB(connector)
		db.SetMaxOpenConns(duckdbSDKMaxConns)
		db.SetMaxIdleConns(duckdbSDKMaxConns)
		db.SetConnMaxIdleTime(duckdbSDKIdleTimeout)

		// 真正建一次连接：把「引擎能不能起来」暴露在初始化阶段，而不是等用户点了查询才报错。
		if err := db.PingContext(context.Background()); err != nil {
			r.err = fmt.Errorf("failed to open duckdb: %w", err)
			_ = db.Close()
			return
		}
		r.db = db
	})
	return r.db, r.err
}

// initialize 在每个新连接建立时执行：会话级资源限制 + S3 访问所需的设置。
//
// 放在这里而不是拼在查询前面，是因为每个连接都是独立实例——设置必须逐连接生效。
func (r *duckdbSDKRunner) initialize(execer driver.ExecerContext) error {
	ctx := context.Background()

	statements := []string{
		fmt.Sprintf("SET threads=%d", duckdbSDKThreads),
		"SET memory_limit='" + duckdbSDKMemoryLimit + "'",
	}
	// 只有真的要用 S3 才装 httpfs：INSTALL 需要联网下载扩展，本地 parquet 检索（parquet 扩展
	// 是编译进 libduckdb 的）完全用不到它，不该为一个用不上的能力引入网络依赖。
	if r.s3.Enabled {
		statements = append(statements, duckdbS3Statements(r.s3)...)
	}

	for _, statement := range statements {
		if _, err := execer.ExecContext(ctx, statement, []driver.NamedValue{}); err != nil {
			// 扩展语句的失败只影响「查 S3」，本地热层照常可用，所以降级为告警，
			// 不让它把整个后端拖成不可用（受限网络下 INSTALL 拉不到扩展是常见情况）。
			if isExtensionStatement(statement) {
				klog.Warningf("duckdb: %q failed, S3 archive search may be unavailable: %v", statement, err)
				continue
			}
			return fmt.Errorf("failed to run %q: %w", statement, err)
		}
	}
	return nil
}

// Query 执行一条 SELECT。
//
// setup 被忽略：CLI 驱动必须把前置语句与 SELECT 拼进同一次子进程调用，而 SDK 驱动在每个连接
// 建立时就做完了（见 initialize），这里再执行一遍只是白费时间。
func (r *duckdbSDKRunner) Query(ctx context.Context, _ []string, statement string) ([]map[string]any, error) {
	db, err := r.open()
	if err != nil {
		return r.queryWithFallback(ctx, statement, err)
	}

	queryCtx, cancel := context.WithTimeout(ctx, duckdbQueryTimeout)
	defer cancel()

	rows, err := db.QueryContext(queryCtx, statement)
	if err != nil {
		if duckdbNothingMatchedError(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("duckdb query failed: %w", err)
	}
	defer func() { _ = rows.Close() }()

	columns, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("failed to read duckdb result columns: %w", err)
	}

	result := make([]map[string]any, 0, 64)
	values := make([]any, len(columns))
	pointers := make([]any, len(columns))
	for i := range values {
		pointers[i] = &values[i]
	}

	for rows.Next() {
		if err := rows.Scan(pointers...); err != nil {
			return nil, fmt.Errorf("failed to scan a duckdb row: %w", err)
		}
		row := make(map[string]any, len(columns))
		for i, name := range columns {
			// 立刻归一：值里的 []byte 会被 encoding/json 编成 base64，必须在这里转掉。
			row[name] = normalizeDuckDBValue(values[i])
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		if duckdbNothingMatchedError(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("duckdb row iteration failed: %w", err)
	}
	return result, nil
}

// queryWithFallback 在 SDK 起不来时退回 CLI 驱动。
//
// 保留这条路径的意义：SDK 把引擎编进了二进制，但仍依赖运行时的扩展目录、CPU 特性与静态链接
// 的 C++ 运行时。真出问题时，退到「装了 duckdb CLI 就还能查」比让归档检索整体不可用要好。
func (r *duckdbSDKRunner) queryWithFallback(ctx context.Context, statement string, cause error) ([]map[string]any, error) {
	runner, err := r.cliFallback()
	if err != nil {
		return nil, fmt.Errorf("duckdb sdk is unavailable (%w), and the cli fallback is not available either: %w", cause, err)
	}
	r.warnOnce.Do(func() {
		klog.Warningf("duckdb sdk is unavailable (%v); falling back to the duckdb cli driver", cause)
	})
	return runner.Query(ctx, nil, statement)
}

// cliFallback 惰性构造并缓存 CLI 驱动的兜底实例。
func (r *duckdbSDKRunner) cliFallback() (duckdbRunner, error) {
	r.fallbackMu.Lock()
	defer r.fallbackMu.Unlock()
	if r.fallback != nil {
		return r.fallback, nil
	}
	if r.fallbackErr != nil {
		return nil, r.fallbackErr
	}

	cli, err := newDuckDBCLIRunner()
	if err != nil {
		r.fallbackErr = err
		return nil, err
	}
	r.fallback = cli
	return cli, nil
}

// isExtensionStatement 报告一条语句是否是 INSTALL / LOAD（扩展的加载，允许失败）。
func isExtensionStatement(statement string) bool {
	upper := strings.ToUpper(strings.TrimSpace(statement))
	return strings.HasPrefix(upper, "INSTALL ") || strings.HasPrefix(upper, "LOAD ")
}

// DuckDBAvailable 报告是否具备 DuckDB 检索能力。
//
// SDK 构建下恒为真：引擎已经静态链进二进制，不依赖目标机上有没有可执行文件——这也正是切到
// SDK 的主要收益之一（部署少一个必须就位的文件）。
func DuckDBAvailable() bool { return true }

// newDuckDBRunner 在 SDK 构建下返回 SDK 驱动，并**按配置缓存**。
//
// 为什么必须缓存：检索后端是每次请求现构造的（见 currentArchiveSearcher），而 SDK 的初始化
// 是「打开一个嵌入式引擎」，若每请求重建，代价远大于 CLI 起进程。配置未变时复用同一个连接池；
// 配置变了（例如换了 S3 账号）就关掉旧的、建新的，避免旧引擎一直占着内存。
func newDuckDBRunner(s3 model.S3Archive) (duckdbRunner, error) {
	key := duckdbRunnerCacheKey(s3)

	duckdbRunnerCacheMu.Lock()
	defer duckdbRunnerCacheMu.Unlock()
	if duckdbRunnerCached != nil && duckdbRunnerCachedKey == key {
		return duckdbRunnerCached, nil
	}
	if duckdbRunnerCached != nil {
		klog.Infof("duckdb s3 configuration changed; recycling the embedded engine")
		_ = duckdbRunnerCached.Close()
		duckdbRunnerCached = nil
	}

	duckdbRunnerCached = newDuckDBSDKRunner(s3)
	duckdbRunnerCachedKey = key
	return duckdbRunnerCached, nil
}

var (
	duckdbRunnerCacheMu sync.Mutex
	duckdbRunnerCached  *duckdbSDKRunner
	// duckdbRunnerCachedKey 是缓存键：配置一致就复用引擎。
	duckdbRunnerCachedKey string
)

// duckdbRunnerCacheKey 把 S3 配置摘要成缓存键。
//
// 取摘要而不是原值：配置里有 secret key，没必要把明文密钥在内存里多留一份、更不该出现在
// 任何日志或错误文本中。
func duckdbRunnerCacheKey(s3 model.S3Archive) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%v", s3)))
	return hex.EncodeToString(sum[:8])
}
