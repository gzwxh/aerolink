package model

import (
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupBrandMigrationTestDB(t *testing.T) {
	t.Helper()
	originalDB := DB
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&NotificationTemplate{}, &SecuritySetting{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })
}

// 回归（缺陷 D-54）：改名前的库至今还在用 `[Kite] …` 发通知，
// 因为预置逻辑只补种缺失事件、从不回改已有行。
func TestMigrateLegacyBrandNamesRewritesLegacyTemplates(t *testing.T) {
	setupBrandMigrationTestDB(t)

	legacy := NotificationTemplate{
		Event:   NotificationEventRemoteLogin,
		Subject: "[Kite] 异地登录提醒",
		Body:    "您的账号刚刚登录 Kite，请立即修改密码。",
		Enabled: true,
	}
	if err := DB.Create(&legacy).Error; err != nil {
		t.Fatalf("seeding legacy template: %v", err)
	}

	if err := MigrateLegacyBrandNames(); err != nil {
		t.Fatalf("MigrateLegacyBrandNames() error = %v", err)
	}

	var got NotificationTemplate
	if err := DB.First(&got, legacy.ID).Error; err != nil {
		t.Fatalf("reload template: %v", err)
	}
	if got.Subject != "[鸢联] 异地登录提醒" {
		t.Errorf("subject = %q, want %q", got.Subject, "[鸢联] 异地登录提醒")
	}
	if !strings.Contains(got.Body, "登录 鸢联，") || strings.Contains(got.Body, "Kite") {
		t.Errorf("body still carries the legacy brand or lost its wording: %q", got.Body)
	}

	// 幂等：再跑一次不应产生任何变化。
	before := got
	if err := MigrateLegacyBrandNames(); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if err := DB.First(&got, legacy.ID).Error; err != nil {
		t.Fatalf("reload after second run: %v", err)
	}
	if got.Subject != before.Subject || got.Body != before.Body {
		t.Errorf("migration is not idempotent: %#v -> %#v", before, got)
	}
}

// 用户在界面上改过的模板：品牌词之外的措辞必须原样保留，
// 更长的标识符（KitePaaS）不能被顺手改掉。
func TestMigrateLegacyBrandNamesKeepsUserWordingAndLongerIdentifiers(t *testing.T) {
	setupBrandMigrationTestDB(t)

	custom := NotificationTemplate{
		Event:   NotificationEventRoleAssigned,
		Subject: "内部通知：KitePaaS 权限变更",
		Body:    "本条由运维自定义，提到 KitePaaS 与 Kite,Kite 两种写法。",
		Enabled: true,
	}
	if err := DB.Create(&custom).Error; err != nil {
		t.Fatalf("seeding custom template: %v", err)
	}

	if err := MigrateLegacyBrandNames(); err != nil {
		t.Fatalf("MigrateLegacyBrandNames() error = %v", err)
	}

	var got NotificationTemplate
	if err := DB.First(&got, custom.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if strings.Contains(got.Subject, "鸢联PaaS") || !strings.Contains(got.Subject, "KitePaaS") {
		t.Errorf("KitePaaS 这类更长的标识符被误改: %q", got.Subject)
	}
	// 正文里两个独立的 Kite 共用一个逗号，也要都被替换掉。
	if strings.Count(got.Body, "鸢联") != 2 || strings.Contains(got.Body, "Kite,") {
		t.Errorf("相邻两个独立品牌词没有都被替换: %q", got.Body)
	}
	if !strings.Contains(got.Body, "运维自定义") {
		t.Errorf("用户措辞丢失: %q", got.Body)
	}
}

// TOTP 签发者只在仍是旧默认值 "Kite" 时才动，自定义值必须保留。
func TestMigrateLegacyBrandNamesOTPIssuer(t *testing.T) {
	setupBrandMigrationTestDB(t)

	legacy := DefaultSecuritySettingData()
	legacy.OTPIssuerName = "Kite"
	if _, err := UpdateSecuritySetting(legacy); err != nil {
		t.Fatalf("seeding security setting: %v", err)
	}
	if err := MigrateLegacyBrandNames(); err != nil {
		t.Fatalf("MigrateLegacyBrandNames() error = %v", err)
	}
	got, err := GetSecuritySetting()
	if err != nil {
		t.Fatalf("reload setting: %v", err)
	}
	if got.OTPIssuerName != DefaultSecuritySettingData().OTPIssuerName {
		t.Errorf("otpIssuer = %q, want the code default %q", got.OTPIssuerName, DefaultSecuritySettingData().OTPIssuerName)
	}

	custom := *got
	custom.OTPIssuerName = "ACME 控制台"
	if _, err := UpdateSecuritySetting(custom); err != nil {
		t.Fatalf("seeding custom issuer: %v", err)
	}
	if err := MigrateLegacyBrandNames(); err != nil {
		t.Fatalf("second migration: %v", err)
	}
	again, err := GetSecuritySetting()
	if err != nil {
		t.Fatalf("reload setting: %v", err)
	}
	if again.OTPIssuerName != "ACME 控制台" {
		t.Errorf("管理员自定义的签发者被覆盖: %q", again.OTPIssuerName)
	}
}
