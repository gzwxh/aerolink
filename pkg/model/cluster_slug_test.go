package model

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 回填迁移：旧数据（slug 为 NULL）多行都能拿到唯一 slug，且幂等。
func TestMigrateClusterSlugBackfill(t *testing.T) {
	originalDB := DB
	db, err := gorm.Open(sqlite.Open("file:cluster-slug-backfill?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&Cluster{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })

	rows := []*Cluster{
		{Name: "prod-cluster"},
		{Name: "生产环境"},
		{Name: "开发环境"},
		{Name: "prod-cluster-2", Slug: strPtr("preset")}, // 已有 slug 的行跳过
	}
	for _, c := range rows {
		if err := AddCluster(c); err != nil {
			t.Fatalf("seeding cluster %q: %v", c.Name, err)
		}
	}

	if err := MigrateClusterSlugBackfill(); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	seen := map[string]string{}
	for _, name := range []string{"prod-cluster", "生产环境", "开发环境", "prod-cluster-2"} {
		c, err := GetClusterByName(name)
		if err != nil {
			t.Fatalf("loading %q: %v", name, err)
		}
		if c.Slug == nil || *c.Slug == "" {
			t.Fatalf("cluster %q has no slug after backfill", name)
		}
		if other, dup := seen[*c.Slug]; dup {
			t.Fatalf("slug %q assigned to both %q and %q", *c.Slug, other, name)
		}
		seen[*c.Slug] = name
	}
	if got := seenSlugFor(t, "生产环境"); got != "cluster" {
		t.Fatalf("slug for 生产环境 = %q, want cluster", got)
	}
	if got := seenSlugFor(t, "开发环境"); got != "cluster-2" {
		t.Fatalf("slug for 开发环境 = %q, want cluster-2", got)
	}
	if got := seenSlugFor(t, "prod-cluster-2"); got != "preset" {
		t.Fatalf("preset slug overwritten: %q, want preset", got)
	}

	// 幂等：重复执行不改变结果
	if err := MigrateClusterSlugBackfill(); err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	if got := seenSlugFor(t, "生产环境"); got != "cluster" {
		t.Fatalf("slug after idempotent rerun = %q, want cluster", got)
	}
}

func seenSlugFor(t *testing.T, name string) string {
	t.Helper()
	c, err := GetClusterByName(name)
	if err != nil {
		t.Fatalf("loading %q: %v", name, err)
	}
	if c.Slug == nil {
		return ""
	}
	return *c.Slug
}

func strPtr(s string) *string { return &s }
