package model

import (
	"errors"
	"testing"
	"time"
)

// 已存在的账号再次通过 OIDC 登录时，只应更新身份源管辖的字段。
//
// 之前是整行 Save，而带上去的结构体只填了 IdP 提供的字段（其余是零值），
// 于是每次登录都会把管理员维护的有效期、邮箱、备注、手机号、初始超管标记、
// MFA 级别一并抹掉——账号生命周期控制会因此整体失效。
func TestFindWithSubOrUpsertUserPreservesAdminManagedFields(t *testing.T) {
	newGroupMembershipTestDB(t)

	expires := time.Now().Add(24 * time.Hour)
	existing := User{
		Username:     "alice",
		Provider:     "oidc",
		Sub:          "sub-1",
		Enabled:      true,
		ExpiresAt:    &expires,
		IsSuperAdmin: true,
		Phone:        "13800000000",
		Remark:       "admin note",
		Email:        "alice@example.com",
		MFADisabled:  true,
	}
	if err := DB.Create(&existing).Error; err != nil {
		t.Fatalf("seeding user: %v", err)
	}

	incoming := &User{Username: "alice", Provider: "oidc", Sub: "sub-1", Name: "Alice"}
	if err := FindWithSubOrUpsertUser(incoming, true); err != nil {
		t.Fatalf("FindWithSubOrUpsertUser() error = %v", err)
	}

	var after User
	if err := DB.First(&after, existing.ID).Error; err != nil {
		t.Fatalf("reloading user: %v", err)
	}

	if after.ExpiresAt == nil {
		t.Error("ExpiresAt was cleared by an OIDC sign-in")
	} else if diff := after.ExpiresAt.Sub(expires); diff > time.Second || diff < -time.Second {
		t.Errorf("ExpiresAt = %v, want about %v", after.ExpiresAt, expires)
	}
	if !after.IsSuperAdmin {
		t.Error("IsSuperAdmin was cleared by an OIDC sign-in")
	}
	if after.Phone != "13800000000" || after.Remark != "admin note" {
		t.Errorf("Phone/Remark = %q/%q, want them preserved", after.Phone, after.Remark)
	}
	if after.Email != "alice@example.com" {
		t.Errorf("Email = %q, want it preserved", after.Email)
	}
	if !after.MFADisabled {
		t.Error("MFADisabled was cleared by an OIDC sign-in")
	}

	// 身份源管辖的字段照旧更新，且调用方拿到的是库里的真实状态。
	if after.Name != "Alice" {
		t.Errorf("Name = %q, want the IdP value", after.Name)
	}
	if after.LastLoginAt == nil {
		t.Error("LastLoginAt was not updated")
	}
	if !incoming.Enabled {
		t.Error("the returned user should carry the stored enabled state")
	}
	if incoming.ExpiresAt == nil {
		t.Error("the returned user should carry the stored expiry")
	}
}

// 「仅存在用户登录」的预先开通路径：sub 是首次登录才出现的，所以按用户名把
// 管理员预先建好的本地账号与身份源绑定起来。
func TestFindWithSubOrUpsertUserBindsPreProvisionedAccountByUsername(t *testing.T) {
	newGroupMembershipTestDB(t)

	preProvisioned := User{Username: "alice", Provider: AuthProviderPassword, Enabled: true}
	if err := DB.Create(&preProvisioned).Error; err != nil {
		t.Fatalf("seeding pre-provisioned account: %v", err)
	}

	incoming := &User{Username: "alice", Provider: "oidc", Sub: "sub-1", Name: "Alice"}
	if err := FindWithSubOrUpsertUser(incoming, true); err != nil {
		t.Fatalf("FindWithSubOrUpsertUser() error = %v", err)
	}

	var after User
	if err := DB.First(&after, preProvisioned.ID).Error; err != nil {
		t.Fatalf("reloading account: %v", err)
	}
	if after.Sub != "sub-1" {
		t.Errorf("Sub = %q, want it bound to the identity provider subject", after.Sub)
	}
	if after.Provider != "oidc" {
		t.Errorf("Provider = %q, want the identity provider to own the account", after.Provider)
	}
	if after.Name != "Alice" {
		t.Errorf("Name = %q, want the IdP value", after.Name)
	}
}

// 开启「仅存在用户登录」后，既没有绑定该 sub、也没有同名账号的身份必须被拒绝，
// 而不是自动建号——这正是这个开关要拦的情况。
func TestFindWithSubOrUpsertUserRejectsUnknownIdentityWhenEnabled(t *testing.T) {
	newGroupMembershipTestDB(t)

	incoming := &User{Username: "stranger", Provider: "oidc", Sub: "sub-stranger"}
	err := FindWithSubOrUpsertUser(incoming, true)
	if !errors.Is(err, ErrUserNotProvisioned) {
		t.Fatalf("FindWithSubOrUpsertUser() error = %v, want ErrUserNotProvisioned", err)
	}

	var count int64
	if err := DB.Model(&User{}).Where("username = ?", "stranger").Count(&count).Error; err != nil {
		t.Fatalf("counting users: %v", err)
	}
	if count != 0 {
		t.Errorf("a rejected identity created %d account(s)", count)
	}
}

// 关闭时保持原有行为：未知身份自动建号。
func TestFindWithSubOrUpsertUserCreatesUnknownIdentityWhenDisabled(t *testing.T) {
	newGroupMembershipTestDB(t)

	incoming := &User{Username: "newcomer", Provider: "oidc", Sub: "sub-new"}
	if err := FindWithSubOrUpsertUser(incoming, false); err != nil {
		t.Fatalf("FindWithSubOrUpsertUser() error = %v", err)
	}

	var after User
	if err := DB.Where("sub = ?", "sub-new").First(&after).Error; err != nil {
		t.Fatalf("created account not found: %v", err)
	}
	if after.Username != "newcomer" {
		t.Errorf("Username = %q, want newcomer", after.Username)
	}
}

// 初始超级管理员是应急入口，不允许被身份源按用户名认领：
// 那会让本地应急口令失效，而这是管理面最后的入口。
func TestFindWithSubOrUpsertUserNeverClaimsGuardedSuperAdmin(t *testing.T) {
	newGroupMembershipTestDB(t)

	superAdmin := User{Username: "root", Provider: AuthProviderPassword, Enabled: true, IsSuperAdmin: true}
	if err := DB.Create(&superAdmin).Error; err != nil {
		t.Fatalf("seeding super admin: %v", err)
	}

	incoming := &User{Username: "root", Provider: "oidc", Sub: "sub-root"}
	err := FindWithSubOrUpsertUser(incoming, true)
	if !errors.Is(err, ErrUserProviderConflict) {
		t.Fatalf("FindWithSubOrUpsertUser() error = %v, want ErrUserProviderConflict", err)
	}

	var after User
	if err := DB.First(&after, superAdmin.ID).Error; err != nil {
		t.Fatalf("reloading super admin: %v", err)
	}
	if after.Sub != "" || after.Provider != AuthProviderPassword {
		t.Errorf("super admin was claimed: sub=%q provider=%q", after.Sub, after.Provider)
	}
}
