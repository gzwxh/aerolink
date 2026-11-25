package model

import (
	"fmt"

	"aerolink/pkg/common"
)

// MigrateClusterSlugBackfill 给既有集群回填 URL 短名（/_clusters/<slug>/... 前缀用的
// 稳定标识，见 model.Cluster.Slug）。幂等：已有非空 slug 的行跳过。
// 逐行生成 + 全局去重，注意不要在循环里对同一 name 生成同一个 slug。
func MigrateClusterSlugBackfill() error {
	clusters, err := ListClusters()
	if err != nil {
		return err
	}
	taken := make(map[string]bool, len(clusters))
	for _, c := range clusters {
		if c.Slug != nil && *c.Slug != "" {
			taken[*c.Slug] = true
		}
	}
	for _, c := range clusters {
		if c.Slug != nil && *c.Slug != "" {
			continue
		}
		base := common.SlugifyClusterName(c.Name)
		slug := base
		for n := 2; taken[slug]; n++ {
			slug = fmt.Sprintf("%s-%d", base, n)
		}
		taken[slug] = true
		// 用 map 更新而不是整行 Save：slug 是 *string，走 map 也避免碰其他列。
		if err := DB.Model(&Cluster{}).Where("id = ?", c.ID).Update("slug", slug).Error; err != nil {
			return err
		}
	}
	return nil
}
