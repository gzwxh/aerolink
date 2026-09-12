package model

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	expirable "github.com/hashicorp/golang-lru/v2/expirable"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/utils"
	"gorm.io/gorm"
	"k8s.io/klog/v2"
)

type User struct {
	Model
	Username        string       `json:"username" gorm:"type:varchar(50);uniqueIndex;not null"`
	Password        string       `json:"-" gorm:"type:varchar(255)"`
	Name            string       `json:"name,omitempty" gorm:"type:varchar(100);index"`
	AvatarURL       string       `json:"avatar_url,omitempty" gorm:"type:text"`
	Provider        string       `json:"provider,omitempty" gorm:"type:varchar(50);default:password;index"`
	OIDCGroups      SliceString  `json:"oidc_groups,omitempty" gorm:"type:text"`
	LastLoginAt     *time.Time   `json:"lastLoginAt,omitempty" gorm:"type:timestamp;index"`
	Enabled         bool         `json:"enabled" gorm:"type:boolean;default:true"`
	PendingDeletion bool         `json:"pendingDeletion,omitempty" gorm:"type:boolean;not null;default:false;index"`
	Sub             string       `json:"sub,omitempty" gorm:"type:varchar(255);index"`
	MFAEnabled      bool         `json:"mfa_enabled" gorm:"column:mfa_enabled;type:boolean;not null;default:false"`
	MFASecret       SecretString `json:"-" gorm:"column:mfa_secret;type:text"`

	APIKey SecretString  `json:"apiKey,omitempty" gorm:"type:text"`
	Roles  []common.Role `json:"roles,omitempty" gorm:"-"`

	SidebarPreference string `json:"sidebar_preference,omitempty" gorm:"type:text"`
}

func (u *User) Key() string {
	if u.Username != "" {
		return u.Username
	}
	if u.Name != "" {
		return u.Name
	}
	if u.Sub != "" {
		return u.Sub
	}
	return fmt.Sprintf("%d", u.ID)
}

func (u *User) GetAPIKey() string {
	return fmt.Sprintf("kite%d-%s", u.ID, string(u.APIKey))
}

func AddUser(user *User) error {
	// Hash the password before storing it
	hash, err := utils.HashPassword(user.Password)
	if err != nil {
		return err
	}
	user.Password = hash
	return DB.Create(user).Error
}

func CountUsers() (count int64, err error) {
	return count, DB.Model(&User{}).Count(&count).Error
}

// userCache is a thread-safe LRU with 30s TTL.
// Eliminates the per-request SELECT in RequireAuth (~1-5ms → ~50ns).
// Capacity 256 is generous for a K8s dashboard user base.
var userCache = expirable.NewLRU[uint64, *User](256, nil, 30*time.Second)

// GetUserByIDCached returns the user from cache if available, otherwise
// fetches from DB and stores it.  Used on the hot auth path.
func GetUserByIDCached(id uint64) (*User, error) {
	if u, ok := userCache.Get(id); ok {
		// Return a shallow copy so callers (RequireAuth, etc.) can safely
		// mutate fields like Roles without racing on the cached pointer.
		copy := *u
		return &copy, nil
	}
	u, err := GetUserByID(id)
	if err != nil {
		return nil, err
	}
	userCache.Add(id, u)
	// Also return a copy on miss path to keep the cached entry immutable.
	copy := *u
	return &copy, nil
}

// InvalidateUserCache removes a user from the auth cache.
// Called after every successful mutation so that security-sensitive changes
// (disable, delete, password reset) take effect on the next auth check.
func InvalidateUserCache(id uint64) {
	userCache.Remove(id)
}

func GetUserByID(id uint64) (*User, error) {
	var user User
	if err := DB.Where("id = ?", id).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

func GetAnonymousUser() *User {
	user := &User{}
	if err := DB.Where("username = ? AND provider = ?", "anonymous", "Anonymous").First(user).Error; err != nil {
		return nil
	}
	return user
}

func FindWithSubOrUpsertUser(user *User) error {
	if user.Sub == "" {
		return errors.New("user sub is empty")
	}
	var existingUser User
	now := time.Now()
	user.LastLoginAt = &now
	if err := DB.Where("sub = ?", user.Sub).First(&existingUser).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if err := DB.Create(user).Error; err != nil {
				if !isUniqueConstraintError(err) {
					return err
				}
				// The username is already taken by a record from another source
				// (native password, LDAP or a different OIDC provider). The local
				// record's configured source stays authoritative — never hijack it.
				return ErrUserProviderConflict
			}
			syncGroupsAfterUserWrite(user.ID, user.OIDCGroups, groupSourceForProvider(user.Provider))
			return nil
		}
		return err
	}
	user.Enabled = existingUser.Enabled

	user.ID = existingUser.ID
	user.CreatedAt = existingUser.CreatedAt
	user.SidebarPreference = existingUser.SidebarPreference
	err := DB.Save(user).Error
	if err == nil {
		syncGroupsAfterUserWrite(user.ID, user.OIDCGroups, groupSourceForProvider(user.Provider))
	}
	InvalidateUserCache(uint64(user.ID))
	return err
}

// groupSourceForProvider maps a login provider to the group source recorded
// on group / group_member rows.
func groupSourceForProvider(provider string) string {
	if provider == AuthProviderLDAP {
		return GroupSourceLDAP
	}
	return GroupSourceOIDC
}

// syncGroupsAfterUserWrite mirrors a user's group list into the normalized
// group_members table (best-effort: never blocks the login/sync flow).
func syncGroupsAfterUserWrite(userID uint, groups SliceString, source string) {
	if err := SyncUserGroupMembership(userID, groups, source); err != nil {
		klog.Warningf("failed to sync group membership for user %d: %v", userID, err)
	}
}

func GetUserByUsername(username string) (*User, error) {
	var user User
	if err := DB.Where("username = ?", username).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

// ListUsers returns users with pagination. If limit is 0, defaults to 20.
func ListUsers(limit int, offset int, search string, sortBy string, sortOrder string, role string) (users []User, total int64, err error) {
	if limit <= 0 {
		limit = 20
	}
	query := DB.Model(&User{}).Where("users.provider != ?", common.APIKeyProvider)
	if role != "" {
		query = query.Joins(
			"JOIN role_assignments ra ON ra.subject = users.username AND ra.subject_type = ?",
			SubjectTypeUser,
		).Joins("JOIN roles r ON r.id = ra.role_id").Where("r.name = ?", role)
	}
	if search != "" {
		likeQuery := "%" + search + "%"
		query = query.Where(
			"users.username LIKE ? OR users.name LIKE ?",
			likeQuery,
			likeQuery,
		)
	}
	countQuery := query.Select("users.id").Distinct("users.id")
	err = DB.Table("(?) as sub", countQuery).Count(&total).Error
	if err != nil {
		return nil, 0, err
	}
	if sortOrder != "asc" && sortOrder != "desc" {
		sortOrder = "desc"
	}
	allowedSorts := map[string]string{
		"id":          "users.id",
		"createdAt":   "users.created_at",
		"lastLoginAt": "users.last_login_at",
	}
	sortColumn, ok := allowedSorts[sortBy]
	if !ok {
		sortColumn = "users.id"
	}
	orderExpr := fmt.Sprintf("%s %s", sortColumn, sortOrder)
	if sortColumn == "users.last_login_at" {
		orderExpr = fmt.Sprintf("users.last_login_at IS NULL, users.last_login_at %s", sortOrder)
	}
	var userIds []uint
	idsQuery := query.
		Select("users.id").
		Distinct("users.id").
		Order(orderExpr).
		Limit(limit).
		Offset(offset)
	err = idsQuery.Pluck("users.id", &userIds).Error
	if err != nil {
		return nil, 0, err
	}
	err = DB.
		Where("id IN (?)", userIds).
		Order(orderExpr).
		Find(&users).Error
	if err != nil {
		return nil, 0, err
	}
	return users, total, nil
}

func LoginUser(u *User) error {
	now := time.Now()
	u.LastLoginAt = &now
	err := DB.Model(&User{}).Where("id = ? AND enabled = ?", u.ID, true).Update("last_login_at", now).Error
	InvalidateUserCache(uint64(u.ID))
	return err
}

// DeleteUserByID removes a user by ID
func DeleteUserByID(id uint) error {
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		return err
	}
	if err := ensureNotLastEnabledDirectAdmin(user.ID, user.Username); err != nil {
		return err
	}
	_ = DB.Where("operator_id = ?", id).Delete(&ResourceHistory{}).Error
	err := DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := tx.Select("username").First(&user, id).Error; err != nil {
			return err
		}
		if err := tx.Where("subject_type = ? AND subject = ?", SubjectTypeUser, user.Username).Delete(&RoleAssignment{}).Error; err != nil {
			return err
		}
		return tx.Delete(&User{}, id).Error
	})
	InvalidateUserCache(uint64(id))
	return err
}

// ensureNotLastEnabledDirectAdmin prevents disabling/deleting the last enabled
// account that holds the admin role through a direct user assignment, so a
// misconfiguration cannot lock everyone out of the console. Group-mapped admins
// (typically external users) are not counted because disabling their only admin
// already protects itself through this same check on direct assignments.
func ensureNotLastEnabledDirectAdmin(id uint, username string) error {
	var adminRole Role
	if err := DB.Where("name = ?", DefaultAdminRole.Name).First(&adminRole).Error; err != nil {
		// No admin role is configured yet — nothing to protect.
		return nil
	}
	var directAssignments int64
	DB.Model(&RoleAssignment{}).
		Where("role_id = ? AND subject_type = ? AND subject = ?",
			adminRole.ID, SubjectTypeUser, username).
		Count(&directAssignments)
	if directAssignments == 0 {
		return nil
	}
	var otherEnabledAdmins int64
	DB.Model(&RoleAssignment{}).
		Where("role_id = ? AND subject_type = ? AND subject <> ? AND subject IN (?)",
			adminRole.ID, SubjectTypeUser, username,
			DB.Model(&User{}).Select("username").Where("enabled = ? AND id <> ?", true, id)).
		Count(&otherEnabledAdmins)
	if otherEnabledAdmins == 0 {
		return errors.New("cannot disable or delete the last enabled admin account; keep at least one enabled user assigned the admin role before continuing")
	}
	return nil
}

// UpdateUser saves provided user (expects ID set)
func UpdateUser(user *User) error {
	err := DB.Save(user).Error
	if err == nil {
		syncGroupsAfterUserWrite(user.ID, user.OIDCGroups, groupSourceForProvider(user.Provider))
	}
	InvalidateUserCache(uint64(user.ID))
	return err
}

// ResetPasswordByID sets a new password (hashed) for user with given id
func ResetPasswordByID(id uint, plainPassword string) error {
	var u User
	if err := DB.First(&u, id).Error; err != nil {
		return err
	}
	hash, err := utils.HashPassword(plainPassword)
	if err != nil {
		return err
	}
	u.Password = hash
	err = DB.Save(&u).Error
	InvalidateUserCache(uint64(id))
	return err
}

// SetUserEnabled updates the enabled flag. Re-enabling an LDAP user cancels a
// pending deferred deletion (the admin changed their mind before the LDAP sync
// physically removed the record).
func SetUserEnabled(id uint, enabled bool) error {
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		return err
	}
	if !enabled {
		if err := ensureNotLastEnabledDirectAdmin(user.ID, user.Username); err != nil {
			return err
		}
	}
	updates := map[string]any{"enabled": enabled}
	if enabled && user.Provider == AuthProviderLDAP {
		updates["pending_deletion"] = false
	}
	err := DB.Model(&User{}).Where("id = ?", id).Updates(updates).Error
	InvalidateUserCache(uint64(id))
	return err
}

// UpdateUserName updates only the display name of a user.
func UpdateUserName(id uint, name string) error {
	err := DB.Model(&User{}).Where("id = ?", id).Update("name", name).Error
	InvalidateUserCache(uint64(id))
	return err
}

// StoreMFASecret persists a pending MFA secret without enabling MFA yet.
func StoreMFASecret(id uint, secret string) error {
	err := DB.Model(&User{}).Where("id = ?", id).Updates(map[string]any{
		"mfa_secret":  SecretString(secret),
		"mfa_enabled": false,
	}).Error
	InvalidateUserCache(uint64(id))
	return err
}

// EnableUserMFA marks MFA as active for the given user (secret must already be stored).
func EnableUserMFA(id uint) error {
	err := DB.Model(&User{}).Where("id = ?", id).Update("mfa_enabled", true).Error
	InvalidateUserCache(uint64(id))
	return err
}

// DisableUserMFA clears MFA for the given user.
func DisableUserMFA(id uint) error {
	err := DB.Model(&User{}).Where("id = ?", id).Updates(map[string]any{
		"mfa_enabled": false,
		"mfa_secret":  "",
	}).Error
	InvalidateUserCache(uint64(id))
	return err
}

func CheckPassword(hashedPassword, plainPassword string) bool {
	return utils.CheckPasswordHash(plainPassword, hashedPassword)
}

// SyncLDAPUser creates or updates a user from a directory sync. It never
// touches LastLoginAt. Newly discovered users are created with the requested
// enabled state (batch-import option); existing records keep their current
// Enabled/PendingDeletion state so an admin's decision is never overridden.
func SyncLDAPUser(user *User, createEnabled bool) (created bool, err error) {
	if user == nil {
		return false, errors.New("user is nil")
	}
	username := strings.TrimSpace(user.Username)
	if username == "" {
		return false, errors.New("username is empty")
	}
	user.Username = username
	user.Provider = AuthProviderLDAP
	user.Password = ""

	var existingUser User
	if err := DB.Where("username = ?", username).First(&existingUser).Error; err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return false, err
		}
		name := strings.TrimSpace(user.Name)
		if name == "" {
			name = username
		}
		newUser := &User{
			Username:        username,
			Name:            name,
			Provider:        AuthProviderLDAP,
			OIDCGroups:      user.OIDCGroups,
			Enabled:         createEnabled,
			PendingDeletion: false,
		}
		if err := DB.Create(newUser).Error; err != nil {
			if !isUniqueConstraintError(err) {
				return false, err
			}
			// Lost a race with another writer; fall through to update below.
			if err := DB.Where("username = ?", username).First(&existingUser).Error; err != nil {
				return false, err
			}
		} else {
			InvalidateUserCache(uint64(newUser.ID))
			syncGroupsAfterUserWrite(newUser.ID, newUser.OIDCGroups, GroupSourceLDAP)
			return true, nil
		}
	}

	if existingUser.Provider != AuthProviderLDAP {
		return false, ErrUserProviderConflict
	}
	if name := strings.TrimSpace(user.Name); name != "" {
		existingUser.Name = name
	}
	existingUser.OIDCGroups = user.OIDCGroups
	if err := DB.Save(&existingUser).Error; err != nil {
		return false, err
	}
	InvalidateUserCache(uint64(existingUser.ID))
	syncGroupsAfterUserWrite(existingUser.ID, existingUser.OIDCGroups, GroupSourceLDAP)
	return false, nil
}

// GetLDAPUserByUsername returns the local record for a directory (LDAP) user.
func GetLDAPUserByUsername(username string) (*User, error) {
	var user User
	err := DB.Where("username = ? AND provider = ?",
		strings.TrimSpace(username), AuthProviderLDAP).First(&user).Error
	if err != nil {
		return nil, err
	}
	return &user, nil
}

// ListLDAPUsers returns all locally provisioned directory (LDAP) users.
func ListLDAPUsers() (users []User, err error) {
	err = DB.Where("provider = ?", AuthProviderLDAP).Order("username asc").Find(&users).Error
	return users, err
}

// ListDisabledLDAPUsers returns LDAP users that are disabled locally. The
// periodic directory sync physically removes such accounts once they no longer
// exist in the source directory.
func ListDisabledLDAPUsers() (users []User, err error) {
	err = DB.Where("provider = ? AND enabled = ?",
		AuthProviderLDAP, false).Order("id asc").Find(&users).Error
	return users, err
}

// ListKnownGroups returns every group name known to the console, sorted and
// de-duplicated. It reads the group column of the users table directly
// (comma-separated, one row per account) — LDAP/OIDC synced groups and groups
// manually assigned to native users — plus group subjects already used in role
// assignments and explicitly persisted local groups.
func ListKnownGroups() ([]string, error) {
	set := make(map[string]struct{})

	column, err := userGroupsColumn()
	if err != nil {
		return nil, err
	}

	var raws []string
	err = DB.Model(&User{}).
		Where(column+" IS NOT NULL AND "+column+" <> ''").
		Pluck(column, &raws).Error
	if err != nil {
		return nil, err
	}
	for _, raw := range raws {
		for _, g := range strings.Split(raw, ",") {
			if name := strings.TrimSpace(g); name != "" {
				set[name] = struct{}{}
			}
		}
	}

	var assigned []string
	if err := DB.Model(&RoleAssignment{}).
		Where("subject_type = ? AND subject <> ''", SubjectTypeGroup).
		Distinct().Pluck("subject", &assigned).Error; err != nil {
		return nil, err
	}
	for _, g := range assigned {
		if name := strings.TrimSpace(g); name != "" {
			set[name] = struct{}{}
		}
	}

	// Explicitly persisted groups (possibly empty, no members or grants yet).
	var local []string
	if err := DB.Model(&LocalGroup{}).Pluck("name", &local).Error; err != nil {
		return nil, err
	}
	for _, g := range local {
		if name := strings.TrimSpace(g); name != "" {
			set[name] = struct{}{}
		}
	}

	groups := make([]string, 0, len(set))
	for name := range set {
		groups = append(groups, name)
	}
	sort.Strings(groups)
	return groups, nil
}

// userGroupsColumn discovers the physical column of the users table that holds
// the comma-separated group names. GORM derives a column name from the
// OIDCGroups field, but pre-existing databases may have been created with a
// different literal name, so the real column is resolved from the database
// catalog instead of being hard-coded.
func userGroupsColumn() (string, error) {
	candidates := []string{}

	stmt := &gorm.Statement{DB: DB}
	if err := stmt.Parse(&User{}); err == nil {
		if field := stmt.Schema.LookUpField("OIDCGroups"); field != nil && field.DBName != "" {
			candidates = append(candidates, field.DBName)
		}
	}
	// Historical / observed alternatives kept as fallbacks.
	candidates = append(candidates,
		"oidc_groups",
		"oid_c_groups",
		"o_id_c_groups",
		"o_i_d_c_groups",
	)

	existing := make(map[string]struct{})
	switch common.DBType {
	case "mysql":
		var cols []struct {
			ColumnName string `gorm:"column:column_name"`
		}
		if err := DB.Raw("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users'").Scan(&cols).Error; err != nil {
			return "", err
		}
		for _, c := range cols {
			existing[strings.ToLower(c.ColumnName)] = struct{}{}
		}
	case "postgres":
		var cols []struct {
			ColumnName string `gorm:"column:column_name"`
		}
		if err := DB.Raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'").Scan(&cols).Error; err != nil {
			return "", err
		}
		for _, c := range cols {
			existing[strings.ToLower(c.ColumnName)] = struct{}{}
		}
	default: // sqlite
		var cols []struct {
			Name string `gorm:"column:name"`
		}
		if err := DB.Raw("PRAGMA table_info(users)").Scan(&cols).Error; err != nil {
			return "", err
		}
		for _, c := range cols {
			existing[strings.ToLower(c.Name)] = struct{}{}
		}
	}

	seen := make(map[string]struct{}, len(candidates))
	for _, column := range candidates {
		lower := strings.ToLower(strings.TrimSpace(column))
		if lower == "" {
			continue
		}
		if _, ok := seen[lower]; ok {
			continue
		}
		seen[lower] = struct{}{}
		if _, ok := existing[lower]; ok {
			return column, nil
		}
	}

	named := make([]string, 0, len(existing))
	for name := range existing {
		named = append(named, name)
	}
	sort.Strings(named)
	return "", fmt.Errorf("unable to locate the group column on the users table (columns: %s)", strings.Join(named, ", "))
}

func isUniqueConstraintError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint failed") ||
		strings.Contains(message, "duplicate key value") ||
		strings.Contains(message, "duplicate entry")
}

// IsUniqueConstraintError reports whether err is a duplicate/unique violation,
// so callers can answer with a conflict instead of leaking a raw SQL error.
func IsUniqueConstraintError(err error) bool {
	return isUniqueConstraintError(err)
}

func AddSuperUser(user *User) error {
	if user == nil {
		return errors.New("user is nil")
	}
	if err := AddUser(user); err != nil {
		return err
	}
	if err := AddRoleAssignment("admin", SubjectTypeUser, user.Username); err != nil {
		return err
	}
	return nil
}

func NewAPIKeyUser(name string) (*User, error) {
	apiKey := utils.RandomString(32)
	u := &User{
		Username: name,
		APIKey:   SecretString(apiKey),
		Provider: common.APIKeyProvider,
	}
	return u, DB.Save(u).Error
}

func ListAPIKeyUsers() (users []User, err error) {
	err = DB.Order("id desc").Where("provider = ?", common.APIKeyProvider).Find(&users).Error
	return users, err
}

var (
	ErrUserProviderConflict = errors.New("user exists with different provider")

	AnonymousUser = User{
		Model: Model{
			ID: 0,
		},
		Username: "anonymous",
		Provider: "Anonymous",
		Roles: []common.Role{
			{
				Name:       "admin",
				Clusters:   []string{"*"},
				Resources:  []string{"*"},
				Namespaces: []string{"*"},
				Verbs:      []string{"*"},
			},
		},
	}
)
