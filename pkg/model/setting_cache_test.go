package model

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// countQueries 统计接下来发生的查询次数，用来验证「读缓存真的省掉了数据库往返」。
// 返回一个停止函数。
func countQueries(t *testing.T) func() int64 {
	t.Helper()

	var counter int64
	callbackName := "test:count-queries"
	if err := DB.Callback().Query().Before("gorm:query").Register(callbackName, func(*gorm.DB) {
		atomic.AddInt64(&counter, 1)
	}); err != nil {
		t.Fatalf("registering the query counter: %v", err)
	}
	return func() int64 {
		if err := DB.Callback().Query().Remove(callbackName); err != nil {
			t.Fatalf("removing the query counter: %v", err)
		}
		return atomic.LoadInt64(&counter)
	}
}

func setupSettingCacheTestDB(t *testing.T) {
	t.Helper()

	originalDB := DB
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&SecuritySetting{}, &GeneralSetting{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() {
		DB = originalDB
		InvalidateSecuritySettingCache()
		InvalidateGeneralSettingCache()
		if sqlDB, dbErr := db.DB(); dbErr == nil {
			_ = sqlDB.Close()
		}
	})
	// 换库后必须回到干净状态，否则上一套库的值会被当成这一套库的。
	InvalidateSecuritySettingCache()
	InvalidateGeneralSettingCache()
}

// 鉴权路径每个请求都要读安全策略：缓存命中时不能再打数据库。
func TestSecuritySettingCacheAvoidsRepeatedReads(t *testing.T) {
	setupSettingCacheTestDB(t)

	first, err := GetSecuritySetting()
	if err != nil {
		t.Fatalf("GetSecuritySetting() error = %v", err)
	}

	stop := countQueries(t)
	for i := 0; i < 50; i++ {
		got, err := GetSecuritySetting()
		if err != nil {
			t.Fatalf("GetSecuritySetting() error = %v", err)
		}
		if got == first {
			t.Fatal("the cached value must be returned as a copy")
		}
	}
	if queries := stop(); queries != 0 {
		t.Fatalf("50 cached reads caused %d database queries, want 0", queries)
	}

	// 返回的必须是副本：调用方（设置保存流程）会直接改它。
	first.MFAPolicy = MFAPolicyAll
	again, err := GetSecuritySetting()
	if err != nil {
		t.Fatalf("GetSecuritySetting() error = %v", err)
	}
	if again.MFAPolicy == MFAPolicyAll {
		t.Fatal("mutating the returned value changed the cache")
	}
}

func TestGeneralSettingCacheAvoidsRepeatedReads(t *testing.T) {
	setupSettingCacheTestDB(t)

	if _, err := GetGeneralSetting(); err != nil {
		t.Fatalf("GetGeneralSetting() error = %v", err)
	}

	stop := countQueries(t)
	for i := 0; i < 50; i++ {
		if _, err := GetGeneralSetting(); err != nil {
			t.Fatalf("GetGeneralSetting() error = %v", err)
		}
	}
	if queries := stop(); queries != 0 {
		t.Fatalf("50 cached reads caused %d database queries, want 0", queries)
	}
}

// 保存之后必须马上生效，不能等缓存过期。
func TestSettingWritesInvalidateTheCache(t *testing.T) {
	setupSettingCacheTestDB(t)

	// 先读一次把缓存填上。
	if _, err := GetSecuritySetting(); err != nil {
		t.Fatalf("GetSecuritySetting() error = %v", err)
	}
	data := DefaultSecuritySettingData()
	data.MFAPolicy = MFAPolicyAll
	if _, err := UpdateSecuritySetting(data); err != nil {
		t.Fatalf("UpdateSecuritySetting() error = %v", err)
	}
	got, err := GetSecuritySetting()
	if err != nil {
		t.Fatalf("GetSecuritySetting() error = %v", err)
	}
	if got.MFAPolicy != MFAPolicyAll {
		t.Fatalf("MFAPolicy = %q right after saving, want the new value", got.MFAPolicy)
	}

	if _, err := GetGeneralSetting(); err != nil {
		t.Fatalf("GetGeneralSetting() error = %v", err)
	}
	if _, err := UpdateGeneralSetting(map[string]interface{}{"enable_mfa": false}); err != nil {
		t.Fatalf("UpdateGeneralSetting() error = %v", err)
	}
	general, err := GetGeneralSetting()
	if err != nil {
		t.Fatalf("GetGeneralSetting() error = %v", err)
	}
	if general.EnableMFA {
		t.Fatal("EnableMFA = true right after saving, want the new value")
	}
}

// 写路径必须读库里的最新值：否则「读出来改完整份写回」会把别人刚保存的改动覆盖掉。
func TestLoadSecuritySettingBypassesTheCache(t *testing.T) {
	setupSettingCacheTestDB(t)

	if _, err := GetSecuritySetting(); err != nil {
		t.Fatalf("GetSecuritySetting() error = %v", err)
	}

	// 绕过更新函数直接改库，模拟「另一个管理员刚保存」。
	data := DefaultSecuritySettingData()
	data.MFAPolicy = MFAPolicyAdmin
	if _, err := UpdateSecuritySetting(data); err != nil {
		t.Fatalf("UpdateSecuritySetting() error = %v", err)
	}
	// 再手工写一个不同的值并把缓存填回旧值。
	if err := DB.Model(&SecuritySetting{}).Where("id = ?", 1).Update("data", `{"mfaPolicy":"all"}`).Error; err != nil {
		t.Fatalf("updating the stored row: %v", err)
	}
	if _, err := GetSecuritySetting(); err != nil {
		t.Fatalf("GetSecuritySetting() error = %v", err)
	}

	fresh, err := LoadSecuritySetting()
	if err != nil {
		t.Fatalf("LoadSecuritySetting() error = %v", err)
	}
	if fresh.MFAPolicy != MFAPolicyAll {
		t.Fatalf("LoadSecuritySetting().MFAPolicy = %q, want the value stored in the database", fresh.MFAPolicy)
	}
}

// 缓存过期后要回源（这里只验证「不会永久缓存」，用短时间窗避免测试变慢）。
func TestSettingCacheExpires(t *testing.T) {
	setupSettingCacheTestDB(t)

	if _, err := GetSecuritySetting(); err != nil {
		t.Fatalf("GetSecuritySetting() error = %v", err)
	}

	securitySettingMu.Lock()
	securitySettingAt = time.Now().Add(-securitySettingCacheTTL - time.Second)
	securitySettingMu.Unlock()

	stop := countQueries(t)
	if _, err := GetSecuritySetting(); err != nil {
		t.Fatalf("GetSecuritySetting() error = %v", err)
	}
	if queries := stop(); queries == 0 {
		t.Fatal("an expired cache entry did not trigger a database read")
	}
}
