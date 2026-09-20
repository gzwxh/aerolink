package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// pg13PlusTokens 是「只有更高版本 PostgreSQL 才有」的写法。
//
// 现网跑 PostgreSQL 12，而 CI 只跑 SQLite（见 .github/workflows/ci.yml）：一旦有人把这类
// 写法带进模型或手写查询，本地与 CI 都不会报错，直到部署到 12 上建表/查询才失败。所以这里
// 把下限钉死：扫描仓库里的 Go 源码**字符串字面量**（GORM 的 tag 与手写 SQL 都在字符串里，
// 注释与文档不算），命中即失败。
//
// 新写法要放行时，请连同「为什么它在 PG 12 上也能用」一起写进注释，而不是直接删条目。
var pg13PlusTokens = []struct {
	token string
	why   string
}{
	{"gen_random_uuid", "PG 13 起才内置；12 上要先装 pgcrypto 扩展"},
	{"xid8", "PG 13 新增的类型"},
	{"multirange", "PG 14 新增（含 int4multirange / datemultirange 等）"},
	{"date_bin", "PG 14 新增的函数"},
	{"search breadth first", "PG 14 新增（递归 CTE 的 SEARCH 子句）"},
	{"nulls not distinct", "PG 15 新增"},
	{"merge into", "PG 15 新增的 MERGE 语句"},
	{"any_value", "PG 16 新增"},
	{"json_table", "PG 17 新增"},
	{"create extension", "扩展 PG 12 支持，但会给部署增加依赖；现网不使用扩展"},
}

func TestNoSQLNewerThanPostgres12(t *testing.T) {
	skipDirs := map[string]bool{
		"vendor":       true, // 依赖里本来就有高版本方言的实现
		"node_modules": true,
		".git":         true,
		"static":       true,
		"bin":          true,
	}

	fset := token.NewFileSet()
	var hits []string
	// go test 的工作目录就是包目录，根包即仓库根。
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if skipDirs[entry.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		name := entry.Name()
		// 本文件自身要写出这些关键字，所以跳过测试文件。
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return nil
		}
		ast.Inspect(file, func(node ast.Node) bool {
			lit, ok := node.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			value, unquoteErr := strconv.Unquote(lit.Value)
			if unquoteErr != nil {
				return true
			}
			lower := strings.ToLower(value)
			for _, token := range pg13PlusTokens {
				if strings.Contains(lower, token.token) {
					hits = append(hits, fmt.Sprintf(
						"%s:%d 出现 %q（%s）",
						path, fset.Position(lit.Pos()).Line, token.token, token.why,
					))
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("遍历源码失败: %v", err)
	}
	if len(hits) > 0 {
		t.Fatalf("这些写法在 PostgreSQL 12 上不可用（现网下限就是 12）：\n  %s",
			strings.Join(hits, "\n  "))
	}
}
