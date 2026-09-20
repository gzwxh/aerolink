package model

import (
	"bytes"
	"fmt"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var userAvatarTestDBCounter int

func newUserAvatarTestDB(t *testing.T) {
	t.Helper()
	userAvatarTestDBCounter++
	originalDB := DB
	dsn := fmt.Sprintf("file:user-avatar-%d?mode=memory&cache=shared", userAvatarTestDBCounter)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&UserAvatar{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })
	if sqlDB, dbErr := db.DB(); dbErr == nil {
		sqlDB.SetMaxOpenConns(1)
	}
}

// 首次上传是插入，再次上传是替换：两条路径都走同一条 upsert，
// 且内容哈希随内容变化（URL 因此变化，浏览器缓存不会拿到旧图）。
func TestSaveUserAvatarInsertsThenReplaces(t *testing.T) {
	newUserAvatarTestDB(t)

	first := []byte("first-image-bytes")
	hash, err := SaveUserAvatar(11, "image/png", first)
	if err != nil {
		t.Fatalf("SaveUserAvatar() error = %v", err)
	}
	if hash == "" {
		t.Fatal("content hash is empty")
	}

	stored, err := GetUserAvatar(11)
	if err != nil {
		t.Fatalf("GetUserAvatar() error = %v", err)
	}
	if !bytes.Equal(stored.Data, first) || stored.Size != int64(len(first)) {
		t.Errorf("stored bytes/size = %d/%d, want %d/%d", len(stored.Data), stored.Size, len(first), len(first))
	}
	if stored.ContentHash != hash {
		t.Errorf("content hash = %q, want %q", stored.ContentHash, hash)
	}
	if stored.ContentType != "image/png" {
		t.Errorf("content type = %q, want image/png", stored.ContentType)
	}

	second := []byte("second-image-bytes-longer")
	replacedHash, err := SaveUserAvatar(11, "image/jpeg", second)
	if err != nil {
		t.Fatalf("second SaveUserAvatar() error = %v", err)
	}
	if replacedHash == hash {
		t.Error("content hash did not change after replacing the bytes")
	}

	replaced, err := GetUserAvatar(11)
	if err != nil {
		t.Fatalf("GetUserAvatar() after replace error = %v", err)
	}
	if !bytes.Equal(replaced.Data, second) || replaced.ContentType != "image/jpeg" {
		t.Error("replace did not overwrite the stored row")
	}
	// 一个用户只能有一行：upsert 不能变成插入第二行。
	var count int64
	if err := DB.Model(&UserAvatar{}).Where("user_id = ?", 11).Count(&count).Error; err != nil {
		t.Fatalf("counting rows: %v", err)
	}
	if count != 1 {
		t.Errorf("rows for the user = %d, want 1", count)
	}
}

func TestDeleteUserAvatarIsIdempotent(t *testing.T) {
	newUserAvatarTestDB(t)

	if _, err := SaveUserAvatar(12, "image/png", []byte("bytes")); err != nil {
		t.Fatalf("SaveUserAvatar() error = %v", err)
	}
	if err := DeleteUserAvatar(12); err != nil {
		t.Fatalf("DeleteUserAvatar() error = %v", err)
	}
	if _, err := GetUserAvatar(12); err == nil {
		t.Fatal("avatar row survived the delete")
	}
	// 没有行时删除是无操作：调用方并不知道用户是否上传过。
	if err := DeleteUserAvatar(12); err != nil {
		t.Fatalf("second DeleteUserAvatar() error = %v", err)
	}
	if err := DeleteUserAvatar(0); err != nil {
		t.Fatalf("DeleteUserAvatar(0) error = %v", err)
	}
}

func TestGetUserAvatarWithoutRow(t *testing.T) {
	newUserAvatarTestDB(t)

	if _, err := GetUserAvatar(13); err == nil {
		t.Fatal("expected an error for a user without avatar")
	}
	if _, err := GetUserAvatar(0); err == nil {
		t.Fatal("expected an error for user id 0")
	}
}

// 内容哈希只取决于字节：同样的图片重复上传得到同样的 URL（缓存复用），
// 不同字节必然不同（缓存失效）。这是「删除后再上传」不会复用旧 URL 的依据。
func TestAvatarContentHashIsContentAddressed(t *testing.T) {
	newUserAvatarTestDB(t)

	try := func(a, b []byte) (string, string) {
		hashA, err := SaveUserAvatar(21, "image/png", a)
		if err != nil {
			t.Fatalf("SaveUserAvatar() error = %v", err)
		}
		hashB, err := SaveUserAvatar(22, "image/png", b)
		if err != nil {
			t.Fatalf("SaveUserAvatar() error = %v", err)
		}
		return hashA, hashB
	}

	sameA, sameB := try([]byte("same-bytes"), []byte("same-bytes"))
	if sameA != sameB {
		t.Errorf("identical bytes produced different hashes: %q vs %q", sameA, sameB)
	}
	diffA, diffB := try([]byte("bytes-a"), []byte("bytes-b"))
	if diffA == diffB {
		t.Errorf("different bytes produced the same hash %q", diffA)
	}
	if len(diffA) != 16 {
		t.Errorf("hash length = %d, want 16 hex characters", len(diffA))
	}
}
