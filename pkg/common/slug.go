package common

import (
	"regexp"
	"strings"
)

// maxSlugBaseLen 给冲突后缀（-2、-3…）留出空间：slug 列宽 64，基名截到 48。
const maxSlugBaseLen = 48

var slugifySeparators = regexp.MustCompile(`[^a-z0-9]+`)

// SlugifyClusterName 把集群名压成 URL 安全短名的基名（不含冲突后缀）：
// 转小写、连续非 [a-z0-9] 折成一个 -、去首尾 -、截断到 48 字符；
// 结果为空（纯中文/纯符号名，如「生产环境」）退化为 cluster。
//
// 纯函数，供 pkg/cluster 的创建/导入链路与 pkg/model 的 slug 回填迁移共用
// （后者不能 import pkg/cluster，会循环依赖）。不做拼音/转写：中文集群名想可读
// 就由管理员手填短名。方案见 docs/dev/plans/2026-10-15-集群信息进入浏览器地址栏.md §3.2。
func SlugifyClusterName(name string) string {
	base := slugifySeparators.ReplaceAllString(strings.ToLower(name), "-")
	base = strings.Trim(base, "-")
	if len(base) > maxSlugBaseLen {
		base = strings.TrimRight(base[:maxSlugBaseLen], "-")
	}
	if base == "" {
		base = "cluster"
	}
	return base
}
