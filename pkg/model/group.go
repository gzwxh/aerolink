package model

import (
	"strings"
	"time"

	"gorm.io/gorm"
)

// Group sources: where a group or membership record originates from.
const (
	GroupSourceLocal = "local" // created / managed in the console UI
	GroupSourceLDAP  = "ldap"  // synced from an LDAP directory
	GroupSourceOIDC  = "oidc"  // synced from an OIDC provider at login
)

// LocalGroup persists a user group as a first-class entity. Groups may also
// exist implicitly (referenced by user profiles or role assignments), but a
// row here guarantees an empty group stays visible after creation. LDAP/OIDC
// groups discovered at sync/login time are upserted too, so every group is
// queryable locally regardless of its origin.
type LocalGroup struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	Name      string    `gorm:"uniqueIndex;size:128" json:"name"`
	Source    string    `gorm:"size:32;index;default:local" json:"source"`
	CreatedAt time.Time `json:"createdAt"`
}

func (LocalGroup) TableName() string { return "local_groups" }

// GroupMember is the normalized many-to-many relation between groups and
// users. It mirrors the denormalized comma-separated list on
// users.oidc_groups (which the RBAC hot path reads) and is kept in sync by
// the same write paths, giving management views a proper relational source.
type GroupMember struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	GroupName string    `gorm:"size:128;uniqueIndex:idx_group_member_unique" json:"groupName"`
	UserID    uint      `gorm:"index;uniqueIndex:idx_group_member_unique" json:"userId"`
	Source    string    `gorm:"size:32;default:local" json:"source"`
	CreatedAt time.Time `json:"createdAt"`
}

func (GroupMember) TableName() string { return "group_members" }

// CreateLocalGroup inserts a new group, enforcing unique names.
func CreateLocalGroup(name string) error {
	return DB.Create(&LocalGroup{Name: name, Source: GroupSourceLocal}).Error
}

// UpsertGroups persists the given group names as entities with the given
// source. Existing rows keep their original source (first writer wins) so a
// manually created group is not re-tagged by a directory sync.
func UpsertGroups(names []string, source string) error {
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		var count int64
		if err := DB.Model(&LocalGroup{}).Where("name = ?", name).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			if err := DB.Create(&LocalGroup{Name: name, Source: source}).Error; err != nil {
				// Lost a unique-index race: the group exists, which is fine.
				var exists int64
				if err2 := DB.Model(&LocalGroup{}).Where("name = ?", name).Count(&exists).Error; err2 != nil || exists == 0 {
					return err
				}
			}
		}
	}
	return nil
}

// ListLocalGroups returns every persisted group name.
func ListLocalGroups() ([]string, error) {
	var groups []LocalGroup
	err := DB.Order("name asc").Find(&groups).Error
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(groups))
	for _, g := range groups {
		names = append(names, g.Name)
	}
	return names, nil
}

// LocalGroupExists reports whether the group is persisted as an entity.
func LocalGroupExists(name string) (bool, error) {
	var count int64
	err := DB.Model(&LocalGroup{}).Where("name = ?", name).Count(&count).Error
	return count > 0, err
}

// SyncUserGroupMembership replaces the user's normalized group membership
// rows with the given list and upserts the group entities. Called after every
// write to users.oidc_groups (directory sync, external login, admin edit) so
// the relational view never drifts from the RBAC hot-path column.
func SyncUserGroupMembership(userID uint, groups []string, source string) error {
	cleaned := make([]string, 0, len(groups))
	for _, raw := range groups {
		if name := strings.TrimSpace(raw); name != "" {
			cleaned = append(cleaned, name)
		}
	}

	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&GroupMember{}).Error; err != nil {
			return err
		}
		for _, name := range cleaned {
			member := GroupMember{GroupName: name, UserID: userID, Source: source}
			if err := tx.Create(&member).Error; err != nil {
				return err
			}
		}
		return UpsertGroupsWithTx(tx, cleaned, source)
	})
}

// UpsertGroupsWithTx is UpsertGroups inside an existing transaction.
func UpsertGroupsWithTx(tx *gorm.DB, names []string, source string) error {
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		var count int64
		if err := tx.Model(&LocalGroup{}).Where("name = ?", name).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			if err := tx.Create(&LocalGroup{Name: name, Source: source}).Error; err != nil {
				var exists int64
				if err2 := tx.Model(&LocalGroup{}).Where("name = ?", name).Count(&exists).Error; err2 != nil || exists == 0 {
					return err
				}
			}
		}
	}
	return nil
}

// GroupMemberInfo is a membership row joined with basic user info.
type GroupMemberInfo struct {
	Username string `json:"username"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Source   string `json:"source"`
}

// ListGroupMembers returns the members of a group from the normalized
// membership table, joined with basic user info for display.
func ListGroupMembers(groupName string) ([]GroupMemberInfo, error) {
	var rows []GroupMemberInfo
	err := DB.Table("group_members").
		Select("users.username, users.name, users.provider, group_members.source AS source").
		Joins("JOIN users ON users.id = group_members.user_id").
		Where("group_members.group_name = ?", groupName).
		Order("group_members.created_at asc").
		Scan(&rows).Error
	return rows, err
}

// RenameLocalGroup atomically renames a group entity and every reference to
// it: the comma-separated group lists on user profiles, the normalized
// membership rows and group-subject role assignments. Exact matching is used
// for the user profile lists so groups with overlapping prefixes
// (dev / devops) are never mixed up.
func RenameLocalGroup(oldName, newName string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&LocalGroup{}).Where("name = ?", oldName).
			Update("name", newName)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		if err := rewriteGroupOnUsers(tx, oldName, newName); err != nil {
			return err
		}
		if err := tx.Model(&GroupMember{}).
			Where("group_name = ?", oldName).
			Update("group_name", newName).Error; err != nil {
			return err
		}
		return tx.Model(&RoleAssignment{}).
			Where("subject_type = ? AND subject = ?", SubjectTypeGroup, oldName).
			Update("subject", newName).Error
	})
}

// DeleteLocalGroup removes the group entity and cleans up every reference:
// memberships (both the normalized rows and the user profile lists) and
// group-subject role assignments.
func DeleteLocalGroup(name string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		res := tx.Where("name = ?", name).Delete(&LocalGroup{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		if err := rewriteGroupOnUsers(tx, name, ""); err != nil {
			return err
		}
		if err := tx.Where("group_name = ?", name).Delete(&GroupMember{}).Error; err != nil {
			return err
		}
		return tx.Where("subject_type = ? AND subject = ?", SubjectTypeGroup, name).
			Delete(&RoleAssignment{}).Error
	})
}

// rewriteGroupOnUsers rewrites the group column of every user profile,
// replacing oldName with newName (or removing it when newName is empty).
// The replacement runs on the parsed list so substring collisions between
// similarly named groups are impossible.
func rewriteGroupOnUsers(tx *gorm.DB, oldName, newName string) error {
	column, err := userGroupsColumn()
	if err != nil {
		return err
	}

	type row struct {
		ID     uint
		Groups string
	}
	var rows []row
	if err := tx.Model(&User{}).
		Select("id AS id, "+column+" AS groups").
		Where(column+" LIKE ?", "%"+oldName+"%").
		Find(&rows).Error; err != nil {
		return err
	}

	for _, r := range rows {
		parts := strings.Split(r.Groups, ",")
		kept := make([]string, 0, len(parts))
		for _, p := range parts {
			name := strings.TrimSpace(p)
			if name == "" {
				continue
			}
			if name == oldName {
				if newName == "" {
					continue
				}
				name = newName
			}
			kept = append(kept, name)
		}
		value := strings.Join(kept, ",")
		if err := tx.Model(&User{}).Where("id = ?", r.ID).
			Update(column, value).Error; err != nil {
			return err
		}
	}
	return nil
}
