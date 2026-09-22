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
	Username string `json:"username" gorm:"type:varchar(50);uniqueIndex;not null"`
	Password string `json:"-" gorm:"type:varchar(255)"`
	Name     string `json:"name,omitempty" gorm:"type:varchar(100);index"`
	// Email 用于接收通知。当身份提供方暴露了 email 声明时从 OIDC 声明中填充，
	// 也可以由管理员设置。
	Email string `json:"email,omitempty" gorm:"type:varchar(255);index"`
	// Phone / Remark 是可选的联系方式。
	Phone  string `json:"phone,omitempty" gorm:"type:varchar(50)"`
	Remark string `json:"remark,omitempty" gorm:"type:text"`
	// ExpiresAt 一旦超过该时间，账号会被自动停用（nil 表示永不过期）。
	// 时间列一律用 GORM 默认的 datetime(3)（同 CreatedAt），不要退回 MySQL 的 timestamp：
	// timestamp 有 2038 上限，且会按会话 time_zone 二次换算，同一行在不同时区/副本下
	// 会读出不同的时刻。DisabledAt / LastLoginAt 同理。
	ExpiresAt *time.Time `json:"expiresAt,omitempty" gorm:"index"`
	// DisabledReason / DisabledAt 描述账号被停用的原因与时间。
	// 值为 "inactive" 表示由「不活跃用户自动禁用」任务关闭；手动禁用时为空。
	DisabledReason string     `json:"disabledReason,omitempty" gorm:"type:varchar(50)"`
	DisabledAt     *time.Time `json:"disabledAt,omitempty"`
	// MFADisabled 为创建时选择的「MFA 级别：禁用」，true 表示不受全局策略强制。
	MFADisabled bool        `json:"mfaDisabled,omitempty" gorm:"type:boolean;default:false"`
	AvatarURL   string      `json:"avatar_url,omitempty" gorm:"type:text"`
	Provider    string      `json:"provider,omitempty" gorm:"type:varchar(50);default:password;index"`
	OIDCGroups  SliceString `json:"oidc_groups,omitempty" gorm:"type:text"`
	LastLoginAt *time.Time  `json:"lastLoginAt,omitempty" gorm:"index"`
	Enabled     bool        `json:"enabled" gorm:"type:boolean;default:true"`
	// IsSuperAdmin 标记初始化时创建的超级管理员账号（初始化向导 / 配置文件创建），
	// 用于初始超级管理员的身份识别与保护。通过权限绑定组持有超级角色的用户同样
	// 被视为超级管理员（见 isGuardedSuperAdmin）。
	IsSuperAdmin    bool         `json:"isSuperAdmin,omitempty" gorm:"type:boolean;not null;default:false;index"`
	PendingDeletion bool         `json:"pendingDeletion,omitempty" gorm:"type:boolean;not null;default:false;index"`
	Sub             string       `json:"sub,omitempty" gorm:"type:varchar(255);index"`
	MFAEnabled      bool         `json:"mfa_enabled" gorm:"column:mfa_enabled;type:boolean;not null;default:false"`
	MFASecret       SecretString `json:"-" gorm:"column:mfa_secret;type:text"`
	// MFARequired 由当前请求的安全策略推导得出，
	// 从不落库。
	MFARequired bool `json:"mfa_required,omitempty" gorm:"-"`
	// PasswordUpdatedAt 供密码过期策略使用。
	PasswordUpdatedAt *time.Time `json:"password_updated_at,omitempty" gorm:"column:password_updated_at"`

	APIKey SecretString  `json:"apiKey,omitempty" gorm:"type:text"`
	Roles  []common.Role `json:"roles,omitempty" gorm:"-"`
	// NamespaceScopedRoles 是命名空间级权限绑定组带来的角色（含组内集群与命名空间范围），
	// 只下发给前端做权限判定，不落库、也不参与后端授权（后端按 CanAccess 判定）。
	// 单独成列而不并入 Roles：并入会让 IsAdministrator 把「只在某个命名空间里绑定了
	// admin 角色」的账号也算成管理员。
	NamespaceScopedRoles []common.Role `json:"namespaceScopedRoles,omitempty" gorm:"-"`

	SidebarPreference string `json:"sidebar_preference,omitempty" gorm:"type:text"`
}

// MigrateDropUserWechatColumn 删除 User 表上遗留的 wechat 列：微信登录已下线、
// Wechat 字段已从结构体移除，而 AutoMigrate 只加列不删列，所以启动时显式清理一次。
// 先探测列是否存在，既保证可重复执行，也保证全新库（本就没有该列）能正常通过。
func MigrateDropUserWechatColumn() error {
	migrator := DB.Migrator()
	if !migrator.HasColumn(&User{}, "wechat") {
		return nil
	}
	return migrator.DropColumn(&User{}, "wechat")
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

// APIKeyPrefix 是 API key 的当前前缀（GetAPIKey 生成 `aerolink<id>-<secret>`）。
const APIKeyPrefix = "aerolink"

// legacyAPIKeyPrefix 是改名前的旧前缀。已签发的 key 仍是 `kite<id>-<secret>`，
// 改名不能硬切——不认旧前缀会让所有存量 key 当场失效（集群 Agent、脚本、CI 都在用）。
const legacyAPIKeyPrefix = "kite"

// APIKeyToken 从 Authorization 头的值里剥掉前缀，返回 `<id>-<secret>`。
//
// 新旧前缀都认；两种都不匹配时返回 false，由调用方拒绝（fail-closed，
// 不匹配的串并不是 key，不能当成 key 往库里查）。
func APIKeyToken(authHeader string) (string, bool) {
	if after, ok := strings.CutPrefix(authHeader, APIKeyPrefix); ok {
		return after, true
	}
	after, ok := strings.CutPrefix(authHeader, legacyAPIKeyPrefix)
	if !ok {
		return "", false
	}
	return after, true
}

func (u *User) GetAPIKey() string {
	return fmt.Sprintf("%s%d-%s", APIKeyPrefix, u.ID, string(u.APIKey))
}

func AddUser(user *User) error {
	// 入库前先对密码做哈希
	hash, err := utils.HashPassword(user.Password)
	if err != nil {
		return err
	}
	user.Password = hash
	now := time.Now()
	user.PasswordUpdatedAt = &now
	if err := DB.Create(user).Error; err != nil {
		return err
	}
	return RecordPasswordHistory(user.ID, hash)
}

func CountUsers() (count int64, err error) {
	return count, DB.Model(&User{}).Count(&count).Error
}

// userCache 是一个带 30 秒 TTL 的线程安全 LRU。
// 省掉 RequireAuth 中每次请求都做的 SELECT（约 1-5ms → 约 50ns）。
// 容量 256 对于 K8s 控制台的用户规模来说足够宽裕。
var userCache = expirable.NewLRU[uint64, *User](256, nil, 30*time.Second)

// GetUserByIDCached 优先从缓存返回用户，否则从数据库读取并写回缓存，
// 用在鉴权的热路径上。
func GetUserByIDCached(id uint64) (*User, error) {
	if u, ok := userCache.Get(id); ok {
		// 返回浅拷贝，这样调用方（RequireAuth 等）可以安全地
		// 修改 Roles 之类的字段，而不会在缓存指针上产生竞争。
		copy := *u
		return &copy, nil
	}
	u, err := GetUserByID(id)
	if err != nil {
		return nil, err
	}
	userCache.Add(id, u)
	// 未命中路径同样返回拷贝，以保证缓存条目不可变。
	copy := *u
	return &copy, nil
}

// InvalidateUserCache 从鉴权缓存中移除某个用户。
// 每次变更成功后调用，使与安全相关的改动（停用、删除、重置密码）
// 在下一次鉴权检查时就生效。
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

// ErrUserNotProvisioned 在启用「仅存在用户登录」时表示该身份没有可用的本地账号：
// 既没有绑定该 sub 的账号，也没有同名的账号可以绑定。
var ErrUserNotProvisioned = errors.New("no local account is provisioned for this identity")

// FindWithSubOrUpsertUser 按身份源的 sub 找到账号并写回身份源带来的字段。
//
// rejectUnknown 对应「安全设置 → 仅存在用户登录」：
//   - false（默认）：sub 与用户名都匹配不到时自动建号。
//   - true：只允许本地已存在的账号登录。sub 未命中但用户名命中时，把这次登录的 sub
//     绑到那个账号上（这是「预先开通」的路径）；两边都命中不到则返回
//     ErrUserNotProvisioned。
func FindWithSubOrUpsertUser(user *User, rejectUnknown bool) error {
	if user.Sub == "" {
		return errors.New("user sub is empty")
	}
	var existingUser User
	now := time.Now()
	user.LastLoginAt = &now

	lookupErr := DB.Where("sub = ?", user.Sub).First(&existingUser).Error
	if errors.Is(lookupErr, gorm.ErrRecordNotFound) && rejectUnknown {
		// sub 只有首次登录才会出现，所以「预先开通」只能按用户名匹配：
		// 命中就把这次登录的 sub 绑到这个账号上（见下方注释）。
		lookupErr = DB.Where("username = ?", user.Username).First(&existingUser).Error
	}
	if lookupErr != nil {
		if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
			return lookupErr
		}
		if rejectUnknown {
			return ErrUserNotProvisioned
		}
		if err := DB.Create(user).Error; err != nil {
			if !isUniqueConstraintError(err) {
				return err
			}
			// 该用户名已被来自其它来源的记录占用
			// （本地密码、LDAP 或另一个 OIDC 提供方）。本地记录配置的来源保持权威——
			// 绝不抢占。
			return ErrUserProviderConflict
		}
		syncDirectoryGroupsAfterUserWrite(user.ID, user.OIDCGroups, groupSourceForProvider(user.Provider))
		return nil
	}
	if rejectUnknown && existingUser.Sub != user.Sub {
		// 按用户名命中、且不是同一个 sub 的情况，即「预先开通」的账号首次绑身份源。
		//
		// 初始超级管理员是应急入口，不允许被身份源认领：它的来源变更会让本地应急
		// 口令失效，而这是管理面最后的入口。
		if isGuardedSuperAdmin(existingUser) {
			return ErrUserProviderConflict
		}
	}
	// 已存在的账号：以库里的那一行为准，只把身份源管辖的字段覆盖上去。
	//
	// 这里原本是整行 Save，而 user 只填了 IdP 提供的字段、其余全是零值，于是每次
	// 登录都会把管理员维护的字段抹掉：有效期 ExpiresAt、备注、手机号、邮箱、
	// 初始超管标记 IsSuperAdmin、MFA 级别 MFADisabled。Enabled 当时被显式保住了，
	// 但只保这一个不够。
	//
	// 以库里行为基还有个作用：调用方拿到的 user 带着真实的启用/有效期状态，
	// 登录判定不会因为零值而误判。
	incomingProvider := user.Provider
	directoryGroups := user.OIDCGroups
	directoryUsername := user.Username
	directoryName := user.Name
	directoryAvatarURL := user.AvatarURL
	directorySub := user.Sub

	*user = existingUser
	user.Provider = incomingProvider
	user.Sub = directorySub
	user.Username = directoryUsername
	user.Name = directoryName
	user.AvatarURL = directoryAvatarURL
	user.LastLoginAt = &now

	// 目录只提供它自己的组；管理员在控制台给这个账号加的「本地附加组」必须保留，
	// 否则每次登录都会把本地授权冲掉。写回并集，让 users.oidc_groups 与成员关系表一致。
	if _, err := SyncDirectoryGroupMembership(
		existingUser.ID, directoryGroups, groupSourceForProvider(incomingProvider)); err != nil {
		return err
	}
	// users.oidc_groups 已由上一步刷新，这里只写身份源真正管辖的列。
	err := DB.Model(&User{}).Where("id = ?", existingUser.ID).Updates(map[string]interface{}{
		"provider":      user.Provider,
		"sub":           user.Sub,
		"username":      user.Username,
		"name":          user.Name,
		"avatar_url":    user.AvatarURL,
		"last_login_at": user.LastLoginAt,
	}).Error
	InvalidateUserCache(uint64(user.ID))
	return err
}

// groupSourceForProvider 把登录提供方映射到 group / group_member 行上记录的组来源。
//
// 本地账号（provider = password / 空）返回 local：它们的成员关系完全由控制台维护，
// 而空操作集合的全量替换语义（编辑用户时提交完整列表）只对 local 来源成立。
func groupSourceForProvider(provider string) string {
	switch provider {
	case AuthProviderLDAP:
		return GroupSourceLDAP
	case "", AuthProviderPassword:
		return GroupSourceLocal
	default:
		// 其余都是外部身份源（OIDC / 第三方 provider 名）。
		return GroupSourceOIDC
	}
}

// syncGroupsAfterUserWrite 把用户的完整组列表镜像到
// 规范化的 group_members 表（本地语义：该列表即权威）。
// 尽力而为：绝不阻塞登录/同步流程。
func syncGroupsAfterUserWrite(userID uint, groups SliceString, source string) {
	if err := SyncUserGroupMembership(userID, groups, source); err != nil {
		klog.Warningf("failed to sync group membership for user %d: %v", userID, err)
	}
}

// syncDirectoryGroupsAfterUserWrite 写回目录带来的成员关系：目录组替换目录来源的行，
// 管理员在控制台加的「本地附加组」保留，并集由 SyncDirectoryGroupMembership 写回
// users.oidc_groups。Best-effort，不阻塞登录/同步流程。
func syncDirectoryGroupsAfterUserWrite(userID uint, groups SliceString, source string) {
	if _, err := SyncDirectoryGroupMembership(userID, groups, source); err != nil {
		klog.Warningf("failed to sync directory group membership for user %d: %v", userID, err)
	}
}

func GetUserByUsername(username string) (*User, error) {
	var user User
	if err := DB.Where("username = ?", username).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

// UserListQuery 是 ListUsers 的查询条件，零值表示不施加该条件。
type UserListQuery struct {
	Limit  int
	Offset int
	Search string
	// SortBy / SortOrder 只接受白名单内的取值，见 ListUsers。
	SortBy    string
	SortOrder string
	// Role 只看拥有该 RBAC 角色的用户。
	Role string
	// Enabled 取 "true" / "false" 时按启用状态过滤，其它取值不过滤。
	Enabled string
	// Provider 按认证方式来过滤（password / ldap / OAuth 提供方名称）。
	Provider string
	// Group 按用户所属的 LDAP / OIDC 用户组名过滤。
	Group string
}

// ListUsers 分页返回用户。limit 为 0 时默认为 20。
func ListUsers(q UserListQuery) (users []User, total int64, err error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	query := DB.Model(&User{}).Where("users.provider != ?", common.APIKeyProvider)
	if q.Role != "" {
		query = query.Joins(
			"JOIN role_assignments ra ON ra.subject = users.username AND ra.subject_type = ?",
			SubjectTypeUser,
		).Joins("JOIN roles r ON r.id = ra.role_id").Where("r.name = ?", q.Role)
	}
	if q.Search != "" {
		likeQuery := "%" + q.Search + "%"
		query = query.Where(
			"users.username LIKE ? OR users.name LIKE ?",
			likeQuery,
			likeQuery,
		)
	}
	if q.Enabled == "true" || q.Enabled == "false" {
		query = query.Where("users.enabled = ?", q.Enabled == "true")
	}
	if q.Provider != "" {
		query = query.Where("users.provider = ?", q.Provider)
	}
	if q.Group != "" {
		// oidc_groups 是逗号分隔的文本列（见 SliceString），列名要用 userGroupsColumn 解析，
		// 因为 GORM 对 OIDCGroups 生成的列名与历史部署里存在的列名可能不一致。
		// 用首尾分隔符做元素级匹配，避免 LIKE '%name%' 把 superadmin 也算成 admin。
		column, columnErr := userGroupsColumn()
		if columnErr != nil {
			return nil, 0, columnErr
		}
		query = query.Where(
			fmt.Sprintf(
				"users.%s = ? OR users.%s LIKE ? OR users.%s LIKE ? OR users.%s LIKE ?",
				column, column, column, column,
			),
			q.Group, q.Group+",%", "%,"+q.Group, "%,"+q.Group+",%",
		)
	}
	countQuery := query.Select("users.id").Distinct("users.id")
	err = DB.Table("(?) as sub", countQuery).Count(&total).Error
	if err != nil {
		return nil, 0, err
	}
	sortOrder := q.SortOrder
	if sortOrder != "asc" && sortOrder != "desc" {
		sortOrder = "desc"
	}
	allowedSorts := map[string]string{
		"id":          "users.id",
		"username":    "users.username",
		"createdAt":   "users.created_at",
		"lastLoginAt": "users.last_login_at",
	}
	sortColumn, ok := allowedSorts[q.SortBy]
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
		Offset(q.Offset)
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

// DeleteUserByID 按 ID 删除用户
func DeleteUserByID(id uint) error {
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		return err
	}
	// 超级管理员是系统的初始 / 应急入口：它不可删除，只能停用（停用另有兜底，见
	// ensureAdministratorRemains）。
	if err := ensureDeletable(user); err != nil {
		return err
	}
	// 不删除该用户的历史审计记录（等保三级安全审计）：只把操作者引用置空，
	// 用户名由 OperatorName 快照保留。这里显式 UPDATE，不依赖外键的
	// ON DELETE SET NULL：SQLite 的 PRAGMA foreign_keys 只在单个连接上生效，
	// 连接池下并不可靠（见 pkg/bindinggroups/handler.go 的同类说明）。
	if err := DB.Model(&ResourceHistory{}).
		Where("operator_id = ?", id).
		Update("operator_id", nil).Error; err != nil {
		return err
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := tx.Select("username").First(&user, id).Error; err != nil {
			return err
		}
		// 直接分配的角色：
		if err := tx.Where("subject_type = ? AND subject = ?", SubjectTypeUser, user.Username).Delete(&RoleAssignment{}).Error; err != nil {
			return err
		}
		// 权限绑定组成员按用户名存、规范化组成员关系按 user_id 存：不清理就会留下指向
		// 不存在账号的行，同一用户名被重新创建时会静默继承这些授权（尤其是受保护成员
		// 在「超级权限绑定」里绑定的最高权限角色）。
		if err := tx.Where("subject_type = ? AND subject = ?", SubjectTypeUser, user.Username).Delete(&BindingGroupMember{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&GroupMember{}).Error; err != nil {
			return err
		}
		return tx.Delete(&User{}, id).Error
	})
	InvalidateUserCache(uint64(id))
	return err
}

// ErrSuperAdminNotDeletable 是删除超级管理员账号时的拒绝原因。
//
// 这个账号是系统的初始 / 应急入口：删除会让它从界面上彻底消失（而不是“回收”），
// 事后只能改库重建；需要收回它的访问权请用**停用**（有兜底保证还有人能接管）。
var ErrSuperAdminNotDeletable = errors.New("the built-in super administrator cannot be deleted; disable the account instead")

// ErrLastAdministrator 是操作后系统里将不再有任何启用账号持有系统管理员角色时的拒绝原因：
// 管理面将无人能接管，而恢复入口本身又需要管理权限，只能改库恢复。
var ErrLastAdministrator = errors.New("cannot leave the console without an administrator: no other enabled account holds the administrator role; grant the administrator role to another enabled account first")

// ensureDeletable 拒绝删除超级管理员账号；其余账号沿用「删掉后仍要有系统管理员」的保护。
func ensureDeletable(user User) error {
	if isGuardedSuperAdmin(user) {
		return ErrSuperAdminNotDeletable
	}
	return ensureAdministratorRemains(user)
}

// ensureAdministratorRemains 保证停用 / 删除账号之后系统里仍有别的启用账号持有系统管理员
// 角色（见 enabledAdministrators）。
//
// 被操作的账号自己不是「当前在管的管理员」时不做限制：去掉一个普通账号（或一个已经
// 停用、离管的账号）不会改变“谁能接管管理面”。
//
// 口径刻意窄：只认最高权限角色，**安全管理员 / 审计管理员不算**——他们只能打开自己的页面，
// 接手不了系统管理员的职责（例如集群配置）。
func ensureAdministratorRemains(user User) error {
	administrators, err := enabledAdministrators()
	if err != nil {
		return err
	}
	if _, isAdministrator := administrators[user.Key()]; !isAdministrator {
		return nil
	}
	if len(administrators) > 1 {
		return nil
	}
	return ErrLastAdministrator
}

// isGuardedSuperAdmin 判断账号是否为超级管理员意义上的初始 / 应急入口：初始化创建的
// 标记账号，或受保护权限绑定组（「超级权限绑定」）的成员。
//
// 代次 3 起不再看「是否持有超级角色」：超级角色已并入系统管理员，普通系统管理员
// （只直接持有 admin）不应该被当成受保护的初始账号。
func isGuardedSuperAdmin(user User) bool {
	return user.IsSuperAdmin || isProtectedBindingGroupMember(user.Username)
}

// roleSubjectRow 是一条「主体 → 角色」的授权来源（角色分配或权限绑定组成员）。
type roleSubjectRow struct {
	SubjectType string
	Subject     string
	RoleID      uint
}

// enabledAdministrators 返回当前**启用**、且当前确实在管（未被职责分离拒绝）的系统管理员
// 账号集合（键为 `User.Key()`，即用户名）。
//
// 口径刻意窄：只认最高权限角色（`DefaultAdminRole`），不认「能进管理面的任一角色」——
// 安全管理员 / 审计管理员只能打开自己的页面，接手不了系统管理员的职责。
//
// 授权来源包括直接分配、所属用户组、以及权限绑定组——但只有**全局作用域**的权限绑定
// 组算数（与 rbac.effectiveRoles 一致）。
//
// 职责分离冲突的账号会被管理面整体拒绝（见 rbac.SeparationOfDutiesConflict），因此
// 不能计入：把它算进来等于放行一次真实的锁定。
func enabledAdministrators() (map[string]struct{}, error) {
	administrators := make(map[string]struct{})

	adminRole, err := GetRoleByName(DefaultAdminRole.Name)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// 系统角色还未播种：没有任何账号能持有它。
			return administrators, nil
		}
		return nil, err
	}

	var roles []Role
	if err := DB.Find(&roles).Error; err != nil {
		return nil, err
	}
	roleByID := make(map[uint]Role, len(roles))
	for _, role := range roles {
		roleByID[role.ID] = role
	}

	var users []User
	if err := DB.Where("enabled = ?", true).Find(&users).Error; err != nil {
		return nil, err
	}
	if len(users) == 0 {
		return administrators, nil
	}

	assignments, err := roleSubjectRows(func(query *gorm.DB) *gorm.DB {
		return query.Model(&RoleAssignment{}).Select("subject_type, subject, role_id")
	})
	if err != nil {
		return nil, err
	}
	directRoles := make(map[string][]uint)
	groupRoles := make(map[string][]uint)
	for _, row := range assignments {
		if row.SubjectType == SubjectTypeGroup {
			groupRoles[row.Subject] = append(groupRoles[row.Subject], row.RoleID)
			continue
		}
		directRoles[row.Subject] = append(directRoles[row.Subject], row.RoleID)
	}

	bindingRows, err := roleSubjectRows(func(query *gorm.DB) *gorm.DB {
		return query.Table("binding_group_members AS m").
			Select("m.subject_type AS subject_type, m.subject AS subject, m.role_id AS role_id").
			Joins("JOIN binding_groups AS g ON g.id = m.project_id").
			Where("g.detached = ? AND g.global = ?", false, true)
	})
	if err != nil {
		return nil, err
	}
	for _, row := range bindingRows {
		if row.SubjectType == SubjectTypeGroup {
			groupRoles[row.Subject] = append(groupRoles[row.Subject], row.RoleID)
			continue
		}
		directRoles[row.Subject] = append(directRoles[row.Subject], row.RoleID)
	}

	for _, user := range users {
		held := make(map[uint]struct{})
		for _, roleID := range directRoles[user.Key()] {
			held[roleID] = struct{}{}
		}
		for _, group := range user.OIDCGroups {
			for _, roleID := range groupRoles[group] {
				held[roleID] = struct{}{}
			}
		}
		if _, ok := held[adminRole.ID]; !ok {
			continue
		}
		if holdsMutuallyExclusiveRoles(held, roleByID) {
			continue
		}
		administrators[user.Key()] = struct{}{}
	}
	return administrators, nil
}

func roleSubjectRows(build func(*gorm.DB) *gorm.DB) ([]roleSubjectRow, error) {
	var rows []roleSubjectRow
	err := build(DB).Scan(&rows).Error
	return rows, err
}

// holdsMutuallyExclusiveRoles 对应 rbac.mutualExclusionConflict：同一个互斥组中的
// 两个或多个角色绝不能同时挂在同一个账号上。
func holdsMutuallyExclusiveRoles(held map[uint]struct{}, roleByID map[uint]Role) bool {
	names := make(map[string]struct{}, len(held))
	for roleID := range held {
		if role, ok := roleByID[roleID]; ok {
			names[role.Name] = struct{}{}
		}
	}
	for _, group := range MutuallyExclusiveRoleGroups {
		count := 0
		for _, name := range group {
			if _, ok := names[name]; ok {
				count++
			}
		}
		if count > 1 {
			return true
		}
	}
	return false
}

// UpdateUser 保存传入的用户（要求已设置 ID）
func UpdateUser(user *User) error {
	err := DB.Save(user).Error
	if err == nil && groupSourceForProvider(user.Provider) == GroupSourceLocal {
		// 只有本地账号用「完整列表替换」语义。目录账号的成员关系由目录同步维护，
		// 在这里全量替换会把管理员加的「本地附加组」的来源标记冲成目录来源。
		syncGroupsAfterUserWrite(user.ID, user.OIDCGroups, GroupSourceLocal)
	}
	InvalidateUserCache(uint64(user.ID))
	return err
}

// ResetPasswordByID 为给定 ID 的用户设置新密码（哈希后存储）。
// operatorID/operatorName 标识是谁执行了这次变更（用户本人或管理员）；
// source 取 PasswordChangeSourceSelf 或
// PasswordChangeSourceAdmin。
func ResetPasswordByID(id uint, plainPassword string, operatorID uint, operatorName, source string) error {
	var u User
	if err := DB.First(&u, id).Error; err != nil {
		return err
	}
	hash, err := utils.HashPassword(plainPassword)
	if err != nil {
		return err
	}
	u.Password = hash
	now := time.Now()
	u.PasswordUpdatedAt = &now
	if err := DB.Save(&u).Error; err != nil {
		return err
	}
	InvalidateUserCache(uint64(id))
	if err := RecordPasswordHistory(id, hash); err != nil {
		return err
	}
	RecordPasswordChange(id, u.Username, operatorID, operatorName, source)
	return nil
}

// IsExpired 报告账号是否已过有效期（ExpiresAt 为空表示永不过期）。
//
// 登录与鉴权路径据此立即拒绝过期账号；每日任务另会把它们停用，
// 这样停用原因与时间会留在用户记录上（见 notification.checkExpiredUsers）。
func (u User) IsExpired(now time.Time) bool {
	return u.ExpiresAt != nil && !u.ExpiresAt.After(now)
}

// SetUserEnabled 更新启用标记。重新启用一个 LDAP 用户会取消
// 待执行的延迟删除（管理员在 LDAP 同步真正删除记录之前改变了主意）。
func SetUserEnabled(id uint, enabled bool) error {
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		return err
	}
	if !enabled {
		// 停用同样要保证有人能接管管理面（见 ensureAdministratorRemains）：超级管理员
		// 可以停用，但前提是还有别的启用账号持有系统管理员角色。删除则永远是禁止的。
		if err := ensureAdministratorRemains(user); err != nil {
			return err
		}
	}
	updates := map[string]any{"enabled": enabled}
	if enabled {
		// 启用（包含面板里的「恢复」）要清掉禁用原因与时间：留着会让之后管理员
		// 手动停用的账号被「用户状态」面板当成自动禁用，且时间还是上一次的。
		updates["disabled_reason"] = ""
		updates["disabled_at"] = nil
		if user.Provider == AuthProviderLDAP {
			updates["pending_deletion"] = false
		}
	}
	err := DB.Model(&User{}).Where("id = ?", id).Updates(updates).Error
	InvalidateUserCache(uint64(id))
	return err
}

// UpdateUserName 只更新用户的展示名。
func UpdateUserName(id uint, name string) error {
	err := DB.Model(&User{}).Where("id = ?", id).Update("name", name).Error
	InvalidateUserCache(uint64(id))
	return err
}

// StoreMFASecret 保存待生效的 MFA 密钥，此时尚未启用 MFA。
func StoreMFASecret(id uint, secret string) error {
	err := DB.Model(&User{}).Where("id = ?", id).Updates(map[string]any{
		"mfa_secret":  SecretString(secret),
		"mfa_enabled": false,
	}).Error
	InvalidateUserCache(uint64(id))
	return err
}

// EnableUserMFA 为给定用户开启 MFA（要求密钥已先保存）。
func EnableUserMFA(id uint) error {
	err := DB.Model(&User{}).Where("id = ?", id).Update("mfa_enabled", true).Error
	InvalidateUserCache(uint64(id))
	return err
}

// DisableUserMFA 清除给定用户的 MFA。
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

// SyncLDAPUser 在目录同步时创建或更新用户。它不会
// 触碰 LastLoginAt。新发现的用户按请求指定的启用状态创建（批量导入选项）；
// 已有记录保持当前的 Enabled/PendingDeletion 状态，
// 这样管理员的决定永远不会被覆盖。
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
			Email:           strings.TrimSpace(user.Email),
			Phone:           strings.TrimSpace(user.Phone),
			Provider:        AuthProviderLDAP,
			OIDCGroups:      user.OIDCGroups,
			Enabled:         createEnabled,
			PendingDeletion: false,
		}
		if err := DB.Create(newUser).Error; err != nil {
			if !isUniqueConstraintError(err) {
				return false, err
			}
			// 与其它写入方竞争失败；继续往下走更新逻辑。
			if err := DB.Where("username = ?", username).First(&existingUser).Error; err != nil {
				return false, err
			}
		} else {
			InvalidateUserCache(uint64(newUser.ID))
			syncDirectoryGroupsAfterUserWrite(newUser.ID, newUser.OIDCGroups, GroupSourceLDAP)
			return true, nil
		}
	}

	if existingUser.Provider != AuthProviderLDAP {
		return false, ErrUserProviderConflict
	}
	if name := strings.TrimSpace(user.Name); name != "" {
		existingUser.Name = name
	}
	// 邮箱 / 手机由目录管辖：目录里没有对应属性（mail / mobile / telephoneNumber）时
	// 同步为空，避免本地残留过期值。显示名不同：目录没给时保留本地值（上面）。
	existingUser.Email = strings.TrimSpace(user.Email)
	existingUser.Phone = strings.TrimSpace(user.Phone)
	// 目录只提供它自己的组；管理员在控制台给这个账号加的「本地附加组」必须保留。
	effective, mergeErr := SyncDirectoryGroupMembership(existingUser.ID, user.OIDCGroups, GroupSourceLDAP)
	if mergeErr != nil {
		return false, mergeErr
	}
	existingUser.OIDCGroups = effective
	if err := DB.Save(&existingUser).Error; err != nil {
		return false, err
	}
	InvalidateUserCache(uint64(existingUser.ID))
	return false, nil
}

// GetLDAPUserByUsername 返回目录（LDAP）用户的本地记录。
func GetLDAPUserByUsername(username string) (*User, error) {
	var user User
	err := DB.Where("username = ? AND provider = ?",
		strings.TrimSpace(username), AuthProviderLDAP).First(&user).Error
	if err != nil {
		return nil, err
	}
	return &user, nil
}

// ListLDAPUsers 返回所有本地已开通的目录（LDAP）用户。
func ListLDAPUsers() (users []User, err error) {
	err = DB.Where("provider = ?", AuthProviderLDAP).Order("username asc").Find(&users).Error
	return users, err
}

// ListDisabledLDAPUsers 返回本地被停用的 LDAP 用户。周期性目录同步会在
// 这些账号不再存在于源目录时
// 真正把它们删除。
func ListDisabledLDAPUsers() (users []User, err error) {
	err = DB.Where("provider = ? AND enabled = ?",
		AuthProviderLDAP, false).Order("id asc").Find(&users).Error
	return users, err
}

// ListKnownGroups 返回控制台已知的所有组名，已排序并去重。它直接读取
// users 表的组列（逗号分隔，每个账号一行）——包含 LDAP/OIDC 同步来的组、
// 手动分配给本地用户的组——再加上角色授权中已使用过的组主体，
// 以及显式持久化的本地组。
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

	// 显式持久化的组（可能为空：还没有成员，也没有授权）。
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

// userGroupsColumn 发现 users 表中保存逗号分隔组名的物理列。
// GORM 会依据 OIDCGroups 字段推导出列名，但已有的数据库可能是
// 用不同的字面量名创建的，因此真实列名要从数据库目录中解析，
// 而不是在代码里写死。
// 历史库中的命名差异由此兼容。
func userGroupsColumn() (string, error) {
	candidates := []string{}

	stmt := &gorm.Statement{DB: DB}
	if err := stmt.Parse(&User{}); err == nil {
		if field := stmt.Schema.LookUpField("OIDCGroups"); field != nil && field.DBName != "" {
			candidates = append(candidates, field.DBName)
		}
	}
	// 作为兜底保留的历史 / 已观察到的其它写法。
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

// IsUniqueConstraintError 报告 err 是否是重复/唯一约束冲突，
// 这样调用方可以返回冲突，而不是把原始 SQL 错误暴露出去。
func IsUniqueConstraintError(err error) bool {
	return isUniqueConstraintError(err)
}

func AddSuperUser(user *User) error {
	if user == nil {
		return errors.New("user is nil")
	}
	user.IsSuperAdmin = true
	if err := AddUser(user); err != nil {
		return err
	}
	// 超级管理员的权限不依赖组配置：直接分配最高权限角色（系统管理员），
	// 「超级权限绑定」组（全局作用域 + 受保护成员）用于把其他用户也纳为超级管理员。
	return AddRoleAssignment(DefaultAdminRole.Name, SubjectTypeUser, user.Username)
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
