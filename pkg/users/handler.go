// Package users 提供用户管理与「当前登录用户」自身账号设置相关的 HTTP 处理器。
//
// 本包的路由分三类：
//
//   - 管理员用户管理（列表、编辑、删除、重置密码、启用/禁用），
//     挂载在 /api/v1/admin/users 下，由 RequireAdmin 中间件保护；
//   - 个人账号自助接口（个人资料、密码、MFA、侧边栏偏好），
//     挂载在 /api/users 下，始终操作鉴权中间件写入 gin context 的那个用户；
//   - 全局侧边栏策略接口，同样仅管理员可调用。
//
// 账号在本地能被修改的范围取决于其 Provider：
// 由目录同步过来的身份（LDAP / OIDC）其昵称与用户组由源系统掌管，
// 本地只能改头像；而本地密码用户三者皆可修改。
package users

import (
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"

	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/mfa"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/notification"

	"github.com/zxh326/kite/pkg/rbac"
	"k8s.io/klog/v2"
)

// createPasswordUser 是 CreatePasswordUser 接收的 JSON 请求体。
// binding 标签由 gin 的 ShouldBindJSON 负责校验，缺失必填字段会直接返回 400。
type createPasswordUser struct {
	// Username 为登录名，在全部 Provider 范围内必须唯一。
	Username string `json:"username" binding:"required"`
	// Password 为明文密码（经 TLS 传输），由 model 层负责加盐哈希后入库。
	Password string `json:"password" binding:"required"`
	// Name 为可选的展示昵称。
	Name string `json:"name"`
	// Email 用于接收通知，LDAP/OIDC 用户由同步逻辑自动填充。
	Email string `json:"email"`
	// Phone / Remark 为可选的联系信息。
	Phone  string `json:"phone"`
	Remark string `json:"remark"`
	// ExpiresAt 为账号失效时间，留空表示永不过期。
	ExpiresAt *time.Time `json:"expiresAt"`
	// Enabled 为激活状态，缺省（nil）时按激活处理。
	Enabled *bool `json:"enabled"`
	// Groups 为本地（鸢联 AeroLink）用户组名列表，创建时一并建立成员关系。
	Groups []string `json:"groups"`
	// Roles 为系统角色名列表，创建后立即分配。
	Roles []string `json:"roles"`
	// MFADisabled 为「MFA 级别：禁用」，true 表示该账号不受全局 MFA 策略强制。
	MFADisabled *bool `json:"mfaDisabled"`
}

// CreatePasswordUser 创建一个本地（密码）用户。
//
// 路由：POST /api/v1/admin/users（仅管理员）。
//
// 请求体：createPasswordUser。响应：
//   - 400：请求体不合法，或用户名已被占用；
//   - 500：写入数据库失败；
//   - 201：返回新建的用户对象（Password / MFASecret 字段为 json:"-"，不会被序列化）。
//
// 入参只有用户名 / 密码 / 昵称，其余属性（Provider="password"、Enabled 等）
// 由 model 层的默认值补齐。
func CreatePasswordUser(c *gin.Context) {
	var userreq createPasswordUser
	if err := c.ShouldBindJSON(&userreq); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// 只检查管理员，或者用户数为零的情况
	// 默认状态取自「安全设置 → 新建用户默认状态」。
	enabled := true
	expiresAt := userreq.ExpiresAt
	if settings, err := model.GetSecuritySetting(); err == nil && settings != nil {
		enabled = settings.DefaultUserEnabled
		if expiresAt == nil && settings.DefaultUserExpireDays > 0 {
			value := time.Now().AddDate(0, 0, settings.DefaultUserExpireDays)
			expiresAt = &value
		}
	}
	if userreq.Enabled != nil {
		enabled = *userreq.Enabled
	}

	user := &model.User{
		Username:  userreq.Username,
		Password:  userreq.Password,
		Name:      userreq.Name,
		Email:     userreq.Email,
		Phone:     userreq.Phone,
		Remark:    userreq.Remark,
		ExpiresAt: expiresAt,
		Enabled:   enabled,
		// 未传时默认「启用（跟随全局策略）」。
		MFADisabled: userreq.MFADisabled != nil && *userreq.MFADisabled,
		Provider:    "password",
	}
	// 本地用户的用户组直接落在 OIDCGroups 字段（与编辑弹窗保持一致）。
	if len(userreq.Groups) > 0 {
		user.OIDCGroups = model.SliceString(userreq.Groups)
	}

	// 校验与判重必须先于任何写入，否则失败时会留下指向不存在用户的角色分配。
	if err := model.ValidatePassword(userreq.Password, false); err != nil {
		c.JSON(http.StatusBadRequest, model.PasswordErrorPayload(err))
		return
	}
	_, err := model.GetUserByUsername(user.Username)
	if err == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "user already exists"})
		return
	}

	if err := model.AddUser(user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create user"})
		return
	}

	// 初始密码同样是密码变更事件，记入「日志审计 → 密码变更」以便追溯。
	if operator, ok := c.Get("user"); ok {
		if admin, ok := operator.(model.User); ok {
			model.RecordPasswordChange(user.ID, user.Username, admin.ID, admin.Username, model.PasswordChangeSourceAdmin)
		}
	}

	// 分配系统角色（与「分配」操作同一套 RoleAssignment 模型）。
	// 放在用户创建成功之后，失败仅影响角色分配，不产生孤儿数据。
	if len(userreq.Roles) > 0 {
		assigned := false
		for _, roleName := range userreq.Roles {
			name := strings.TrimSpace(roleName)
			if name == "" {
				continue
			}
			var role model.Role
			if err := model.DB.Where("name = ?", name).First(&role).Error; err != nil {
				klog.Warningf("skip unknown role %q for user %s", name, user.Username)
				continue
			}
			var existing model.RoleAssignment
			if err := model.DB.Where("role_id = ? AND subject_type = ? AND subject = ?",
				role.ID, model.SubjectTypeUser, user.Username).First(&existing).Error; err == nil {
				continue
			}
			assignment := model.RoleAssignment{
				RoleID:      role.ID,
				SubjectType: model.SubjectTypeUser,
				Subject:     user.Username,
			}
			if err := model.DB.Create(&assignment).Error; err != nil {
				klog.Warningf("failed to assign role %q to %s: %v", name, user.Username, err)
				continue
			}
			assigned = true
		}
		if assigned {
			rbac.TriggerSync()
		}
	}

	// gorm 的 `default:true` 会忽略零值 false，需要显式关闭。
	// 注意：AddUser 会按数据库默认值回读 Enabled，这里必须用计算出的值判断。
	if !enabled {
		if err := model.SetUserEnabled(user.ID, false); err != nil {
			klog.Warningf("failed to disable user %s on create: %v", user.Username, err)
		} else {
			user.Enabled = false
		}
	}
	c.JSON(http.StatusCreated, user)
}

// ListUsers 分页返回用户列表，供管理端的用户表格使用。
//
// 路由：GET /api/v1/admin/users（仅管理员）。
//
// 查询参数：
//   - page / size：从 1 开始的分页；非法或缺失时回退为 page=1、size=20；
//   - search：关键字过滤，直接下推到 model 层的查询；
//   - role：只看拥有指定 RBAC 角色的用户；
//   - enabled："true" / "false"，按启用状态过滤；其它取值不生效；
//   - provider：按认证方式过滤（password / ldap / OAuth 提供方名称）；
//   - group：按用户所属的 LDAP / OIDC 用户组过滤；
//   - sortBy / sortOrder：排序列与方向；除 "asc" 之外的一切取值都会被强制为 "desc"，
//     保证拼接到 SQL 里的方向只有这两个白名单字面量。
//
// 返回的每个用户都会被补上当前实际生效的 RBAC 角色，
// 因为角色既可能来自用户自身的分配，也可能来自其所属的 LDAP / OIDC 用户组。
func ListUsers(c *gin.Context) {
	page := 1
	size := 20
	search := strings.TrimSpace(c.Query("search"))
	role := strings.TrimSpace(c.Query("role"))
	// 过滤条件同样只接受白名单取值，避免把任意字符串拼进查询。
	enabled := strings.ToLower(strings.TrimSpace(c.Query("enabled")))
	if enabled != "true" && enabled != "false" {
		enabled = ""
	}
	provider := strings.TrimSpace(c.Query("provider"))
	group := strings.TrimSpace(c.Query("group"))
	sortBy := strings.TrimSpace(c.Query("sortBy"))
	sortOrder := strings.ToLower(strings.TrimSpace(c.Query("sortOrder")))
	// 排序方向白名单：只允许 asc / desc，其余一律按 desc 处理。
	if sortOrder != "asc" && sortOrder != "desc" {
		sortOrder = "desc"
	}
	if p := c.Query("page"); p != "" {
		_, _ = fmt.Sscanf(p, "%d", &page)
		if page <= 0 {
			page = 1
		}
	}
	if s := c.Query("size"); s != "" {
		_, _ = fmt.Sscanf(s, "%d", &size)
		if size <= 0 {
			size = 20
		}
	}
	offset := (page - 1) * size

	users, total, err := model.ListUsers(model.UserListQuery{
		Limit:     size,
		Offset:    offset,
		Search:    search,
		SortBy:    sortBy,
		SortOrder: sortOrder,
		Role:      role,
		Enabled:   enabled,
		Provider:  provider,
		Group:     group,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list users"})
		return
	}
	for i := range users {
		// 与前端用户对象一致：通过全局权限绑定组（超级权限绑定）持有的角色也算这份
		// 列表里的角色，否则用新页签授予的账号在「角色」列与角色筛选里都看不到。
		users[i].Roles = rbac.RolesForDisplay(users[i])
	}
	c.JSON(http.StatusOK, gin.H{"users": users, "total": total, "page": page, "size": size})
}

// UpdateUser 由管理员修改其他用户的资料（昵称、头像、邮箱、手机、备注、用户组）。
//
// 路由：PUT /api/v1/admin/users/:id（仅管理员）。
//
// 请求体中各字段都是可选的：只有出现在请求里的字段会被处理，因此显式传空值等于
// 清空该字段（与本人自服务的 PUT /api/users/me 同一套语义）。邮箱 / 手机复用
// profileUpdate 的校验（trim、长度上限、邮箱格式）。
//
// 由目录同步的账号（LDAP / OIDC）除头像外都受源系统管辖：昵称、邮箱、手机、备注
// 与用户组会被静默忽略（本地只允许改头像）；本地密码用户全部可改，其中用户组会
// 影响基于用户组的 RBAC 判定。密码不在这里修改，走重置密码接口。
func UpdateUser(c *gin.Context) {
	var id uint64
	if _, err := fmt.Sscanf(c.Param("id"), "%d", &id); err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	var req struct {
		profileUpdate
		Groups []string `json:"groups"`
		// Remark 是纯控制台字段（不参与目录同步），自服务不接受，只开放给管理员。
		Remark *string `json:"remark"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	user, err := model.GetUserByID(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	// 目录同步的用户（LDAP / OIDC）的姓名、联系方式与
	// 所属组由来源侧管理；本地只允许修改头像。
	// 本地用户则都可以修改（组信息驱动基于组的 RBAC）。
	externalSource := user.Provider != "" && user.Provider != model.AuthProviderPassword
	if externalSource {
		req.Name, req.Email, req.Phone = nil, nil, nil
		req.Groups, req.Remark = nil, nil
	}

	// 校验先于任何赋值，失败时不写入任何字段。
	if err := req.applyTo(user); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Groups != nil {
		user.OIDCGroups = req.Groups
	}
	if req.Remark != nil {
		user.Remark = strings.TrimSpace(*req.Remark)
	}

	if err := model.UpdateUser(user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
		return
	}
	// 与自服务同一条不变式：avatar_url 换成别的值（或清空）时，上传的字节行要删掉。
	// 管理员只能填 URL，所以这里只会删除、不会写入。
	if req.AvatarURL != nil && !isUploadedAvatarPath(id, user.AvatarURL) {
		if err := model.DeleteUserAvatar(id); err != nil {
			klog.V(4).Infof("failed to delete the avatar of user %d: %v", id, err)
		}
	}
	c.JSON(http.StatusOK, user)
}

// 自服务资料字段的长度上限，与 pkg/model/user.go 的列宽保持一致
// （name varchar(100)、email varchar(255)、phone varchar(50)）。
// 头像存 text，只做宽松的长度兜底，不校验 URL 方案——
// 管理员通道（UpdateUser）同样不校验，这里保持一致的宽松度，也避免挡掉 data: URL。
const (
	maxProfileNameLength   = 100
	maxProfileEmailLength  = 255
	maxProfilePhoneLength  = 50
	maxProfileAvatarLength = 2048
)

// profileUpdate 是 PUT /api/users/me 的请求体。
// 字段都是可选的，用指针区分「请求里没带该字段」与「显式传空值以清空」。
type profileUpdate struct {
	Name      *string `json:"name"`
	Email     *string `json:"email"`
	Phone     *string `json:"phone"`
	AvatarURL *string `json:"avatar_url"`
}

// UpdateCurrentUser 修改当前登录用户自己的基础信息。
//
// 路由：PUT /api/users/me（需登录）。
//
// 请求体：profileUpdate，只有出现在请求里的字段会被处理。字段归属与 UpdateUser 一致：
//   - 本地密码用户（Provider 为空或 "password"）可改昵称、邮箱、手机、头像；
//   - 目录同步账号（LDAP / OIDC）的昵称与联系方式由源系统掌管，传入这些字段会被
//     静默忽略（不报错），前端只需把这些输入框置灰，不必处理「部分成功」的错误；
//     头像例外：AvatarURL 是纯本地字段，目录同步不会回写它，放开不会有冲突。
//
// 这是对旧行为的有意变更：旧实现让目录用户整体返回 403，连自己的头像都改不了。
//
// 校验失败返回 400 与可读的英文错误信息，且不会写入任何字段；
// 成功时返回更新后的用户对象。管理员备注（Remark）不在自服务范围内，
// 这里既不接收也不参与校验与返回。
func UpdateCurrentUser(c *gin.Context) {
	user := c.MustGet("user").(model.User)

	var req profileUpdate
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 目录账号只保留头像，其余字段静默丢弃（与 UpdateUser 的行为一致）。
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		req.Name, req.Email, req.Phone = nil, nil, nil
	}

	if err := req.applyTo(&user); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := model.UpdateUser(&user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
		return
	}
	// avatar_url 不再指向上传的头像时，字节行要一起删掉，否则会留下取不到的孤儿图片。
	if req.AvatarURL != nil && !isUploadedAvatarPath(uint64(user.ID), user.AvatarURL) {
		if err := model.DeleteUserAvatar(uint64(user.ID)); err != nil {
			klog.V(4).Infof("failed to delete the avatar of user %d: %v", user.ID, err)
		}
	}
	c.JSON(http.StatusOK, user)
}

// applyTo 校验请求里出现的字段并写入 target。
// 任一字段不合法时返回错误且不修改 target，保证请求是「全部生效或全部不生效」。
func (u profileUpdate) applyTo(target *model.User) error {
	name, err := trimProfileField(u.Name, "name", maxProfileNameLength)
	if err != nil {
		return err
	}
	email, err := trimProfileField(u.Email, "email", maxProfileEmailLength)
	if err != nil {
		return err
	}
	// 邮箱只用作通知收件地址（没有「邮箱找回密码」流程），空值表示清空。
	if email != "" {
		if _, err := mail.ParseAddress(email); err != nil {
			return errors.New("email is not a valid email address")
		}
	}
	phone, err := trimProfileField(u.Phone, "phone", maxProfilePhoneLength)
	if err != nil {
		return err
	}
	avatarURL, err := trimProfileField(u.AvatarURL, "avatar_url", maxProfileAvatarLength)
	if err != nil {
		return err
	}

	// 全部校验通过后再赋值。
	if u.Name != nil {
		target.Name = name
	}
	if u.Email != nil {
		target.Email = email
	}
	if u.Phone != nil {
		target.Phone = phone
	}
	if u.AvatarURL != nil {
		target.AvatarURL = avatarURL
	}
	return nil
}

// trimProfileField 裁剪字段首尾空白，并在超出长度上限时返回可读的英文错误。
// value 为 nil（请求里没有该字段）时返回空串，调用方据此跳过赋值。
// 长度按字符而非字节计算，与 varchar 列宽的含义一致。
func trimProfileField(value *string, label string, maxLength int) (string, error) {
	if value == nil {
		return "", nil
	}
	trimmed := strings.TrimSpace(*value)
	if utf8.RuneCountInString(trimmed) > maxLength {
		return "", fmt.Errorf("%s must be at most %d characters", label, maxLength)
	}
	return trimmed, nil
}

// ChangeCurrentUserPassword 修改当前登录用户的密码。
//
// 路由：POST /api/users/me/password（需登录，仅本地密码用户）。
//
// 必须先提供并校验通过「当前密码」，相当于一次再认证，防止会话被盗后直接改密码；
// 校验通过后由 model 层对新密码重新哈希入库。
func ChangeCurrentUserPassword(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "password can only be changed for password users"})
		return
	}

	var req struct {
		CurrentPassword string `json:"current_password" binding:"required"`
		NewPassword     string `json:"new_password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !model.CheckPassword(user.Password, req.CurrentPassword) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "current password is incorrect"})
		return
	}
	isAdmin := rbac.IsAdministrator(user)
	if err := model.ValidatePassword(req.NewPassword, isAdmin); err != nil {
		c.JSON(http.StatusBadRequest, model.PasswordErrorPayload(err))
		return
	}
	if limit := model.PasswordHistoryLimit(); limit > 0 && model.PasswordReused(user.ID, req.NewPassword, limit) {
		c.JSON(http.StatusBadRequest, model.PasswordErrorPayload(model.PasswordReuseError(limit)))
		return
	}
	if err := model.ResetPasswordByID(user.ID, req.NewPassword, user.ID, user.Username, model.PasswordChangeSourceSelf); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to change password"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// mfaSelfEnrollReauthWindow 是自助绑定动态码允许的「登录新鲜度」：只有在这段时间内
// 重新登录过的目录账号才能开始绑定。
//
// 它只约束「开始绑定」这一步：二维码显示出来之后，用户装身份验证器花多久都不影响
// 提交动态码。要调整窗口改这一行即可。
const mfaSelfEnrollReauthWindow = 5 * time.Minute

// recentlyAuthenticated 报告该账号是否在 mfaSelfEnrollReauthWindow 内登录过。
//
// 登录时间取 `user_sessions.started_at`（多副本共享同一份，见 pkg/auth/session_policy.go）：
// 只有真正走完登录流程才会刷新它，令牌续期不会。读不到会话记录时按「不新鲜」处理
// （失败关闭）——重新认证属于安全边界，宁可让本人多登录一次。
func recentlyAuthenticated(user *model.User) bool {
	if user == nil || user.ID == 0 {
		return false
	}
	session, err := model.GetUserSession(user.ID)
	if err != nil || session.StartedAt.IsZero() {
		return false
	}
	return time.Since(session.StartedAt) <= mfaSelfEnrollReauthWindow
}

// SetupCurrentUserMFA 为当前登录用户发起 TOTP（动态口令）绑定。
//
// 路由：POST /api/users/me/mfa/setup（需登录，本地密码账号或 LDAP 账号）。
//
// 前置条件：一次成功的再认证（本地密码账号提交当前密码；LDAP 账号要求近期重新登录过，
// 见 recentlyAuthenticated）、全局 MFA 开关已打开、且该账号尚未启用 MFA。
// 注意这里只「生成并保存」密钥，并不会把 MFA 置为已启用——
// 客户端还需调用 EnableCurrentUserMFA 提交一个有效动态码才算绑定完成。
// 响应中包含明文密钥、otpauth:// 链接以及二维码的 data URL，供客户端展示。
func SetupCurrentUserMFA(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if !user.CanSelfEnrollMFA() {
		// OIDC / 第三方身份源的二次验证由 IdP 负责，鸢联 AeroLink 不提供自助绑定
		// （见 model.(*User).CanSelfEnrollMFA 与 MFARequiredFor）。
		c.JSON(http.StatusForbidden, gin.H{
			"error": "mfa self-enrollment is not available for this account",
			"code":  "mfa_not_self_enrollable",
		})
		return
	}
	if !ensureMFAEnabled(c) {
		return
	}
	// 已启用的账号不允许重复绑定，需先关闭再重新绑定。
	if user.MFAEnabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mfa is already enabled"})
		return
	}

	// 绑定等于给账号加一把长期有效的钥匙，必须先证明是本人：
	//   - 本地密码账号：提交当前密码；
	//   - LDAP 账号：要求在窗口内重新登录过。那次登录本身就是一次完整的目录认证
	//     （包含审计、失败限流、账号有效期检查），比在向导里另做一次 LDAP bind 更完整。
	var req struct {
		CurrentPassword string `json:"current_password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if user.Provider == model.AuthProviderLDAP {
		if !recentlyAuthenticated(&user) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "a recent sign-in is required to bind MFA",
				"code":  "mfa_reauth_required",
			})
			return
		}
	} else {
		if strings.TrimSpace(req.CurrentPassword) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "current password is required"})
			return
		}
		if !model.CheckPassword(user.Password, req.CurrentPassword) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "current password is incorrect"})
			return
		}
	}

	secret, err := mfa.GenerateSecret()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate mfa secret"})
		return
	}
	if err := model.StoreMFASecret(user.ID, secret); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save mfa secret"})
		return
	}

	otpURL := mfa.URL(user.Username, secret)
	qrCode, err := mfa.QRCodeDataURL(otpURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate mfa qr code"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"secret":      secret,
		"otpauth_url": otpURL,
		"qr_code":     qrCode,
	})
}

// EnableCurrentUserMFA 确认并正式启用 TOTP 绑定。
//
// 路由：POST /api/users/me/mfa/enable（需登录，本地密码账号或 LDAP 账号）。
//
// 必须已经通过 SetupCurrentUserMFA 写入过密钥，并提交一个当时有效的动态码；
// 校验通过后才把账号标记为已启用 MFA。再认证已经在 setup 那步做过，这里只看密钥与动态码。
func EnableCurrentUserMFA(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if !user.CanSelfEnrollMFA() {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "mfa self-enrollment is not available for this account",
			"code":  "mfa_not_self_enrollable",
		})
		return
	}
	if !ensureMFAEnabled(c) {
		return
	}

	var req struct {
		Code string `json:"code" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(string(user.MFASecret)) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mfa setup is not started"})
		return
	}
	if !mfa.Verify(string(user.MFASecret), req.Code) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mfa code"})
		return
	}

	if err := model.EnableUserMFA(user.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to enable mfa"})
		return
	}
	user.MFAEnabled = true
	c.JSON(http.StatusOK, user)
}

// DisableCurrentUserMFA 关闭当前登录用户的 TOTP 绑定。
//
// 路由：POST /api/users/me/mfa/disable（需登录）。
//
// 关闭时必须提交一个当前有效的动态码（仅有会话不足以关闭二次验证）；
// 关闭成功后连同密钥一起清除，账号回到未启用 MFA 的状态。
//
// 这里不按 provider 拦截：能提交当前动态码就说明本人仍持有这个绑定，解绑是他的正当
// 操作；一律拦掉的话，账号后来改用 OIDC 登录的人就再也解不掉自己的绑定，只能找管理员重置。
func DisableCurrentUserMFA(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if !ensureMFAEnabled(c) {
		return
	}

	var req struct {
		Code string `json:"code" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !user.MFAEnabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mfa is not enabled"})
		return
	}
	if !mfa.Verify(string(user.MFASecret), req.Code) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mfa code"})
		return
	}

	if err := model.DisableUserMFA(user.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to disable mfa"})
		return
	}
	user.MFAEnabled = false
	user.MFASecret = ""
	c.JSON(http.StatusOK, user)
}

// ResetUserMFA 由管理员清除某个账号的动态码绑定，让本人在下次登录时重新绑定。
//
// 路由：POST /api/v1/admin/users/:id/reset_mfa（需 settings.users 写权限）。
//
// 这是「强制 MFA」策略的安全阀：超级管理员 / 管理员的身份验证器丢失时，只能由安全管理员
// 重置后重新绑定，否则最高权限账号会永久锁死。重置动作本身会落到操作日志
// （AdminAudit 覆盖管理接口写操作），并站内信 + 邮件通知本人。
func ResetUserMFA(c *gin.Context) {
	var id uint
	if _, err := fmt.Sscanf(c.Param("id"), "%d", &id); err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	target, err := model.GetUserByID(uint64(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if !target.MFAEnabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "this user has not bound MFA"})
		return
	}

	if err := model.DisableUserMFA(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to reset MFA: " + err.Error()})
		return
	}

	operator := c.MustGet("user").(model.User)
	// 当事人必收：本人要能第一时间发现动态码被移除。
	notification.SendEventTo(model.NotificationEventMFAResetByAdmin, map[string]string{
		"username": target.Username,
		"operator": operator.Username,
		"time":     time.Now().Format("2006-01-02 15:04:05"),
	}, target.ID)

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// VerifyCurrentUserMFA 校验当前用户的动态码，并把当前浏览器标记为「已通过 MFA 校验」。
//
// 路由：POST /api/users/me/mfa/verify（需登录）。
//
// 供高危敏感操作（删除类请求、容器/节点/Kubectl 终端）做二次校验使用：
// 校验通过后，在安全设置「MFA 校验有效期（秒）」窗口内，同一浏览器再次执行
// 敏感操作时不再要求动态码；登录流程同样复用该标记。
func VerifyCurrentUserMFA(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if !user.MFAEnabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mfa is not enabled"})
		return
	}

	var req struct {
		Code string `json:"code" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !mfa.Verify(string(user.MFASecret), req.Code) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mfa code"})
		return
	}

	mfa.MarkTrusted(c, user.ID)
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// ensureMFAEnabled 检查全局 enable_mfa 开关：
// 校验失败时自己写响应（500 / 403）并返回 false。
func ensureMFAEnabled(c *gin.Context) bool {
	setting, err := model.GetGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load general setting"})
		return false
	}
	if !setting.EnableMFA {
		// 强制该账号注册 MFA 的安全策略必须保持
		// 可满足，即使旧的通用开关已经关闭——否则
		// MFA 永远无法启用，账号会被锁死。
		if current, ok := c.Get("user"); ok {
			if u, ok := current.(model.User); ok {
				if security, err := model.GetSecuritySetting(); err == nil && security != nil && security.MFARequiredFor(&u) {
					return true
				}
			}
		}
		c.JSON(http.StatusForbidden, gin.H{"error": "mfa is disabled"})
		return false
	}
	// 「安全设置 → 认证安全」的全局 MFA 策略含义是「是否强制用户绑定」，
	// 不是「禁止使用」：无论策略如何，用户都应可以自愿绑定 MFA（增强安全）
	// 或在验证动态码后解绑（例如更换手机），否则换机时会被永久锁死。
	// 因此这里不再按策略拦截，仅保留上方 EnableMFA 总开关。
	return true
}

// DeleteUser 从鸢联 AeroLink 本地数据库中删除一个用户。
//
// 路由：DELETE /api/v1/admin/users/:id（仅管理员）。
//
// 只允许删除「身份归属于鸢联 AeroLink 本地」或「由 LDAP 同步」的账号：
// 对 LDAP 用户而言这里只删除本地记录，绝不会去改动 LDAP 目录；
// 纯 OIDC 身份不能在此删除（下次登录会被重新创建），需要改用禁用。
// 具体判定见 isDeletableUser。
func DeleteUser(c *gin.Context) {
	var id uint
	if _, err := fmt.Sscanf(c.Param("id"), "%d", &id); err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	user, err := model.GetUserByID(uint64(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	// 本地用户与 LDAP 开通的用户可以直接从鸢联 AeroLink 删除。对
	// LDAP 用户而言这只删除本地记录——绝不触碰 LDAP
	// 目录。其它外部（OIDC）用户只能被停用。
	if !isDeletableUser(user.Provider) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "users from OIDC sources cannot be deleted directly; disable the user instead"})
		return
	}

	if err := model.DeleteUserByID(id); err != nil {
		// 拒绝删除的原因直接返回给调用方，并带机器码，前端才能把它本地化
		// （而不是展示英文原文）。
		switch {
		case errors.Is(err, model.ErrSuperAdminNotDeletable):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": err.Error(),
				"code":  "user_super_admin_not_deletable",
			})
			return
		case errors.Is(err, model.ErrLastAdministrator):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": err.Error(),
				"code":  "user_last_administrator",
			})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// isDeletableUser 报告该账号是否可以直接从本地
// 鸢联 AeroLink 数据库中移除。API key 的伪用户单独管理，
// 从不出现在常规用户列表中。
func isDeletableUser(provider string) bool {
	return provider == "" ||
		provider == model.AuthProviderPassword ||
		provider == model.AuthProviderLDAP ||
		provider == common.APIKeyProvider
}

// ResetPassword 由管理员为指定用户重置密码。
//
// 路由：POST /api/v1/admin/users/:id/reset_password（仅管理员）。
//
// 与自助改密不同，这里不需要提供原密码——它是管理员在用户被锁在门外时的
// 兜底手段。新密码同样交由 model 层哈希后入库。
func ResetPassword(c *gin.Context) {
	var id uint
	if _, err := fmt.Sscanf(c.Param("id"), "%d", &id); err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var req struct {
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	target, err := model.GetUserByID(uint64(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if err := model.ValidatePassword(req.Password, rbac.IsAdministrator(*target)); err != nil {
		c.JSON(http.StatusBadRequest, model.PasswordErrorPayload(err))
		return
	}
	if limit := model.PasswordHistoryLimit(); limit > 0 && model.PasswordReused(target.ID, req.Password, limit) {
		c.JSON(http.StatusBadRequest, model.PasswordErrorPayload(model.PasswordReuseError(limit)))
		return
	}
	operator := c.MustGet("user").(model.User)
	if err := model.ResetPasswordByID(id, req.Password, operator.ID, operator.Username, model.PasswordChangeSourceAdmin); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to reset password"})
		return
	}
	// 告知本人密码已被重置（安全惯例）：非本人操作可第一时间申诉。
	notification.SendEventTo(model.NotificationEventPasswordResetByAdmin, map[string]string{
		"username": target.Username,
		"operator": operator.Username,
		"time":     time.Now().Format("2006-01-02 15:04:05"),
	}, target.ID)
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// ListDisabledUsers 列出被「不活跃自动禁用」策略关闭的账号（最新在前）。
//
// 虽然这个策略由安全设置（`settings.security`）驱动，但接口本身是**用户**数据
// 的读取，因此路由挂在 `settings.users` 下：安全设置页里的「用户状态」面板要读它，
// 而面板里的「恢复」动作写的是 `settings.users`。两边同章节才不会再出现
// 「能看见面板但读不到数据」或「按钮可点却被 403」的错配。
//
// 路由：GET /api/v1/admin/users/disabled（需 settings.users 的读权限）。
func ListDisabledUsers(c *gin.Context) {
	users, err := model.ListAutoDisabledUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load disabled users"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// CheckInactiveUsers 立刻执行一次「不活跃用户自动禁用」检查，返回本次被禁用的账号数。
//
// 路由：POST /api/v1/admin/users/disabled/check（需 settings.users 的写权限）。
// 面板的列表与「恢复」都挂在 settings.users 下（见 ListDisabledUsers 说明），本接口
// 同样是写用户数据，所以同章节。它不接收参数：阈值只由「安全策略 → 登录限制」决定。
func CheckInactiveUsers(c *gin.Context) {
	disabled, err := notification.RunInactiveUserCheck()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to run the inactive user check"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"disabled": disabled})
}

// RestoreDisabledUsers 批量解禁「用户状态」面板列出的自动禁用账号。
//
// 路由：POST /api/v1/admin/users/disabled/restore（需 settings.users 的写权限）。
// 请求体：{"ids":[1,2,3]}。只处理当前仍在自动禁用列表中的账号；不在列表里的 id 记为
// skipped，避免误启「管理员手动停用」的账号（它们不属于本面板的管辖范围）。
//
// 调大不活跃阈值不会自动解禁历史被禁账号（策略只禁用、不恢复），批量误伤时用这里恢复。
func RestoreDisabledUsers(c *gin.Context) {
	var req struct {
		IDs []uint `json:"ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.IDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ids is required"})
		return
	}
	list, err := model.ListAutoDisabledUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load disabled users"})
		return
	}
	candidates := make(map[uint]model.User, len(list))
	for _, u := range list {
		candidates[u.ID] = u
	}

	restored := make([]model.User, 0, len(req.IDs))
	skipped := 0
	for _, id := range req.IDs {
		target, ok := candidates[id]
		if !ok {
			skipped++
			continue
		}
		if err := model.SetUserEnabled(id, true); err != nil {
			klog.Warningf("failed to restore auto-disabled user %s: %v", target.Username, err)
			skipped++
			continue
		}
		restored = append(restored, target)
	}

	// 与单个启用一致地通知本人；后台发送，批量场景不让 SMTP 拖慢响应。
	operator := c.MustGet("user").(model.User)
	go func(accounts []model.User, operatorName string) {
		defer func() {
			if r := recover(); r != nil {
				klog.Errorf("panic in batch restore notifications: %v", r)
			}
		}()
		now := time.Now().Format("2006-01-02 15:04:05")
		for _, u := range accounts {
			notification.SendEventTo(model.NotificationEventAccountEnabled, map[string]string{
				"username": u.Username,
				"operator": operatorName,
				"time":     now,
			}, u.ID)
		}
	}(restored, operator.Username)

	c.JSON(http.StatusOK, gin.H{"restored": len(restored), "skipped": skipped})
}

// SetUserEnabled 启用或禁用一个用户。
//
// 路由：POST /api/v1/admin/users/:id/enable（仅管理员）。
//
// 对于无法直接删除的身份（如 OIDC），禁用是官方推荐的回收访问权限方式；
// 禁用只改 Enabled 标志，用户身上的 RBAC 角色分配会原样保留。
func SetUserEnabled(c *gin.Context) {
	var id uint
	if _, err := fmt.Sscanf(c.Param("id"), "%d", &id); err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	target, err := model.GetUserByID(uint64(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if err := model.SetUserEnabled(id, req.Enabled); err != nil {
		// 「停用后没人能管理」之类的保护逻辑会把原因带在 err 里。
		// 带机器码，前端才能把它本地化（而不是展示英文原文）。
		if errors.Is(err, model.ErrLastAdministrator) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": err.Error(),
				"code":  "user_last_administrator",
			})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// 告知本人账号状态变化；被禁用的用户重新获得访问权后也能看到留痕。
	operator := c.MustGet("user").(model.User)
	event := model.NotificationEventAccountEnabled
	if !req.Enabled {
		event = model.NotificationEventAccountDisabled
	}
	notification.SendEventTo(event, map[string]string{
		"username": target.Username,
		"operator": operator.Username,
		"time":     time.Now().Format("2006-01-02 15:04:05"),
	}, target.ID)
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// UpdateSidebarPreference 保存当前登录用户的个性化侧边栏布局。
//
// 路由：POST /api/users/sidebar_preference（需登录）。
//
// 任何登录用户都可以保存自己的布局，包括管理员设置了全局侧边栏期间：全局布局
// 只是「还没自定义过的账号」的初始值，一旦用户自己保存了就以个人布局为准。
func UpdateSidebarPreference(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	var req struct {
		SidebarPreference string `json:"sidebar_preference" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	user.SidebarPreference = req.SidebarPreference
	if err := model.UpdateUser(&user); err != nil {
		klog.Errorf("failed to update sidebar preference for user %s: %v", user.Username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update sidebar preference"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// UpdateGlobalSidebarPreference 设置全局侧边栏布局，作为未自定义账号的初始布局。
//
// 路由：POST /api/v1/admin/sidebar_preference/global（仅管理员）。
//
// 已保存过个人布局的账号不受影响，仍以个人布局为准（见 UpdateSidebarPreference）。
func UpdateGlobalSidebarPreference(c *gin.Context) {
	var req struct {
		SidebarPreference string `json:"sidebar_preference" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := model.UpdateGeneralSetting(map[string]interface{}{
		"global_sidebar_preference": req.SidebarPreference,
	}); err != nil {
		klog.Errorf("failed to update global sidebar preference: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update global sidebar preference"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// ClearGlobalSidebarPreference 清除全局侧边栏（写回空字符串）。
//
// 路由：DELETE /api/v1/admin/sidebar_preference/global（仅管理员）。
//
// 清除后，没有个人布局的账号回落到内置默认布局。
func ClearGlobalSidebarPreference(c *gin.Context) {
	if _, err := model.UpdateGeneralSetting(map[string]interface{}{
		"global_sidebar_preference": "",
	}); err != nil {
		klog.Errorf("failed to clear global sidebar preference: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to clear global sidebar preference"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
