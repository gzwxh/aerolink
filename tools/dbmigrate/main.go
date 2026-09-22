// Command dbmigrate 把鸢联 AeroLink 的整库数据从一个数据库搬到另一个数据库（sqlite / mysql /
// postgres 之间任意方向，典型用途是换成 PostgreSQL 以便多副本部署）。
//
// 为什么不用 mysqldump / pg_dump / sqlite3：
//   - 目标环境不一定有这些客户端（容器运行时里连 shell 都没有）；
//   - 时间列在各方言里的存储形式不同（SQLite 存的是带纳秒与时区偏移的字符串），
//     逐条走 GORM 模型读写可以复用应用本身那套类型转换，不必手工改写 SQL 文本；
//   - SecretString 列是 AES-GCM 密文，必须用与源库相同的 AEROLINK_ENCRYPT_KEY 解密，
//     再按目标库配置的密钥重新加密，这只有走模型才能做到。
//
// 步骤与切流注意事项见 docs/dev/plans/2026-09-20-sqlite-to-postgres-migration.md。
package main

import (
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"k8s.io/klog/v2"
)

const (
	dbTypeSQLite   = "sqlite"
	dbTypeMySQL    = "mysql"
	dbTypePostgres = "postgres"
)

type options struct {
	sourceType string
	sourceDSN  string
	targetType string
	targetDSN  string
	batchSize  int
	dryRun     bool
}

// table 是待搬运的一张表：目标表名、主键列名，以及已经从源库读出来的整表数据。
//
// 先把源库全部读完再动目标库，是为了让「密钥不对 / 某列读不出来」这类错误在
// 落笔之前就暴露出来——否则会留下一个搬到一半的目标库，而运维很难判断它是否可用。
// 本库数据量为个位数 MB（见方案文档），整表驻留内存没有问题。
type table struct {
	name  string
	pk    string
	rows  interface{}
	count int
}

func main() {
	klog.InitFlags(nil)
	opts := parseFlags()

	if err := run(&opts); err != nil {
		klog.Errorf("migration failed: %v", err)
		os.Exit(1)
	}
}

func parseFlags() options {
	var opts options
	flag.StringVar(&opts.sourceType, "source-type", envOr("DB_TYPE", dbTypeSQLite),
		"source database type: sqlite, mysql or postgres (defaults to $DB_TYPE)")
	flag.StringVar(&opts.sourceDSN, "source-dsn", envOr("DB_DSN", "dev.db"),
		"source DSN (defaults to $DB_DSN)")
	flag.StringVar(&opts.targetType, "target-type", "", "target database type: sqlite, mysql or postgres")
	flag.StringVar(&opts.targetDSN, "target-dsn", "", "target DSN")
	flag.IntVar(&opts.batchSize, "batch-size", 100, "rows per insert batch")
	flag.BoolVar(&opts.dryRun, "dry-run", false,
		"read the source and print the row-count comparison without creating tables or writing data")
	flag.Parse()
	return opts
}

func run(opts *options) error {
	if err := validate(opts); err != nil {
		return err
	}
	applyEncryptKey()

	klog.Infof("source %s (%s) -> target %s (%s)",
		opts.sourceType, maskDSN(opts.sourceType, opts.sourceDSN),
		opts.targetType, maskDSN(opts.targetType, opts.targetDSN))

	source, err := openDatabase(opts.sourceType, opts.sourceDSN)
	if err != nil {
		return fmt.Errorf("connecting to the source: %w", err)
	}
	tables, err := readSource(source)
	if err != nil {
		return err
	}

	if opts.dryRun {
		target, err := openDatabase(opts.targetType, opts.targetDSN)
		if err != nil {
			return fmt.Errorf("connecting to the target: %w", err)
		}
		return report(tables, target, true)
	}

	if err := createTargetSchema(opts.targetType, opts.targetDSN); err != nil {
		return err
	}
	target := model.DB

	if err := clearTarget(target, opts.targetType, tables); err != nil {
		return err
	}
	if err := writeTarget(target, tables, opts.batchSize); err != nil {
		return err
	}
	if opts.targetType == dbTypePostgres {
		if err := fixSequences(target, tables); err != nil {
			return err
		}
	}
	if err := report(tables, target, false); err != nil {
		return err
	}
	warnUncoveredTables(source, target)
	return nil
}

// validate 在连接任何数据库之前拒绝明显错误的调用。最要紧的一条是源库与目标库
// 不能是同一个库：搬运过程会先清空目标表，指错了就是把源数据删掉。
func validate(opts *options) error {
	for _, kind := range []string{opts.sourceType, opts.targetType} {
		switch kind {
		case dbTypeSQLite, dbTypeMySQL, dbTypePostgres:
		default:
			return fmt.Errorf("unsupported database type %q: use sqlite, mysql or postgres", kind)
		}
	}
	if opts.targetDSN == "" {
		return errors.New("-target-dsn is required")
	}
	if opts.batchSize <= 0 {
		return fmt.Errorf("-batch-size must be positive, got %d", opts.batchSize)
	}
	if sameDatabase(opts.sourceType, opts.sourceDSN, opts.targetType, opts.targetDSN) {
		return errors.New("the source and the target are the same database: this would delete the source data. " +
			"Use a different -target-dsn")
	}
	return nil
}

// sameDatabase 判断两个 DSN 是否指向同一个库。sqlite 按绝对路径比较（同一文件的不同
// 写法很容易被误当成两个库），其它方言直接比较 DSN 文本。
func sameDatabase(sourceType, sourceDSN, targetType, targetDSN string) bool {
	if sourceType != targetType {
		return false
	}
	if sourceType == dbTypeSQLite {
		return sqlitePath(sourceDSN) == sqlitePath(targetDSN)
	}
	return strings.TrimSpace(sourceDSN) == strings.TrimSpace(targetDSN)
}

func sqlitePath(dsn string) string {
	path := strings.TrimPrefix(dsn, "file:")
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

// applyEncryptKey 让搬运使用与源库一致的密钥处理 SecretString 列。
//
// 这里直接赋值而不走 common.InitConfig()：后者还会强校验 JWT_SECRET 等应用配置，
// 而搬数据只关心加密密钥。密钥不对时读取源库会立刻解密失败（fail-closed），
// 不会静默搬一堆解不开的密文过去。
func applyEncryptKey() {
	key := strings.TrimSpace(common.Getenv("ENCRYPT_KEY"))
	if key == "" {
		klog.Warningf("AEROLINK_ENCRYPT_KEY is not set: reading and writing secrets with the built-in " +
			"default key. This is correct only when the source also used that key.")
		return
	}
	common.EncryptKey = key
}

func openDatabase(dbType, dsn string) (*gorm.DB, error) {
	cfg := &gorm.Config{Logger: logger.Discard}
	switch dbType {
	case dbTypeSQLite:
		return gorm.Open(sqlite.Open(dsn), cfg)
	case dbTypeMySQL:
		return gorm.Open(mysql.Open(model.MySQLDSN(dsn)), cfg)
	case dbTypePostgres:
		return gorm.Open(postgres.Open(dsn), cfg)
	default:
		return nil, fmt.Errorf("unsupported database type %q", dbType)
	}
}

// createTargetSchema 用应用自己的建表逻辑准备目标库：AutoMigrate 全部模型，
// 再跑那两条结构修补（多余索引 / 历史列）。这样目标库的结构与「应用直接连上去」
// 完全一致，运维不需要额外跑一次启动。
func createTargetSchema(dbType, dsn string) (err error) {
	common.DBType = dbType
	common.DBDSN = dsn

	// model.InitDB 用 panic 报错（它是给应用启动用的），这里转成普通错误。
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("preparing the target schema: %v", r)
		}
	}()
	model.InitDB()
	return nil
}

// readSource 按模型把源库逐表读进内存。时间列的解析、SecretString 的解密都由
// 模型的 Scan 完成，因此密钥不对会在这里就失败。
func readSource(db *gorm.DB) ([]*table, error) {
	models := model.Models()
	tables := make([]*table, 0, len(models))
	for _, m := range models {
		name, pk, err := schemaOf(db, m)
		if err != nil {
			return nil, err
		}
		rows := reflect.New(reflect.SliceOf(reflect.TypeOf(m)))
		if err := db.Find(rows.Interface()).Error; err != nil {
			return nil, fmt.Errorf("reading source table %s: %w "+
				"(a decryption error here means AEROLINK_ENCRYPT_KEY does not match the source)", name, err)
		}
		tables = append(tables, &table{
			name:  name,
			pk:    pk,
			rows:  rows.Interface(),
			count: reflect.ValueOf(rows.Interface()).Elem().Len(),
		})
	}
	return tables, nil
}

// schemaOf 取模型对应的表名与主键列名，避免在工具里再抄一份表名清单。
func schemaOf(db *gorm.DB, m interface{}) (string, string, error) {
	stmt := &gorm.Statement{DB: db}
	if err := stmt.Parse(m); err != nil {
		return "", "", fmt.Errorf("resolving the table name of %T: %w", m, err)
	}
	pk := ""
	if field := stmt.Schema.PrioritizedPrimaryField; field != nil {
		pk = field.DBName
	}
	return stmt.Schema.Table, pk, nil
}

// clearTarget 清空目标表。表按依赖倒序（子表在前）删除，避免触发外键约束；
// 工具因此是幂等的，可以对着同一个目标库反复执行。
func clearTarget(db *gorm.DB, dbType string, tables []*table) error {
	for i := len(tables) - 1; i >= 0; i-- {
		statement := "DELETE FROM " + quoteIdent(dbType, tables[i].name)
		if err := db.Exec(statement).Error; err != nil {
			return fmt.Errorf("clearing target table %s: %w", tables[i].name, err)
		}
	}
	return nil
}

// writeTarget 按依赖顺序（父表在前）插入。SkipHooks 是必须的：ResourceHistory /
// LoginRecord 的 AfterCreate 会把记录外发到外部审计系统（pkg/model/audit_forward.go），
// 搬历史数据不该触发它们。
func writeTarget(db *gorm.DB, tables []*table, batchSize int) error {
	session := db.Session(&gorm.Session{SkipHooks: true})
	for _, tb := range tables {
		if tb.count == 0 {
			continue
		}
		if err := session.CreateInBatches(tb.rows, batchSize).Error; err != nil {
			return fmt.Errorf("writing target table %s: %w", tb.name, err)
		}
	}
	return nil
}

// fixSequences 把 PostgreSQL 的自增序列推到已插入的最大主键：GORM 建的是 bigserial，
// 显式插入 id 不会推进序列，不修的话新建对象会主键冲突。MySQL 的 AUTO_INCREMENT 与
// SQLite 的 rowid 会自己取 max+1，不需要处理。
func fixSequences(db *gorm.DB, tables []*table) error {
	for _, tb := range tables {
		if tb.pk == "" || tb.count == 0 {
			continue
		}
		var sequence sql.NullString
		if err := db.Raw("SELECT pg_get_serial_sequence(?, ?)", tb.name, tb.pk).Scan(&sequence).Error; err != nil {
			return fmt.Errorf("looking up the sequence of %s: %w", tb.name, err)
		}
		if !sequence.Valid || strings.TrimSpace(sequence.String) == "" {
			// 该列不是自增列（或不在默认 schema 里）：要么本来就由调用方给 id，
			// 要么序列名解析失败，都得让人知道。
			klog.Warningf("table %s has primary key %s but no serial sequence; "+
				"inserts without an explicit id may conflict", tb.name, tb.pk)
			continue
		}
		pk := quoteIdent(dbTypePostgres, tb.pk)
		statement := fmt.Sprintf(
			"SELECT setval(%s, GREATEST(COALESCE(MAX(%s), 0), 1), COALESCE(MAX(%s), 0) > 0) FROM %s",
			quoteLiteral(sequence.String), pk, pk, quoteIdent(dbTypePostgres, tb.name))
		if err := db.Exec(statement).Error; err != nil {
			return fmt.Errorf("resetting the sequence of %s: %w", tb.name, err)
		}
	}
	return nil
}

// report 打印源/目标行数对照。行数不一致时返回错误：迁移不是「跑完就算成功」，
// 必须逐表核对。
func report(tables []*table, target *gorm.DB, dryRun bool) error {
	fmt.Printf("\n%-30s %10s %10s\n", "table", "source", "target")
	mismatched := make([]string, 0)
	for _, tb := range tables {
		rows, err := countRows(target, tb.name)
		if err != nil {
			return err
		}
		shown := "absent"
		note := ""
		if rows >= 0 {
			shown = strconv.FormatInt(rows, 10)
			if int(rows) != tb.count {
				note = "  <-- MISMATCH"
				mismatched = append(mismatched, tb.name)
			}
		}
		fmt.Printf("%-30s %10d %10s%s\n", tb.name, tb.count, shown, note)
	}
	if dryRun {
		fmt.Println("\ndry-run: the target was not modified.")
		return nil
	}
	if len(mismatched) > 0 {
		return fmt.Errorf("row counts differ from the source for: %s", strings.Join(mismatched, ", "))
	}
	fmt.Println("\nall tables match the source.")
	return nil
}

// countRows 返回目标表的行数，表还不存在时返回 -1（dry-run 下目标库可能还是空的）。
func countRows(db *gorm.DB, name string) (int64, error) {
	if !db.Migrator().HasTable(name) {
		return -1, nil
	}
	var count int64
	if err := db.Table(name).Count(&count).Error; err != nil {
		return 0, fmt.Errorf("counting target table %s: %w", name, err)
	}
	return count, nil
}

// warnUncoveredTables 报告源库里存在、但模型列表里没有的表（例如历史残留的
// passkey_credentials，模型里已无对应类型）。不搬它们，但要让人看得见。
func warnUncoveredTables(source, target *gorm.DB) {
	covered := make(map[string]bool)
	for _, m := range model.Models() {
		if name, _, err := schemaOf(source, m); err == nil {
			covered[name] = true
		}
	}
	for _, name := range listTables(source) {
		if strings.HasPrefix(name, "sqlite_") || covered[name] {
			continue
		}
		if target.Migrator().HasTable(name) {
			continue
		}
		klog.Warningf("source table %s has no matching model and was not migrated", name)
	}
}

// listTables 取库里的全部表名，供 warnUncoveredTables 对照。
func listTables(db *gorm.DB) []string {
	lister, ok := db.Migrator().(interface{ GetTables() ([]string, error) })
	if !ok {
		return nil
	}
	names, err := lister.GetTables()
	if err != nil {
		klog.Warningf("failed to list tables: %v", err)
		return nil
	}
	return names
}

// quoteIdent 为表名/列名加引号。列名与表名都来自代码里的模型定义（不含用户输入），
// 这里只是为了让 sqlite/postgres 与 mysql 的引号风格各自正确。
func quoteIdent(dbType, name string) string {
	if dbType == dbTypeMySQL {
		return "`" + name + "`"
	}
	return `"` + name + `"`
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// maskDSN 打日志时抹掉 DSN 里的口令：终端记录、issue 截图都会留痕。
func maskDSN(dbType, dsn string) string {
	switch dbType {
	case dbTypePostgres:
		parts := strings.Fields(dsn)
		for i, part := range parts {
			if key, _, ok := strings.Cut(part, "="); ok && strings.HasSuffix(key, "password") {
				parts[i] = key + "=***"
			}
		}
		return strings.Join(parts, " ")
	case dbTypeMySQL:
		at := strings.LastIndex(dsn, "@")
		if at < 0 {
			return dsn
		}
		if colon := strings.Index(dsn[:at], ":"); colon >= 0 {
			return dsn[:colon+1] + "***" + dsn[at:]
		}
		return dsn
	default:
		return dsn
	}
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
