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

// 三个滚动参数是加列上来的（速度/停留/显示时长），存量公告必须落到「升级前写死的常量」上
// ——60px/s、停留 2 秒、时长自动——否则一次升级就会把所有老公告改成 0 秒一轮。
//
// 用「先建表、写一条、再删列、再 AutoMigrate」复现升级前的库形态，确认 GORM 的
// default 标签在补列时真的给存量行填了默认值，而不是留下 0。
func TestAutoMigrateAnnouncementScrollParamsDefaults(t *testing.T) {
	originalDB := DB
	// 共享缓存的命名内存库：与同目录其他迁移测试同一套写法。
	db, err := gorm.Open(sqlite.Open("file:announcement-scroll-params?mode=memory&cache=shared"), &gorm.Config{
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
	// 回到「升级前」的形态：这三列还不存在。
	for _, column := range []string{"ScrollSpeed", "PauseSeconds", "DisplaySeconds"} {
		if err := DB.Migrator().DropColumn(&Announcement{}, column); err != nil {
			t.Fatalf("dropping column %s: %v", column, err)
		}
	}

	if err := DB.AutoMigrate(&Announcement{}); err != nil {
		t.Fatalf("re-migrating test database: %v", err)
	}

	var reloaded Announcement
	if err := DB.First(&reloaded, legacy.ID).Error; err != nil {
		t.Fatalf("reloading announcement: %v", err)
	}
	if reloaded.ScrollSpeed != AnnouncementDefaultScrollSpeed {
		t.Fatalf("scrollSpeed = %d, want %d（升级后老公告的观感不能变）",
			reloaded.ScrollSpeed, AnnouncementDefaultScrollSpeed)
	}
	if reloaded.PauseSeconds != AnnouncementDefaultPauseSeconds {
		t.Fatalf("pauseSeconds = %d, want %d", reloaded.PauseSeconds, AnnouncementDefaultPauseSeconds)
	}
	if reloaded.DisplaySeconds != 0 {
		t.Fatalf("displaySeconds = %d, want 0（自动）", reloaded.DisplaySeconds)
	}
}
