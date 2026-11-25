package auth

import (
	"testing"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
)

// 计数与封锁状态现在在数据库里，所以「另一台机器」看到的结论与记录失败的那台一致——
// 这正是多副本下防爆破强度不随副本数衰减的原因。
func TestCredentialLoginLimiterIsSharedAcrossReplicas(t *testing.T) {
	setupAuthIntegrationDB(t)

	replicaA := &credentialLoginAttemptLimiter{}
	replicaB := &credentialLoginAttemptLimiter{}
	limits := loginLimits{
		ipFailLimit:   2,
		ipBlock:       time.Minute,
		userFailLimit: 99,
		userBlock:     time.Minute,
	}

	const ip = "203.0.113.7"
	const username = "bob"

	if replicaA.recordFailure(ip, username, limits) {
		t.Fatal("the first failure must not block")
	}
	// 第二次失败发生在「另一台机器」上：它必须能看到第一次的计数并触发封锁。
	if !replicaB.recordFailure(ip, username, limits) {
		t.Fatal("the failure count was not shared across replicas")
	}
	if !replicaA.blocked(ip, username, limits) {
		t.Fatal("replica A did not see the block recorded by replica B")
	}
}

// 管理员手动拉黑同样对所有副本生效（以前只存在于处理该请求的那台机器的内存里）。
func TestBlockLoginIPIsSharedAndOutranksWhitelist(t *testing.T) {
	setupAuthIntegrationDB(t)

	const ip = "198.51.100.9"
	whitelisted := loginLimits{ipWhitelist: []string{"198.51.100.0/24"}}

	if credentialLoginAttempts.blocked(ip, "carol", whitelisted) {
		t.Fatal("an unblocked IP must not be reported as blocked")
	}

	BlockLoginIP(ip, time.Now().Add(time.Minute))

	if !credentialLoginAttempts.blocked(ip, "carol", whitelisted) {
		t.Fatal("a manual block must outrank the whitelist exemption")
	}

	locked := BlockedLoginIPs()
	if len(locked) != 1 || locked[0].IP != ip {
		t.Fatalf("BlockedLoginIPs() = %#v, want the manually locked IP", locked)
	}

	if !UnblockLoginIP(ip) {
		t.Fatal("UnblockLoginIP() reported that the IP was not locked")
	}
	if credentialLoginAttempts.blocked(ip, "carol", whitelisted) {
		t.Fatal("the IP is still blocked after unlocking")
	}
	if len(BlockedLoginIPs()) != 0 {
		t.Fatal("the unlocked IP is still listed")
	}
}

// 管理员手动拉黑用户与 IP 走同一张表：同样对所有副本生效，且能被列出与解除。
// 用户名匹配大小写不敏感，列表里回传的是规范化后的写法。
func TestBlockLoginUserIsSharedAndListed(t *testing.T) {
	setupAuthIntegrationDB(t)

	const username = "Frank"
	limits := loginLimits{}

	if credentialLoginAttempts.blocked("203.0.113.60", username, limits) {
		t.Fatal("an unblocked user must not be reported as blocked")
	}

	BlockLoginUser(username, time.Now().Add(time.Minute))

	// 大小写不敏感：用小写写法登录同样被挡。
	if !credentialLoginAttempts.blocked("203.0.113.60", "frank", limits) {
		t.Fatal("a manual user block must apply regardless of username casing")
	}

	locked := BlockedLoginUsers()
	if len(locked) != 1 || locked[0].Username != "frank" {
		t.Fatalf("BlockedLoginUsers() = %#v, want the manually locked user", locked)
	}

	if !UnblockLoginUser(username) {
		t.Fatal("UnblockLoginUser() reported that the user was not locked")
	}
	if credentialLoginAttempts.blocked("203.0.113.60", username, limits) {
		t.Fatal("the user is still blocked after unlocking")
	}
	if len(BlockedLoginUsers()) != 0 {
		t.Fatal("the unlocked user is still listed")
	}
}

// 成功登录要清掉计数，否则正常用户会被自己之前的几次输错累积锁住。
func TestCredentialLoginLimiterClearResetsCounters(t *testing.T) {
	setupAuthIntegrationDB(t)

	const ip = "203.0.113.30"
	const username = "dave"
	limits := loginLimits{ipFailLimit: 3, ipBlock: time.Minute, userFailLimit: 3, userBlock: time.Minute}

	if credentialLoginAttempts.recordFailure(ip, username, limits) {
		t.Fatal("the first failure must not block")
	}
	credentialLoginAttempts.clear(ip, username)

	// 清空后再失败两次不应该封锁（阈值是 3）。
	for i := 1; i <= 2; i++ {
		if credentialLoginAttempts.recordFailure(ip, username, limits) {
			t.Fatalf("blocked after %d failures following a successful sign-in", i)
		}
	}
}

// 窗口过期后计数会重置：不会因为很久以前的几次输错而累积封锁。
func TestLoginAttemptWindowResets(t *testing.T) {
	setupAuthIntegrationDB(t)

	key := userAttemptKey("erin")
	window := 2 * time.Minute

	if _, err := model.RecordCredentialLoginFailure(key, time.Now(), window); err != nil {
		t.Fatalf("RecordCredentialLoginFailure() error = %v", err)
	}
	count, err := model.RecordCredentialLoginFailure(key, time.Now(), window)
	if err != nil {
		t.Fatalf("RecordCredentialLoginFailure() error = %v", err)
	}
	if count != 2 {
		t.Fatalf("count inside the window = %d, want 2", count)
	}

	// 窗口之外：计数从 1 重新开始。
	count, err = model.RecordCredentialLoginFailure(key, time.Now().Add(window+time.Second), window)
	if err != nil {
		t.Fatalf("RecordCredentialLoginFailure() error = %v", err)
	}
	if count != 1 {
		t.Fatalf("count after the window = %d, want 1 (the counter must reset)", count)
	}
}
