package model

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 加列前的存量公告必须继续滚动：Scroll 的零值是 false，而历史行为一直是横向滚动，
// 全靠这次回填保住——漏了它，升级后所有老公告会突然停住不动。
//
// 两个方向都要钉住：列**刚加出来**时回填；列**已存在**时不动，否则每次启动都会把
// 管理员显式设的「不滚动」改回滚动。
func TestMigrateAnnouncementScrollBackfill(t *testing.T) {
	originalDB := DB
	// 共享缓存的命名内存库：与同目录其他迁移测试同一套写法。
	db, err := gorm.Open(sqlite.Open("file:announcement-scroll-backfill?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })

	if err := DB.AutoMigrate(&Announcement{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	legacy := Announcement{Title: "老公告", Content: "x", Enabled: true}
	if err := DB.Create(&legacy).Error; err != nil {
		t.Fatalf("creating legacy announcement: %v", err)
	}
	// 删掉这一列，回到「升级前」的形态：AutoMigrate 会把新列给存量行填成零值 false。
	if err := DB.Migrator().DropColumn(&Announcement{}, "Scroll"); err != nil {
		t.Fatalf("dropping column: %v", err)
	}

	if err := MigrateAnnouncementScrollBackfill(); err != nil {
		t.Fatalf("backfilling: %v", err)
	}
	var stored Announcement
	if err := DB.First(&stored, legacy.ID).Error; err != nil {
		t.Fatalf("reloading announcement: %v", err)
	}
	if !stored.Scroll {
		t.Fatalf("scroll = false, want true（存量公告升级后应当继续滚动）")
	}

	// 再跑一次：列已存在，不能覆盖管理员显式设下的「不滚动」。
	if err := DB.Model(&Announcement{}).Where("id = ?", legacy.ID).
		Update("scroll", false).Error; err != nil {
		t.Fatalf("disabling scroll: %v", err)
	}
	if err := MigrateAnnouncementScrollBackfill(); err != nil {
		t.Fatalf("backfilling again: %v", err)
	}
	if err := DB.First(&stored, legacy.ID).Error; err != nil {
		t.Fatalf("reloading announcement: %v", err)
	}
	if stored.Scroll {
		t.Fatalf("scroll = true, want false（列已存在时不该回填）")
	}
}
