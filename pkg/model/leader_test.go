package model

import (
	"fmt"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var leaderLeaseTestDBCounter int

func newLeaderLeaseTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	leaderLeaseTestDBCounter++
	originalDB := DB
	dsn := fmt.Sprintf("file:leader-lease-%d?mode=memory&cache=shared", leaderLeaseTestDBCounter)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.AutoMigrate(&LeaderLease{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	DB = db
	t.Cleanup(func() { DB = originalDB })
	return db
}

// 同一把租约在同一时刻只能由一个持有者拿到：这是「周期性全局任务不重复执行」的全部依据。
func TestAcquireLeaderLeaseIsExclusive(t *testing.T) {
	newLeaderLeaseTestDB(t)

	const ttl = time.Minute

	held, err := AcquireLeaderLease("test-lease", "replica-a", ttl)
	if err != nil {
		t.Fatalf("AcquireLeaderLease() error = %v", err)
	}
	if !held {
		t.Fatal("首个抢租约的副本应当拿到它")
	}

	// 别人来抢：租约还没过期，必须抢不到。
	held, err = AcquireLeaderLease("test-lease", "replica-b", ttl)
	if err != nil {
		t.Fatalf("AcquireLeaderLease() error = %v", err)
	}
	if held {
		t.Error("租约未过期时第二个副本不该抢到")
	}

	// 持有者续约：仍然是自己的。
	held, err = AcquireLeaderLease("test-lease", "replica-a", ttl)
	if err != nil {
		t.Fatalf("AcquireLeaderLease() error = %v", err)
	}
	if !held {
		t.Error("持有者续约应当成功")
	}

	// 不同名字的租约互不干扰（多个任务可以各有各的执行者）。
	if held, err := AcquireLeaderLease("another-lease", "replica-b", ttl); err != nil || !held {
		t.Errorf("换一个租约名后另一个副本应当能拿到: held=%v err=%v", held, err)
	}
}

// 租约过期（主副本挂死、失联）后必须能被接管，否则任务会永久停摆。
func TestAcquireLeaderLeaseAllowsTakeoverAfterExpiry(t *testing.T) {
	db := newLeaderLeaseTestDB(t)

	if held, err := AcquireLeaderLease("test-lease", "replica-a", time.Minute); err != nil || !held {
		t.Fatalf("首次抢租约失败: held=%v err=%v", held, err)
	}

	// 把租约改成已过期：模拟主副本没能续约。
	if err := db.Model(&LeaderLease{}).Where("name = ?", "test-lease").
		Update("expires_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatalf("把租约改成过期: %v", err)
	}

	held, err := AcquireLeaderLease("test-lease", "replica-b", time.Minute)
	if err != nil {
		t.Fatalf("AcquireLeaderLease() error = %v", err)
	}
	if !held {
		t.Fatal("租约过期后应当可以被接管")
	}

	// 原持有者现在成了「非持有者」：不能再抢回去（否则两个副本会同时以为自己有权）。
	held, err = AcquireLeaderLease("test-lease", "replica-a", time.Minute)
	if err != nil {
		t.Fatalf("AcquireLeaderLease() error = %v", err)
	}
	if held {
		t.Error("被别人接管后原持有者不该抢回")
	}
}

// 主动让位：正常退出时租约立刻消失，其它副本不必等 TTL。
func TestReleaseLeaderLeaseLetsAnotherReplicaTakeOver(t *testing.T) {
	newLeaderLeaseTestDB(t)

	if held, err := AcquireLeaderLease("test-lease", "replica-a", time.Minute); err != nil || !held {
		t.Fatalf("首次抢租约失败: held=%v err=%v", held, err)
	}
	// 不是持有者时不该删掉别人的租约。
	if err := ReleaseLeaderLease("test-lease", "replica-b"); err != nil {
		t.Fatalf("ReleaseLeaderLease() error = %v", err)
	}
	if held, err := AcquireLeaderLease("test-lease", "replica-b", time.Minute); err != nil || held {
		t.Fatalf("非持有者不该能释放租约: held=%v err=%v", held, err)
	}

	if err := ReleaseLeaderLease("test-lease", "replica-a"); err != nil {
		t.Fatalf("ReleaseLeaderLease() error = %v", err)
	}
	held, err := AcquireLeaderLease("test-lease", "replica-b", time.Minute)
	if err != nil {
		t.Fatalf("AcquireLeaderLease() error = %v", err)
	}
	if !held {
		t.Error("持有者释放后，下一个副本应当立刻能接手")
	}
}

// 每次成功续约都必须让这一行真的变化（renewals 自增）：MySQL 的 RowsAffected 统计的是
// 「值被改变的行数」，只看 expires_at 会在时间精度截断时返回 0、把持有者误判成「丢了租约」。
func TestAcquireLeaderLeaseRenewalAlwaysChangesTheRow(t *testing.T) {
	db := newLeaderLeaseTestDB(t)

	if held, err := AcquireLeaderLease("test-lease", "replica-a", time.Minute); err != nil || !held {
		t.Fatalf("首次抢租约失败: held=%v err=%v", held, err)
	}
	var lease LeaderLease
	if err := db.Where("name = ?", "test-lease").First(&lease).Error; err != nil {
		t.Fatalf("读取租约: %v", err)
	}
	if lease.Renewals != 1 {
		t.Fatalf("首次创建后 renewals = %d, want 1", lease.Renewals)
	}

	// 连续续约走的是「holder = 自己」那条分支（真正的续约路径）。
	for i := 0; i < 3; i++ {
		if held, err := AcquireLeaderLease("test-lease", "replica-a", time.Minute); err != nil || !held {
			t.Fatalf("第 %d 次续约失败: held=%v err=%v", i+1, held, err)
		}
	}
	if err := db.Where("name = ?", "test-lease").First(&lease).Error; err != nil {
		t.Fatalf("读取租约: %v", err)
	}
	if lease.Renewals != 4 {
		t.Errorf("续约 3 次后 renewals = %d, want 4", lease.Renewals)
	}
	if lease.Holder != "replica-a" {
		t.Errorf("holder = %q, want replica-a", lease.Holder)
	}
}
