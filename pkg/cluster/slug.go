package cluster

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
)

// slugPattern 手填短名的合法形态。自动生成路径必然满足（见 common.SlugifyClusterName），
// 这里只拦人的输入。
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

// ValidateSlugFormat 校验手填短名。非法一律报错，不静默改写——值是人指定的，
// 静默加后缀会让人以为生效的是别的值。
func ValidateSlugFormat(slug string) error {
	if !slugPattern.MatchString(slug) {
		return errors.New("slug must be 1-48 characters of [a-z0-9] or '-', starting with a letter or digit")
	}
	return nil
}

// GenerateUniqueSlug 基于集群名生成不与 taken 冲突的短名，冲突时追加 -<n>（n 从 2 递增）。
// 只有自动生成路径做去重；手填值冲突直接报错（见 ValidateSlugFormat / ValidateImportSlugs）。
func GenerateUniqueSlug(name string, taken map[string]bool) string {
	base := common.SlugifyClusterName(name)
	slug := base
	for n := 2; taken[slug]; n++ {
		slug = fmt.Sprintf("%s-%d", base, n)
	}
	return slug
}

// ValidateImportSlugs 校验导入请求逐行指定的短名（key = context name），全部通过才允许写库
// （fail-closed、全有或全无）：
//   - 逐个满足 slugPattern；
//   - 批内互不重复；
//   - 不与库里其他集群的现有 slug 冲突（同名集群自己的 slug 不算——已存在的集群不动 slug）。
func ValidateImportSlugs(slugs map[string]string, existing []*model.Cluster) error {
	seen := make(map[string]string, len(slugs))
	for ctxName, slug := range slugs {
		if slug == "" {
			continue
		}
		if err := ValidateSlugFormat(slug); err != nil {
			return fmt.Errorf("context %q: %w", ctxName, err)
		}
		if prev, ok := seen[slug]; ok {
			return fmt.Errorf("contexts %q and %q use the same slug %q", prev, ctxName, slug)
		}
		seen[slug] = ctxName
	}
	for _, c := range existing {
		if c.Slug == nil || *c.Slug == "" {
			continue
		}
		if ctxName, ok := seen[*c.Slug]; ok && ctxName != c.Name {
			return fmt.Errorf("slug %q (context %q) is already taken by cluster %q", *c.Slug, ctxName, c.Name)
		}
	}
	return nil
}
