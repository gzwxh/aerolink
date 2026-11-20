package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// —— DuckDB 检索：公共部分 ——
//
// 同一套「查 parquet」的能力有**两种驱动实现**，本文件只放两者共用的东西（SQL 构造、glob
// 计算、结果归一），以及那个可替换的驱动接口：
//
//   - CLI 驱动（archive_query_duckdb_cli.go）：exec 一个 duckdb 子进程。纯 Go，不需要 CGO，
//     所以**总是编译进二进制**，既可作为默认实现，也可作为 SDK 的兜底。
//   - SDK 驱动（archive_query_duckdb_cgo.go，需 `-tags duckdb_cgo`）：cgo 绑定，进程内直查，
//     不再依赖外部可执行文件，省掉每次查询的进程启动开销。
//
// 两者的**结果必须逐字段一致**（前端与导出逻辑不区分后端），差异只在「怎么把 SQL 送进引擎」。
// 因此 SQL 拼装、时间范围归一、列裁剪、毫秒→RFC3339 的转换全部留在本文件，驱动只负责执行。

const (
	// duckdbQueryTimeout 是单次查询超时。查 S3 时受网络影响，给得比 ES 宽松。
	duckdbQueryTimeout = 90 * time.Second

	// duckdbDefaultRangeDays 是未指定时间范围时的默认跨度。
	duckdbDefaultRangeDays = 7

	// duckdbMaxRangeDays 是单次查询允许的最大跨度。
	//
	// 在对象存储上「不限定范围就扫全桶」是灾难：这里用硬上限兜住，超出直接报错让调用方
	// 缩小范围，而不是让一次点击把整桶文件都拉一遍。
	duckdbMaxRangeDays = 90

	// duckdBNothingMatched 是 DuckDB 在 glob 匹配不到任何文件时的报错特征串。
	//
	// 本地目录会先探测过滤（见 parquetGlobs），但 S3 上无法预知哪一天有文件，
	// 因此把这条报错识别成「该时间段没有归档」而不是整次查询失败。两种驱动共用这个判断。
	duckdBNothingMatched = "No files found that match the pattern"
)

// ErrDuckDBUnavailable 表示当前构建与运行环境下都没有可用的 DuckDB 检索能力。
var ErrDuckDBUnavailable = errors.New("duckdb is not available: install the duckdb CLI or set " + duckdbPathEnv)

// duckdbRunner 是「把 SQL 送到 DuckDB 并拿回行」的驱动接口。
//
// setup 是本次查询需要的前置语句（INSTALL/LOAD httpfs、SET s3_*）。**CLI 驱动必须用它**：
// 每次调用都是新进程，SET 不与 SELECT 在同一次调用里执行就完全无效。SDK 驱动把它们放在
// 连接初始化里（见 archive_query_duckdb_cgo.go），因此忽略这个参数——所以参数由调用方给、
// 由驱动决定怎么用，而不是让驱动自己去取配置。
type duckdbRunner interface {
	Query(ctx context.Context, setup []string, statement string) ([]map[string]any, error)
}

// DuckDBBackend 用 DuckDB 直接查 parquet，作为「没有 Elasticsearch」时的检索后端。
//
// 检索分层：本地是热层、S3 是冷层。同一个文件在两边各有一份时（上传保持文件名不变）
// 只扫一份，按覆盖关系选边；本地与 S3 互有独占文件的天两边都要扫，并在 SQL 里按
// (文件名, 行号) 去重合并（见 parquetGlobs）。
// 归档配置了 deleteLocalAfterUpload=false 时，本地保留期内的数据不必绕网络。
type DuckDBBackend struct {
	// runner 是实际执行 SQL 的驱动（CLI 或 SDK，由构建 tag 决定，见 newDuckDBRunner）。
	runner   duckdbRunner
	localDir string
	s3       model.S3Archive
	// s3Sink 仅在 s3.Enabled 时非空：用于探测 S3 上哪些日期确实有归档文件。
	//
	// 为什么需要探测：DuckDB 的 read_parquet 在 glob 匹配不到文件时**直接报错**（不是返回空集），
	// 而某个日期没有文件很常见（当天还没落盘、或该类日志当天为空）；把不存在的日期混进路径
	// 列表会让整次查询失败，连本地已有的数据也一起看不到。
	s3Sink s3KeyLister
}

// s3KeyLister 只依赖「列前缀」这一个能力：S3Sink 是生产实现，测试可注入假实现。
type s3KeyLister interface {
	ListKeys(ctx context.Context, prefix string) ([]string, error)
}

// NewDuckDBBackend 构造本地/S3 的 parquet 检索后端。
//
// localDir 为空表示不查本地（例如 deleteLocalAfterUpload=true）；s3 未启用表示不查对象存储。
// 两者都没有可查的来源时返回错误。
func NewDuckDBBackend(localDir string, s3 model.S3Archive) (*DuckDBBackend, error) {
	localDir = strings.TrimSpace(localDir)
	if localDir == "" && !s3.Enabled {
		return nil, errors.New("no parquet archive source is configured (local directory or s3)")
	}

	runner, err := newDuckDBRunner(s3)
	if err != nil {
		return nil, err
	}

	backend := &DuckDBBackend{runner: runner, localDir: localDir, s3: s3}
	if s3.Enabled {
		sink, err := NewS3Sink(s3)
		if err != nil {
			return nil, err
		}
		backend.s3Sink = sink
	}
	return backend, nil
}

// Search 用 SQL 查本地与/或 S3 上的归档 parquet，返回与 ES 后端同构的结果。
func (b *DuckDBBackend) Search(ctx context.Context, query archiveQuery, from, to time.Time, page, size int) (*archiveSearchResult, error) {
	parquetKind, ok := parquetKindForESKind(query.kind)
	if !ok {
		return nil, fmt.Errorf("unsupported archive kind %q", query.kind)
	}
	columns := archiveColumnsFor(query.kind)
	if len(columns) == 0 {
		return nil, fmt.Errorf("no queryable columns for archive kind %q", query.kind)
	}

	from, to, err := normalizeDuckDBRange(from, to)
	if err != nil {
		return nil, err
	}

	plan := b.parquetGlobs(ctx, parquetKind, from, to)
	if len(plan.globs) == 0 {
		// 该时间段没有任何归档文件：返回空结果，而不是走进引擎报错。
		// Hits 必须是**非 nil 空切片**：它会直接进响应 JSON，nil 会序列化成 `null`，
		// 而界面把 data 当数组用（`data.length`），null 会让整个归档页崩掉。
		return &archiveSearchResult{Hits: []json.RawMessage{}}, nil
	}

	statement, err := buildDuckDBSQL(query, columns, plan.globs, plan.dedupCopies, from, to, page, size)
	if err != nil {
		return nil, err
	}

	// 只有 CLI 驱动真的会用到 setup；SDK 驱动已在连接初始化里设好了。
	var setup []string
	if plan.useS3 {
		setup = duckdbS3Statements(b.s3)
	}

	rows, err := b.runner.Query(ctx, setup, statement)
	if err != nil {
		return nil, err
	}
	return duckdbRowsToResult(rows, query.timeField), nil
}

// normalizeDuckDBRange 归一化时间范围：缺省补默认跨度，并拒绝过大的跨度。
func normalizeDuckDBRange(from, to time.Time) (time.Time, time.Time, error) {
	if to.IsZero() {
		to = time.Now()
	}
	if from.IsZero() {
		from = to.AddDate(0, 0, -duckdbDefaultRangeDays)
	}
	if from.After(to) {
		return time.Time{}, time.Time{}, errors.New("invalid time range: from is after to")
	}
	if to.Sub(from) > time.Duration(duckdbMaxRangeDays)*24*time.Hour {
		return time.Time{}, time.Time{}, fmt.Errorf(
			"time range is too wide for parquet search (max %d days); please narrow it down", duckdbMaxRangeDays)
	}
	return from, to, nil
}

// parquetScanPlan 描述一次检索要扫描哪些 parquet 文件。
type parquetScanPlan struct {
	// globs 是交给 read_parquet 的路径列表，本地 glob 与 s3:// 路径可混用。
	globs []string
	// useS3 表示列表里含 s3:// 路径，调用方需要先执行 S3 会话设置（httpfs 等）。
	useS3 bool
	// dedupCopies 表示本地与 S3 对某一天互有独占文件、两边都在列表里；同一个
	// 文件在两边各有一份（上传保持文件名不变），SQL 必须按 (文件名, 行号) 去重。
	dedupCopies bool
}

// parquetGlobs 计算需要扫描的文件路径。
//
// 分层按「文件」而不是按「天」：同一个文件在本地与 S3 各有一份时（上传保持相对名
// 不变，文件名即同一份数据的身份）只扫一份——S3 覆盖更全就整条查 S3，反之查本地；
// 两边互有独占文件的天（容量清理删过当天一部分、多副本各写各的本地目录）两边都要扫，
// 靠 SQL 去重合并。旧实现「本地有一个文件就整条跳过 S3」会静默漏掉 S3 独有的数据。
//
// 两侧都必须保证路径真的有文件：DuckDB 的 read_parquet 在 glob 匹配不到文件时**直接报错**，
// 所以本地用 filepath.Glob 预检、S3 按月做一次 ListObjects 探测。
func (b *DuckDBBackend) parquetGlobs(ctx context.Context, kind ParquetKind, from, to time.Time) parquetScanPlan {
	days := archiveDays(from, to)
	basePrefix := strings.Trim(b.s3.Prefix, "/")

	type dayPlan struct {
		monthKey  string
		date      string
		localGlob string
		// localNames 是本地当天文件的文件名集合，用于与 S3 按文件比对覆盖关系。
		localNames map[string]struct{}
	}
	plans := make([]*dayPlan, 0, len(days))
	months := make([]string, 0, 4)
	monthSeen := make(map[string]bool, 4)

	for _, day := range days {
		year, month, date := day.Format("2006"), day.Format("01"), day.Format("02")
		plan := &dayPlan{
			monthKey:   year + "/" + month,
			date:       date,
			localNames: map[string]struct{}{},
		}
		if b.localDir != "" {
			glob := filepath.Join(b.localDir, string(kind), year, month, date, "*.parquet")
			if matches, err := filepath.Glob(glob); err == nil && len(matches) > 0 {
				plan.localGlob = glob
				for _, match := range matches {
					plan.localNames[filepath.Base(match)] = struct{}{}
				}
			}
		}
		if b.s3Sink != nil && !monthSeen[plan.monthKey] {
			monthSeen[plan.monthKey] = true
			months = append(months, plan.monthKey)
		}
		plans = append(plans, plan)
	}

	// S3 按月列一次，键按「日 → 文件名集合」分组：与本地按文件名比对（而不是只比对
	// 「这一天有没有文件」），才能发现同一天里本地缺的那部分。
	s3ByDay := make(map[string]map[string]map[string]struct{}, len(months))
	for _, monthKey := range months {
		s3Prefix := string(kind) + "/" + monthKey + "/"
		if basePrefix != "" {
			s3Prefix = basePrefix + "/" + s3Prefix
		}

		keys, err := b.s3Sink.ListKeys(ctx, s3Prefix)
		if err != nil {
			// 探测失败只影响「S3 侧数据」的可见性，不能让整次查询失败：
			// 本地结果照常返回并留下告警，而不是把一次 S3 抖动放大成检索不可用。
			klog.Warningf("failed to probe s3 archive prefix %s: %v", s3Prefix, err)
			continue
		}

		byDay := make(map[string]map[string]struct{}, 32)
		for _, key := range keys {
			// key 形如 <前缀>/<类型>/<年>/<月>/<日>/<文件名>，倒数第二段就是日期。
			parts := strings.Split(strings.Trim(key, "/"), "/")
			if len(parts) < 2 {
				continue
			}
			date, name := parts[len(parts)-2], parts[len(parts)-1]
			day, ok := byDay[date]
			if !ok {
				day = make(map[string]struct{}, 8)
				byDay[date] = day
			}
			day[name] = struct{}{}
		}
		s3ByDay[monthKey] = byDay
	}

	s3DayGlob := func(p *dayPlan) string {
		s3Prefix := string(kind) + "/" + p.monthKey + "/"
		if basePrefix != "" {
			s3Prefix = basePrefix + "/" + s3Prefix
		}
		return fmt.Sprintf("s3://%s/%s%s/*.parquet", b.s3.Bucket, s3Prefix, p.date)
	}

	plan := parquetScanPlan{globs: make([]string, 0, len(days))}
	for _, p := range plans {
		var s3Names map[string]struct{}
		if byDay, ok := s3ByDay[p.monthKey]; ok {
			s3Names = byDay[p.date]
		}

		switch {
		case len(s3Names) == 0 && p.localGlob != "":
			// S3 上没有（或探测不到）这一天的文件：本地有就只查本地。
			plan.globs = append(plan.globs, p.localGlob)
		case len(s3Names) == 0:
			// 当天本地与 S3 都没有文件：read_parquet 对空 glob 直接报错，跳过。
		case p.localGlob == "":
			g := s3DayGlob(p)
			plan.globs = append(plan.globs, g)
			plan.useS3 = true
		default:
			// 同一天两边都有文件，按文件名比对覆盖关系：
			//  - S3 ⊆ 本地：本地 glob 已覆盖全部数据，且优先走本地热层。
			//  - 本地 ⊆ S3：S3 glob 已覆盖全部数据，只扫一份，不重复读共享文件。
			//  - 互有独占：两边都要扫，靠 (文件名, 行号) 在 SQL 里去重。
			switch {
			case namesSubset(s3Names, p.localNames):
				plan.globs = append(plan.globs, p.localGlob)
			case namesSubset(p.localNames, s3Names):
				g := s3DayGlob(p)
				plan.globs = append(plan.globs, g)
				plan.useS3 = true
			default:
				plan.globs = append(plan.globs, p.localGlob, s3DayGlob(p))
				plan.useS3 = true
				plan.dedupCopies = true
			}
		}
	}
	return plan
}

// namesSubset 报告 a 里的每个名字都在 b 里。
func namesSubset(a, b map[string]struct{}) bool {
	for name := range a {
		if _, ok := b[name]; !ok {
			return false
		}
	}
	return true
}

// archiveDays 返回 [from, to) 覆盖的每一天（按本地时区、对齐到当天零点）。
func archiveDays(from, to time.Time) []time.Time {
	days := make([]time.Time, 0, 32)
	cursor := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, from.Location())
	for cursor.Before(to) && len(days) <= duckdbMaxRangeDays {
		days = append(days, cursor)
		cursor = cursor.AddDate(0, 0, 1)
	}
	return days
}

// parquetKindForESKind 把 ES/接口层的分类映射回 parquet 的目录类型。
func parquetKindForESKind(kind string) (ParquetKind, bool) {
	switch kind {
	case ESKindAuditHistory:
		return KindAuditHistory, true
	case ESKindLoginRecord:
		return KindLoginRecord, true
	case ESKindPasswordChangeLog:
		return KindPasswordChangeLog, true
	case ESKindAccessLog:
		return KindAccessLog, true
	default:
		return "", false
	}
}

// archiveColumnsFor 返回某类归档要 SELECT 的列。
//
// 刻意**不含** resource_yaml / previous_yaml：它们可能很大，检索页并不展示，带上会让扫描量
// 成倍增加（parquet 的列裁剪只有在不 SELECT 时才生效）。
func archiveColumnsFor(kind string) []string {
	switch kind {
	case ESKindAuditHistory:
		return []string{
			"id", "created_at", "cluster_name", "resource_type", "resource_name", "namespace",
			"operation_type", "operation_source", "success", "error_message",
			"client_ip", "user_agent", "operator_id", "operator_name",
		}
	case ESKindLoginRecord:
		return []string{"id", "created_at", "user_id", "username", "provider", "ip", "user_agent", "result"}
	case ESKindPasswordChangeLog:
		return []string{"id", "created_at", "user_id", "username", "operator_id", "operator", "source"}
	case ESKindAccessLog:
		return []string{"ts", "client_ip", "method", "path", "status_code", "latency_ms", "cluster", "user"}
	default:
		return nil
	}
}

// duckdbUint64Columns 是 parquet 里按 UINT64 存储、必须显式 CAST 才能让两种驱动输出一致的列。
//
// 为什么需要：DuckDB 的 CLI `-json` 输出会把 UBIGINT 编码成**字符串**（避免 JS 侧精度丢失），
// 而 SDK 通过 database/sql 拿到的是原生整数。同一个查询，前者给 "2"、后者给 2，前端就得为
// 「同一个后端、不同驱动」写两套判断。BIGINT 没有这个问题（两侧都是数字），所以统一 CAST 成
// BIGINT —— 主键与用户 ID 的量级远达不到 int64 上限，转换是安全的。
//
// 新增 UINT64 列时记得加进来（archiveColumnsFor 里列的就是这些列）。
var duckdbUint64Columns = map[string]bool{
	"id":          true,
	"user_id":     true,
	"operator_id": true,
}

// buildDuckDBSQL 组装查询语句。
//
// 一次查询同时拿到「命中总数」与「当前页」：`count(*) OVER ()` 在 LIMIT 之前算，扫一遍就够。
func buildDuckDBSQL(
	query archiveQuery,
	columns []string,
	globs []string,
	dedupCopies bool,
	from, to time.Time,
	page, size int,
) (string, error) {
	where, err := toSQLWhere(query.filters, query.timeField, from, to)
	if err != nil {
		return "", err
	}
	timeColumn, err := sqlIdentifier(query.timeField)
	if err != nil {
		return "", err
	}

	quotedGlobs := make([]string, 0, len(globs))
	for _, glob := range globs {
		literal, err := sqlLiteral(glob)
		if err != nil {
			return "", err
		}
		quotedGlobs = append(quotedGlobs, literal)
	}

	// 列名全部来自 archiveColumnsFor 的常量表，这里不再过白名单，但要处理 UINT64 的 CAST。
	selectColumns := make([]string, 0, len(columns))
	for _, column := range columns {
		if duckdbUint64Columns[column] {
			selectColumns = append(selectColumns, "CAST("+column+" AS BIGINT) AS "+column)
			continue
		}
		selectColumns = append(selectColumns, column)
	}

	if page < 1 {
		page = 1
	}
	if size <= 0 || size > 500 {
		size = 20
	}
	offset := (page - 1) * size

	columnList := strings.Join(selectColumns, ", ")
	globList := strings.Join(quotedGlobs, ", ")
	if dedupCopies {
		// 本地与 S3 互有独占文件的天两个来源都要扫；同一个文件在两边各有一份，
		// 按 (文件名, 行号) 去重，否则命中总数与结果行都会翻倍。filename 与
		// file_row_number 由 read_parquet 的参数提供，不进 SELECT 列表；WHERE 在
		// 去重之前执行，谓词下推不受影响；count 在去重后的行集上算，外层只排序分页。
		return fmt.Sprintf(
			"SELECT count(*) OVER () AS __total, %s FROM (SELECT %s FROM read_parquet([%s], filename=true, file_row_number=true) WHERE %s QUALIFY row_number() OVER (PARTITION BY regexp_replace(filename, '^.*[/\\\\]', ''), file_row_number) = 1) ORDER BY %s DESC LIMIT %d OFFSET %d",
			columnList, columnList, globList, where, timeColumn, size, offset,
		), nil
	}
	return fmt.Sprintf(
		"SELECT count(*) OVER () AS __total, %s FROM read_parquet([%s]) WHERE %s ORDER BY %s DESC LIMIT %d OFFSET %d",
		columnList, globList, where, timeColumn, size, offset,
	), nil
}

// duckdbExtensionDir 返回 DuckDB 安装扩展的目录。
//
// 为什么要显式落定：DuckDB 默认把扩展装在 `~/.duckdb`，而 INSTALL / LOAD 需要能往那里写文件——
// HOME 不可写（容器里最常见的一类）时 httpfs 永远装不上，查 S3 归档随之不可用。默认落到进程
// 自己的可写临时目录，不依赖 HOME；离线部署要预装扩展时，用 AEROLINK_DUCKDB_EXTENSION_DIR
// 指向镜像里预置的扩展目录（见 charts/aerolink 的 duckdbExtensionDir）。
func duckdbExtensionDir() string {
	if custom := strings.TrimSpace(common.DuckDBExtensionDir); custom != "" {
		return custom
	}
	return filepath.Join(os.TempDir(), "aerolink-duckdb-extensions")
}

// duckdbS3Statements 返回访问 S3 需要的 DuckDB 语句（CLI 驱动前置执行；SDK 驱动在连接初始化执行）。
//
// endpoint 与 TLS 走 normalizeS3Endpoint 的同一份口径（与上传端一致）：endpoint 带
// 协议头时以协议头为准——填 https:// 却没开 UseTLS 的配置，上传走 TLS，这里若仍按
// UseTLS 生成明文连接，冷层检索会协议不匹配。寻址方式与 minio-go 的 PathStyle 保持
// 同一语义——腾讯 COS 这类强制 virtual-hosted 的厂商必须 vhost。
func duckdbS3Statements(s3 model.S3Archive) []string {
	endpoint, useTLS := normalizeS3Endpoint(s3.Endpoint, s3.UseTLS)

	urlStyle := "vhost"
	if s3.PathStyle {
		urlStyle = "path"
	}

	set := func(name, value string) string {
		literal, err := sqlLiteral(value)
		if err != nil {
			// 值来自配置而非用户输入；真出现 NUL 就让它显式失败，不静默降级。
			return "SET " + name + "=''"
		}
		return "SET " + name + "=" + literal
	}

	return []string{
		// 扩展目录必须先落定：默认的 ~/.duckdb 在容器里通常不可写（见 duckdbExtensionDir）。
		set("extension_directory", duckdbExtensionDir()),
		"INSTALL httpfs",
		"LOAD httpfs",
		set("s3_endpoint", endpoint),
		set("s3_region", s3.Region),
		set("s3_access_key_id", s3.AccessKey),
		set("s3_secret_access_key", string(s3.SecretKey)),
		"SET s3_use_ssl=" + fmt.Sprintf("%t", useTLS),
		set("s3_url_style", urlStyle),
	}
}

// duckdbRowsToResult 把 SQL 结果行转成与 ES 后端同构的检索结果。
//
// 关键一处归一：parquet 里时间是毫秒整数，而 ES 后端返回 RFC3339 字符串——这里统一转成
// 字符串，前端才能用同一套渲染逻辑，不必区分后端。两种驱动（CLI 的 JSON 输出、SDK 的原生
// 类型）都必须先经过 normalizeDuckDBValue，才能在这里被一视同仁地处理。
func duckdbRowsToResult(rows []map[string]any, timeField string) *archiveSearchResult {
	result := &archiveSearchResult{Hits: make([]json.RawMessage, 0, len(rows))}
	for _, row := range rows {
		if total, ok := row["__total"]; ok {
			result.Total = toInt64(total)
			delete(row, "__total")
		}
		if value, ok := row[timeField]; ok {
			if millis := toInt64(value); millis > 0 {
				row[timeField] = time.UnixMilli(millis).Format(time.RFC3339)
			}
		}

		data, err := json.Marshal(row)
		if err != nil {
			continue
		}
		result.Hits = append(result.Hits, data)
	}
	return result
}

// normalizeDuckDBValue 把驱动拿回来的原生值收敛成「能被 JSON 正确序列化、且与 CLI 输出一致」的类型。
//
// CLI 走 JSON 解码，天然得到 float64 / string，而 SDK 通过 database/sql 拿到的是 int64 /
// []byte / time.Time 等原生类型。差异必须在这里抹平，否则同一份数据在两个驱动下会渲染成
// 不同的 JSON（[]byte 会被 encoding/json 编码成 base64，time.Time 会变成 RFC3339 而不是
// 毫秒整数——后者会让下游的「毫秒→RFC3339」归一逻辑失灵）。
func normalizeDuckDBValue(value any) any {
	switch typed := value.(type) {
	case []byte:
		return string(typed)
	case time.Time:
		return typed.UnixMilli()
	default:
		return value
	}
}

// duckdbNothingMatchedError 判断错误是否来自「glob 没匹配到文件」。
//
// 这是 DuckDB 引擎的行为而不是某个驱动的行为，所以两种驱动共用：命中就当成「该时间段没有
// 归档」，返回空结果而不是失败。
func duckdbNothingMatchedError(err error) bool {
	return err != nil && strings.Contains(err.Error(), duckdBNothingMatched)
}

// toInt64 把驱动给的值统一成 int64（CLI 解码后是 float64，SDK 侧是 int64，也可能是 json.Number）。
func toInt64(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	case uint64:
		// SDK 对未 CAST 的 UBIGINT 列可能直接给出 uint64。
		return int64(typed)
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}
