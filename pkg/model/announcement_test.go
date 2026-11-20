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

// 旧版本允许多条公告同时启用：升级后只保留顶栏本来就会展示的那条（优先级最高、
// 同优先级取后建的），其余改成停用。只动 enabled，不删除任何公告。
func TestMigrateAnnouncementSingleEnabled(t *testing.T) {
	originalDB := DB
	db, err := gorm.Open(sqlite.Open("file:announcement-single-enabled?mode=memory&cache=shared"), &gorm.Config{
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
	low := Announcement{Title: "低", Content: "x", Enabled: true}
	highA := Announcement{Title: "高A", Content: "x", Enabled: true, Priority: 10}
	highB := Announcement{Title: "高B", Content: "x", Enabled: true, Priority: 10}
	disabled := Announcement{Title: "停用的", Content: "x", Enabled: false}
	for _, item := range []*Announcement{&low, &highA, &highB, &disabled} {
		if err := DB.Create(item).Error; err != nil {
			t.Fatalf("seeding announcement: %v", err)
		}
	}

	if err := MigrateAnnouncementSingleEnabled(); err != nil {
		t.Fatalf("normalizing: %v", err)
	}

	var enabled []Announcement
	if err := DB.Where("enabled = ?", true).Find(&enabled).Error; err != nil {
		t.Fatalf("listing enabled announcements: %v", err)
	}
	if len(enabled) != 1 || enabled[0].ID != highB.ID {
		t.Fatalf("enabled = %+v, want only the highest-priority, newest one", enabled)
	}

	// 再跑一次是幂等的；也不该动本来就停用的那条。
	if err := MigrateAnnouncementSingleEnabled(); err != nil {
		t.Fatalf("normalizing again: %v", err)
	}
	var stillDisabled Announcement
	if err := DB.First(&stillDisabled, disabled.ID).Error; err != nil {
		t.Fatalf("reloading the disabled announcement: %v", err)
	}
	if stillDisabled.Enabled {
		t.Fatalf("disabled announcement became enabled")
	}
	var stillLow Announcement
	if err := DB.First(&stillLow, low.ID).Error; err != nil {
		t.Fatalf("reloading the low-priority announcement: %v", err)
	}
	if stillLow.Enabled {
		t.Fatalf("low-priority announcement is still enabled")
	}
}

// SQLite 不支持 FOR UPDATE：锁定读必须按方言跳过子句（整库写锁已保证串行），
// 且保持只读行为——不出错、不改动任何行。漏掉方言守卫的话，SQLite 上会直接报
// 语法错误，启动归一化与启用路径全部失败。
func TestLockEnabledAnnouncementsOnSQLite(t *testing.T) {
	originalDB := DB
	db, err := gorm.Open(sqlite.Open("file:announcement-lock-sqlite?mode=memory&cache=shared"), &gorm.Config{
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
	first := Announcement{Title: "第一条", Content: "x", Enabled: true}
	second := Announcement{Title: "第二条", Content: "x", Enabled: true, Priority: 5}
	for _, item := range []*Announcement{&first, &second} {
		if err := DB.Create(item).Error; err != nil {
			t.Fatalf("seeding announcement: %v", err)
		}
	}

	if err := LockEnabledAnnouncements(DB); err != nil {
		t.Fatalf("locking enabled announcements: %v", err)
	}

	var enabled []Announcement
	if err := DB.Where("enabled = ?", true).Order("priority DESC, id DESC").Find(&enabled).Error; err != nil {
		t.Fatalf("listing enabled announcements: %v", err)
	}
	if len(enabled) != 2 || enabled[0].ID != second.ID {
		t.Fatalf("enabled = %+v, want both rows untouched in priority-then-id order", enabled)
	}
}
