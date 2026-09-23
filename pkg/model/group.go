package model

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 组来源：组或成员记录的来源。
const (
	GroupSourceLocal = "local" // created / managed in the console UI
	GroupSourceLDAP  = "ldap"  // synced from an LDAP directory
	GroupSourceOIDC  = "oidc"  // synced from an OIDC provider at login
)

// LocalGroup 把用户组作为一等实体持久化。组也可以隐式存在（被用户资料或角色授权引用），
// 但这里的一行记录能保证一个空组在创建后依然可见。同步/登录时发现的 LDAP/OIDC 组
// 也会 upsert 进来，这样无论来源是什么，每个组都能在本地被查询到。
type LocalGroup struct {
	ID          uint      `gorm:"primarykey" json:"id"`
	Name        string    `gorm:"uniqueIndex;size:128" json:"name"`
	Source      string    `gorm:"size:32;index;default:local" json:"source"`
	Description string    `gorm:"type:text" json:"description"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (LocalGroup) TableName() string { return "local_groups" }

// GroupMember 是组与用户之间规范化后的多对多关系。它镜像了
// users.oidc_groups 上那列反范式的逗号分隔列表（RBAC 热路径读的是它），
// 并由同一批写入路径保持同步，
// 从而为管理视图提供一个规范的关系型数据源。
type GroupMember struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	GroupName string    `gorm:"size:128;uniqueIndex:idx_group_member_unique" json:"groupName"`
	UserID    uint      `gorm:"index;uniqueIndex:idx_group_member_unique" json:"userId"`
	Source    string    `gorm:"size:32;default:local" json:"source"`
	CreatedAt time.Time `json:"createdAt"`
}

func (GroupMember) TableName() string { return "group_members" }

// CreateLocalGroup 插入一个新组，并强制名称唯一。
func CreateLocalGroup(name, description string) error {
	return DB.Create(&LocalGroup{
		Name:        name,
		Source:      GroupSourceLocal,
		Description: description,
	}).Error
}

// UpsertGroups 把给定的组名按给定来源持久化为实体。已存在的行保留其原始来源
// （先写者为准），这样手动创建的组不会被目录同步重新打标。
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
				// 唯一索引竞争失败：组已存在，这没问题。
				var exists int64
				if err2 := DB.Model(&LocalGroup{}).Where("name = ?", name).Count(&exists).Error; err2 != nil || exists == 0 {
					return err
				}
			}
		}
	}
	return nil
}

// ListLocalGroups 返回所有已持久化的组名。
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

// GroupInfo 描述一个用户组及其来源，供「用户组」页区分本地组与目录组。
type GroupInfo struct {
	Name        string `json:"name"`
	Source      string `json:"source"`      // local | ldap | oidc
	Description string `json:"description"` // 控制台本地备注，空串表示未填写
}

// ListGroupInfos 返回全部已知用户组及其来源。
//
// 来源以 local_groups.source 为准（控制台创建或目录同步时写入，首次写入者胜出）；
// 只有没有实体行的历史遗留组才退回成员关系来源，仍判断不出时按本地处理。
func ListGroupInfos() ([]GroupInfo, error) {
	names, err := ListKnownGroups()
	if err != nil {
		return nil, err
	}

	sources := make(map[string]string, len(names))
	descriptions := make(map[string]string, len(names))
	var persisted []LocalGroup
	if err := DB.Model(&LocalGroup{}).Find(&persisted).Error; err != nil {
		return nil, err
	}
	for _, g := range persisted {
		if name := strings.TrimSpace(g.Name); name != "" {
			sources[name] = g.Source
			if desc := strings.TrimSpace(g.Description); desc != "" {
				descriptions[name] = desc
			}
		}
	}

	var directoryRows []struct {
		GroupName string
		Source    string
	}
	if err := DB.Model(&GroupMember{}).
		Select("group_name, source").
		Where("source <> ?", GroupSourceLocal).
		Find(&directoryRows).Error; err != nil {
		return nil, err
	}
	for _, row := range directoryRows {
		if _, ok := sources[row.GroupName]; !ok {
			sources[row.GroupName] = row.Source
		}
	}

	infos := make([]GroupInfo, 0, len(names))
	for _, name := range names {
		source := sources[name]
		if source == "" {
			source = GroupSourceLocal
		}
		infos = append(infos, GroupInfo{
			Name:        name,
			Source:      source,
			Description: descriptions[name],
		})
	}
	return infos, nil
}

// LocalGroupSource 返回用户组的来源（local / ldap / oidc），与 ListGroupInfos 一致：
// 先看组实体行，没有实体行时回退到成员关系行的来源，都没有则按本地处理。
func LocalGroupSource(name string) (string, error) {
	name = strings.TrimSpace(name)
	var group LocalGroup
	err := DB.Where("name = ?", name).First(&group).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return "", err
	}
	if err == nil {
		if source := strings.TrimSpace(group.Source); source != "" {
			return source, nil
		}
		return GroupSourceLocal, nil
	}

	var directorySource string
	err = DB.Model(&GroupMember{}).
		Select("source").
		Where("group_name = ? AND source <> ?", name, GroupSourceLocal).
		Limit(1).
		Scan(&directorySource).Error
	if err != nil {
		return "", err
	}
	if source := strings.TrimSpace(directorySource); source != "" {
		return source, nil
	}
	return GroupSourceLocal, nil
}

// LocalGroupExists 报告该组是否已作为实体持久化。
func LocalGroupExists(name string) (bool, error) {
	var count int64
	err := DB.Model(&LocalGroup{}).Where("name = ?", name).Count(&count).Error
	return count > 0, err
}

// SetLocalGroupDescription 写入用户组的描述。
//
// 描述是控制台的本地备注：它不参与授权，也不参与目录同步（UpsertGroups 只补建缺失的
// 组，不覆盖已有行），所以目录组同样可以标注。组可能只有隐式来源（被用户配置或角色
// 授权引用而没有任何实体行），此时按已知来源补建实体行，否则描述无处存放。
func SetLocalGroupDescription(name, description string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return gorm.ErrRecordNotFound
	}

	res := DB.Model(&LocalGroup{}).Where("name = ?", name).
		Update("description", description)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected > 0 {
		return nil
	}

	source, err := LocalGroupSource(name)
	if err != nil {
		return err
	}
	if err := DB.Create(&LocalGroup{
		Name:        name,
		Source:      source,
		Description: description,
	}).Error; err != nil {
		// 并发下可能刚被另一个请求补建，退回更新。
		if !IsUniqueConstraintError(err) {
			return err
		}
		return DB.Model(&LocalGroup{}).Where("name = ?", name).
			Update("description", description).Error
	}
	return nil
}

// SyncUserGroupMembership 把用户的规范化成员关系**完全替换**为给定列表（本地语义）：
// 本地账号编辑用户、管理员一次提交完整组列表时使用。
//
// 目录同步不要用这个函数：它会把管理员加的「本地附加组」一起删掉，
// 请用 SyncDirectoryGroupMembership。
func SyncUserGroupMembership(userID uint, groups []string, source string) error {
	cleaned := cleanGroupNames(groups)

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

// SyncDirectoryGroupMembership 写回**目录**带来的成员关系（LDAP 同步 / OIDC 登录）：
//
//   - 只替换目录来源的行，保留管理员在控制台加的「本地附加组」（source = local）；
//   - 目录也给了同名组时以目录为准：该行被升级成目录来源（一个用户一个组只能有一行，
//     所以两个来源不能共存）；
//   - 返回并集（目录组 ∪ 其余本地附加组），并把它写回 users.oidc_groups
//     （RBAC 热路径读这一列），调用方用返回值同步内存里的用户对象即可。
func SyncDirectoryGroupMembership(userID uint, directoryGroups []string, source string) ([]string, error) {
	cleaned := cleanGroupNames(directoryGroups)

	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ? AND source = ?", userID, source).Delete(&GroupMember{}).Error; err != nil {
			return err
		}
		for _, name := range cleaned {
			// 唯一的本地附加行会被更新为目录来源（目录优先）。
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "group_name"}, {Name: "user_id"}},
				DoUpdates: clause.Assignments(map[string]interface{}{"source": source}),
			}).Create(&GroupMember{GroupName: name, UserID: userID, Source: source}).Error; err != nil {
				return err
			}
		}
		return UpsertGroupsWithTx(tx, cleaned, source)
	})
	if err != nil {
		return nil, err
	}
	// RBAC 热路径读的是 users.oidc_groups，这里一并刷新，不让调用方“记得写回”才能生效。
	if err := refreshEffectiveGroupColumn(DB, userID); err != nil {
		return nil, err
	}
	return effectiveGroupNamesForUser(DB, userID)
}

// cleanGroupNames 去空白、去空项并去重，保持出现顺序。
func cleanGroupNames(groups []string) []string {
	return mergeGroupNames(groups, nil)
}

// ListLocalGroupMemberships 返回用户「本地附加」的组名（source = local）。
func ListLocalGroupMemberships(userID uint) ([]string, error) {
	var names []string
	err := DB.Model(&GroupMember{}).
		Where("user_id = ? AND source = ?", userID, GroupSourceLocal).
		Order("group_name asc").
		Pluck("group_name", &names).Error
	return names, err
}

// IsLocalGroupMember 报告该用户在这个组上的成员关系是否为**本地附加**。
func IsLocalGroupMember(userID uint, groupName string) (bool, error) {
	var count int64
	err := DB.Model(&GroupMember{}).
		Where("user_id = ? AND group_name = ? AND source = ?", userID, strings.TrimSpace(groupName), GroupSourceLocal).
		Count(&count).Error
	return count > 0, err
}

// IsGroupMember 报告该用户与这个组是否存在成员关系（不分来源）。
// 与 IsLocalGroupMember 配合，可以把「不是成员」和「成员关系由目录管辖」区分开。
func IsGroupMember(userID uint, groupName string) (bool, error) {
	var count int64
	err := DB.Model(&GroupMember{}).
		Where("user_id = ? AND group_name = ?", userID, strings.TrimSpace(groupName)).
		Count(&count).Error
	return count > 0, err
}

// DirectoryGroupMemberships 返回用户由目录（LDAP / OIDC）带来的组名。
func DirectoryGroupMemberships(userID uint) ([]string, error) {
	var names []string
	err := DB.Model(&GroupMember{}).
		Where("user_id = ? AND source <> ?", userID, GroupSourceLocal).
		Order("group_name asc").
		Pluck("group_name", &names).Error
	return names, err
}

// mergeGroupNames 合并两组组名：保留前半部分的顺序，后半部分按出现顺序追加去重。
func mergeGroupNames(primary, extra []string) []string {
	merged := make([]string, 0, len(primary)+len(extra))
	seen := make(map[string]struct{}, len(primary)+len(extra))
	for _, list := range [][]string{primary, extra} {
		for _, raw := range list {
			name := strings.TrimSpace(raw)
			if name == "" {
				continue
			}
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			merged = append(merged, name)
		}
	}
	return merged
}

// effectiveGroupNamesForUser 由成员关系行推出用户的有效组列表：目录组在前，本地附加组在后。
//
// RBAC 热路径读的是 users.oidc_groups，所以任何成员关系变更后都要用它重算这一列。
func effectiveGroupNamesForUser(tx *gorm.DB, userID uint) ([]string, error) {
	var rows []GroupMember
	if err := tx.Where("user_id = ?", userID).
		Order("group_name asc").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	directoryNames := make([]string, 0, len(rows))
	localNames := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.Source == GroupSourceLocal {
			localNames = append(localNames, row.GroupName)
			continue
		}
		directoryNames = append(directoryNames, row.GroupName)
	}
	return mergeGroupNames(directoryNames, localNames), nil
}

// AddLocalGroupMember 把用户加入一个用户组，并记为**本地附加**成员关系
// （source = local）：目录同步不会移除它，用户可以因此获得绑定在该组上的角色。
//
// 本地账号（provider = password）的成员关系本来就只有本地来源，走同一条路径。
func AddLocalGroupMember(userID uint, groupName string) error {
	name := strings.TrimSpace(groupName)
	if name == "" {
		return errors.New("group name is empty")
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&GroupMember{}).
			Where("user_id = ? AND group_name = ?", userID, name).
			Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			if err := tx.Create(&GroupMember{
				GroupName: name, UserID: userID, Source: GroupSourceLocal,
			}).Error; err != nil {
				return err
			}
		}
		if err := UpsertGroupsWithTx(tx, []string{name}, GroupSourceLocal); err != nil {
			return err
		}
		return refreshEffectiveGroupColumn(tx, userID)
	})
}

// RemoveLocalGroupMember 移除一条**本地附加**成员关系。目录带来的成员关系不受影响
// （它由目录同步负责）。
func RemoveLocalGroupMember(userID uint, groupName string) error {
	name := strings.TrimSpace(groupName)
	if name == "" {
		return errors.New("group name is empty")
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ? AND group_name = ? AND source = ?", userID, name, GroupSourceLocal).
			Delete(&GroupMember{}).Error; err != nil {
			return err
		}
		return refreshEffectiveGroupColumn(tx, userID)
	})
}

// refreshEffectiveGroupColumn 重算并写回 users.oidc_groups（= 目录组 ∪ 本地附加组）。
//
// 这是鉴权热路径读的列，所以成员关系一变就要重算：只改 group_members 会让权限不生效，
// 只改列又会让规范化视图漂移。
func refreshEffectiveGroupColumn(tx *gorm.DB, userID uint) error {
	column, err := userGroupsColumn()
	if err != nil {
		return err
	}
	effective, err := effectiveGroupNamesForUser(tx, userID)
	if err != nil {
		return err
	}
	return tx.Model(&User{}).Where("id = ?", userID).
		Update(column, strings.Join(effective, ",")).Error
}

// UpsertGroupsWithTx 是在已有事务中执行的 UpsertGroups。
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

// GroupMemberInfo 是成员关系行联上用户基本信息的结构。
type GroupMemberInfo struct {
	Username string `json:"username"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Source   string `json:"source"`
}

// ListGroupMembers 从规范化的成员关系表返回某个组的成员，
// 并关联用户基本信息以便展示。
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

// ListGroupMembersMap 返回规范化成员关系表中每个组的 组名 -> 成员用户名 映射。
// 权限绑定组列表用它来展示某个组主体及其覆盖的用户。
func ListGroupMembersMap() (map[string][]string, error) {
	var rows []struct {
		GroupName string
		Username  string
	}
	err := DB.Table("group_members").
		Select("group_members.group_name AS group_name, users.username AS username").
		Joins("JOIN users ON users.id = group_members.user_id").
		Order("group_members.group_name asc, users.username asc").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	result := make(map[string][]string)
	for _, row := range rows {
		result[row.GroupName] = append(result[row.GroupName], row.Username)
	}
	return result, nil
}

// RenameLocalGroup 原子地重命名组实体以及它的每一处引用：用户资料上的
// 逗号分隔组列表、规范化的成员关系行，以及以组为主体的角色授权。
// 用户资料列表采用精确匹配，因此前缀重叠的组
// （dev / devops）不会被混淆。
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

// DeleteLocalGroup 删除组实体并清理它的每一处引用：
// 成员关系（规范化行与用户资料列表）以及以组为主体的角色授权。
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

// rewriteGroupOnUsers 重写每个用户资料的组列，把 oldName 替换为 newName
// （newName 为空时即删除该项）。替换在解析后的列表上进行，
// 因此名称相近的组之间不可能出现子串误替换。
func rewriteGroupOnUsers(tx *gorm.DB, oldName, newName string) error {
	column, err := userGroupsColumn()
	if err != nil {
		return err
	}

	type row struct {
		ID     uint   `gorm:"column:id"`
		Groups string `gorm:"column:group_list"`
	}
	var rows []row
	// 列名与别名都不能直接拼进 SQL：users 的组列在历史库上就叫 groups，而 GROUPS 是 MySQL 8 的
	// 保留字（5.7 不是，SQLite / PostgreSQL 也不是），裸写会报 1064。这里交给 clause 让 GORM 按
	// 方言加引号，别名也换成非保留字的 group_list。
	// 注意用 Clauses 而不是 Select(clause.Expr{...})：GORM v1.31 的 Select 只接受 string /
	// []string，传 clause.Expression 会直接报 "unsupported select args"。
	selectClause := clause.Select{
		Expression: clause.Expr{
			SQL: "id, ? AS ?",
			Vars: []interface{}{
				clause.Column{Name: column},
				clause.Column{Name: "group_list"},
			},
			WithoutParentheses: true,
		},
	}
	if err := tx.Model(&User{}).
		Clauses(selectClause).
		Where(PatternLike(clause.Column{Name: column}, "%"+oldName+"%")).
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
