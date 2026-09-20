package model

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var userSessionTestDBCounter int

func newUserSessionTestDB(t *testing.T) {
	t.Helper()
	userSessionTestDBCounter++
	originalDB := DB
	dsn := fmt.Sprintf("file:user-session-%d?mode=memory&cache=shared", userSessionTestDBCounter)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&UserSession{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })
	// 会话状态是被多副本共享的一行：把连接数限制为 1，避免内存库的多连接可见性问题。
	if sqlDB, dbErr := db.DB(); dbErr == nil {
		sqlDB.SetMaxOpenConns(1)
	}
}

func TestStartUserSessionIncrementsSeq(t *testing.T) {
	newUserSessionTestDB(t)
	now := time.Now()

	first, err := StartUserSession(5, now)
	if err != nil {
		t.Fatalf("StartUserSession() error = %v", err)
	}
	if first.Seq != 1 || first.UserID != 5 {
		t.Fatalf("first session = %#v, want seq 1 for user 5", first)
	}

	later := now.Add(time.Minute)
	second, err := StartUserSession(5, later)
	if err != nil {
		t.Fatalf("StartUserSession() error = %v", err)
	}
	if second.Seq != 2 {
		t.Fatalf("second session seq = %d, want 2", second.Seq)
	}
	if !second.StartedAt.Equal(later) {
		t.Errorf("StartedAt = %v, want the new sign-in time %v", second.StartedAt, later)
	}

	// 每个用户一行。
	var count int64
	if err := DB.Model(&UserSession{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("session rows = %d (err %v), want 1", count, err)
	}
}

// 并发登录不能让两个会话拿到同一个序号，也不能留下两行。
func TestStartUserSessionIsMonotonicUnderConcurrency(t *testing.T) {
	newUserSessionTestDB(t)

	const callers = 8
	seqs := make(chan uint64, callers)
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			session, err := StartUserSession(9, time.Now())
			if err != nil {
				t.Errorf("StartUserSession() error = %v", err)
				return
			}
			seqs <- session.Seq
		}()
	}
	wg.Wait()
	close(seqs)

	seen := map[uint64]bool{}
	for seq := range seqs {
		if seen[seq] {
			t.Fatalf("seq %d was handed out twice", seq)
		}
		seen[seq] = true
	}
	if len(seen) != callers {
		t.Fatalf("got %d distinct seqs, want %d", len(seen), callers)
	}

	var count int64
	if err := DB.Model(&UserSession{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("session rows = %d (err %v), want 1", count, err)
	}
}

func TestTouchAndDeleteUserSession(t *testing.T) {
	newUserSessionTestDB(t)

	if _, err := StartUserSession(3, time.Now().Add(-time.Hour)); err != nil {
		t.Fatalf("StartUserSession() error = %v", err)
	}

	touched := time.Now()
	if err := TouchUserSession(3, touched); err != nil {
		t.Fatalf("TouchUserSession() error = %v", err)
	}
	session, err := GetUserSession(3)
	if err != nil {
		t.Fatalf("GetUserSession() error = %v", err)
	}
	if !session.LastSeen.Equal(touched) {
		t.Fatalf("LastSeen = %v, want %v", session.LastSeen, touched)
	}

	if err := DeleteUserSession(3); err != nil {
		t.Fatalf("DeleteUserSession() error = %v", err)
	}
	if _, err := GetUserSession(3); err == nil {
		t.Fatal("GetUserSession() returned a deleted row")
	}
}

// 退出登录只标记结束时间，序号必须保留：删行会让序号回退，已作废的旧令牌会因此复活。
func TestEndUserSessionKeepsSeqAndStartClearsIt(t *testing.T) {
	newUserSessionTestDB(t)

	first, err := StartUserSession(7, time.Now())
	if err != nil {
		t.Fatalf("StartUserSession() error = %v", err)
	}

	endedAt := time.Now()
	if err := EndUserSession(7, endedAt); err != nil {
		t.Fatalf("EndUserSession() error = %v", err)
	}
	ended := loadUserSessionRow(t, 7)
	if ended.Seq != first.Seq {
		t.Fatalf("seq after sign-out = %d, want it to stay %d", ended.Seq, first.Seq)
	}
	if ended.EndedAt == nil || !ended.EndedAt.Equal(endedAt) {
		t.Fatalf("EndedAt = %v, want %v", ended.EndedAt, endedAt)
	}

	// 下一次登录是新会话：结束标记要被清掉，否则它自己也会被当成「已结束的会话」。
	second, err := StartUserSession(7, time.Now())
	if err != nil {
		t.Fatalf("StartUserSession() error = %v", err)
	}
	if second.Seq != first.Seq+1 {
		t.Fatalf("seq after signing in again = %d, want %d", second.Seq, first.Seq+1)
	}
	if restarted := loadUserSessionRow(t, 7); restarted.EndedAt != nil {
		t.Fatalf("EndedAt = %v after signing in again, want nil", restarted.EndedAt)
	}
}

// 没有会话行时结束操作是无操作（例如令牌有效但状态已被清理），不该报错。
func TestEndUserSessionWithoutRow(t *testing.T) {
	newUserSessionTestDB(t)

	if err := EndUserSession(99, time.Now()); err != nil {
		t.Fatalf("EndUserSession() error = %v", err)
	}
	if _, err := GetUserSession(99); err == nil {
		t.Fatal("EndUserSession() created a row")
	}
}

func loadUserSessionRow(t *testing.T, userID uint) *UserSession {
	t.Helper()
	session, err := GetUserSession(userID)
	if err != nil {
		t.Fatalf("GetUserSession(%d) error = %v", userID, err)
	}
	return session
}

// 清理只删「按任何策略都不可能仍然有效」的行：开始与最近活动都早于界限。
func TestCleanupExpiredUserSessions(t *testing.T) {
	newUserSessionTestDB(t)
	now := time.Now()

	old, err := StartUserSession(1, now.Add(-48*time.Hour))
	if err != nil {
		t.Fatalf("StartUserSession() error = %v", err)
	}
	// 开始得早、但刚刚还有活动：不能删（可能仍在有效期内）。
	if _, err := StartUserSession(2, now.Add(-48*time.Hour)); err != nil {
		t.Fatalf("StartUserSession() error = %v", err)
	}
	if err := TouchUserSession(2, now); err != nil {
		t.Fatalf("TouchUserSession() error = %v", err)
	}
	if _, err := StartUserSession(3, now); err != nil {
		t.Fatalf("StartUserSession() error = %v", err)
	}

	if err := CleanupExpiredUserSessions(now.Add(-24 * time.Hour)); err != nil {
		t.Fatalf("CleanupExpiredUserSessions() error = %v", err)
	}

	if _, err := GetUserSession(1); err == nil {
		t.Fatalf("an idle session started at %v was not cleaned up", old.StartedAt)
	}
	if _, err := GetUserSession(2); err != nil {
		t.Errorf("a session with recent activity was cleaned up: %v", err)
	}
	if _, err := GetUserSession(3); err != nil {
		t.Errorf("a fresh session was cleaned up: %v", err)
	}
}
