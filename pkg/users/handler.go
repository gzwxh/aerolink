// Package users 提供用户管理与「当前登录用户」自身账号设置相关的 HTTP 处理器。
//
// 本包的路由分三类：
//
//   - 管理员用户管理（列表、编辑、删除、重置密码、启用/禁用），
//     挂载在 /api/v1/admin/users 下，由 RequireAdmin 中间件保护；
//   - 个人账号自助接口（昵称、密码、MFA、Passkey、侧边栏偏好），
//     挂载在 /api/users 下，始终操作鉴权中间件写入 gin context 的那个用户；
//   - 全局侧边栏策略接口，同样仅管理员可调用。
//
// 账号在本地能被修改的范围取决于其 Provider：
// 由目录同步过来的身份（LDAP / OIDC）其昵称与用户组由源系统掌管，
// 本地只能改头像；而本地密码用户三者皆可修改。
package users

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/mfa"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/passkey"
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
	// check only admin or users count is zero
	user := &model.User{
		Username: userreq.Username,
		Password: userreq.Password,
		Name:     userreq.Name,
		Provider: "password",
	}

	// 先做一次友好判重，避免依赖唯一索引报错（数据库层仍有 uniqueIndex 兜底）。
	_, err := model.GetUserByUsername(user.Username)
	if err == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "user already exists"})
		return
	}

	if err := model.ValidatePassword(userreq.Password, false); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := model.AddUser(user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create user"})
		return
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

	users, total, err := model.ListUsers(
		size,
		offset,
		search,
		sortBy,
		sortOrder,
		role,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list users"})
		return
	}
	for i := range users {
		users[i].Roles = rbac.GetUserRoles(users[i])
	}
	c.JSON(http.StatusOK, gin.H{"users": users, "total": total, "page": page, "size": size})
}

// UpdateUser 由管理员修改其他用户的资料（昵称、头像、用户组）。
//
// 路由：PUT /api/v1/admin/users/:id（仅管理员）。
//
// 请求体中各字段都是可选的，只有非零值才会覆盖原值。
// 由目录同步的账号（LDAP / OIDC）其昵称与用户组受源系统管辖：
// 对它们而言这两个字段会被静默忽略，本地只允许改头像；
// 本地密码用户三者都可改，其中用户组会影响基于用户组的 RBAC 判定。
func UpdateUser(c *gin.Context) {
	var id uint64
	if _, err := fmt.Sscanf(c.Param("id"), "%d", &id); err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	var req struct {
		Name      string   `json:"name"`
		AvatarURL string   `json:"avatar_url,omitempty"`
		Groups    []string `json:"groups"`
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
	// Directory-synced users (LDAP / OIDC) keep name and groups under source
	// control; only the avatar is editable locally. Native users may edit all
	// three (groups feed group-based RBAC).
	externalSource := user.Provider != "" && user.Provider != model.AuthProviderPassword
	if req.Name != "" && !externalSource {
		user.Name = req.Name
	}
	if req.AvatarURL != "" {
		user.AvatarURL = req.AvatarURL
	}
	if req.Groups != nil && !externalSource {
		user.OIDCGroups = req.Groups
	}

	if err := model.UpdateUser(user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
		return
	}
	c.JSON(http.StatusOK, user)
}

// UpdateCurrentUser 修改当前登录用户的昵称。
//
// 路由：PUT /api/users/me（需登录）。
//
// 仅对本地密码用户开放：OIDC / LDAP 身份的昵称来自身份源，
// 因此这类用户调用会直接返回 403。昵称会做首尾空白裁剪。
func UpdateCurrentUser(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "account settings are only available for password users"})
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	name := strings.TrimSpace(req.Name)
	if err := model.UpdateUserName(user.ID, name); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
		return
	}
	user.Name = name
	c.JSON(http.StatusOK, user)
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
	isAdmin := rbac.UserHasRole(user, model.DefaultAdminRole.Name)
	if err := model.ValidatePassword(req.NewPassword, isAdmin); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if limit := model.PasswordHistoryLimit(); limit > 0 && model.PasswordReused(user.ID, req.NewPassword, limit) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf("password cannot repeat any of the last %d passwords", limit),
		})
		return
	}
	if err := model.ResetPasswordByID(user.ID, req.NewPassword); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to change password"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// SetupCurrentUserMFA 为当前登录用户发起 TOTP（动态口令）绑定。
//
// 路由：POST /api/users/me/mfa/setup（需登录，仅本地密码用户）。
//
// 前置条件：当前密码校验通过、全局 MFA 开关已打开、且该账号尚未启用 MFA。
// 注意这里只「生成并保存」密钥，并不会把 MFA 置为已启用——
// 客户端还需调用 EnableCurrentUserMFA 提交一个有效动态码才算绑定完成。
// 响应中包含明文密钥、otpauth:// 链接以及二维码的 data URL，供客户端展示。
func SetupCurrentUserMFA(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "mfa is only available for password users"})
		return
	}
	if !ensureMFAEnabled(c) {
		return
	}
	var req struct {
		CurrentPassword string `json:"current_password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !model.CheckPassword(user.Password, req.CurrentPassword) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "current password is incorrect"})
		return
	}
	// 已启用的账号不允许重复绑定，需先关闭再重新绑定。
	if user.MFAEnabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mfa is already enabled"})
		return
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
// 路由：POST /api/users/me/mfa/enable（需登录，仅本地密码用户）。
//
// 必须已经通过 SetupCurrentUserMFA 写入过密钥，并提交一个当时有效的动态码；
// 校验通过后才把账号标记为已启用 MFA。
func EnableCurrentUserMFA(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "mfa is only available for password users"})
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
// 路由：POST /api/users/me/mfa/disable（需登录，仅本地密码用户）。
//
// 关闭时必须提交一个当前有效的动态码（仅有会话不足以关闭二次验证）；
// 关闭成功后连同密钥一起清除，账号回到未启用 MFA 的状态。
func DisableCurrentUserMFA(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "mfa is only available for password users"})
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

// ListCurrentUserPasskeys 列出当前登录用户已注册的 Passkey（WebAuthn 凭据）。
//
// 路由：GET /api/users/me/passkeys（需登录，仅本地密码用户）。
//
// 若管理员在全局设置里关闭了 Passkey 登录，则直接返回 403。
func ListCurrentUserPasskeys(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkeys are only available for password users"})
		return
	}
	if !ensurePasskeyLoginEnabled(c) {
		return
	}
	credentials, err := passkey.CredentialsForUser(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list passkeys"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"passkeys": credentials})
}

// BeginCurrentUserPasskeyRegistration 开始 Passkey 注册流程，
// 返回供浏览器 navigator.credentials.create() 使用的创建参数。
//
// 路由：POST /api/users/me/passkeys/begin（需登录，仅本地密码用户）。
//
// 校验顺序：当前密码必填必对；若账号已启用 MFA，则还必须提交有效动态码——
// 这样「新增 Passkey」就不能被用来绕过第二因素。
// 生成的 challenge 由 passkey 包写入会话，供 Finish 阶段校验。
func BeginCurrentUserPasskeyRegistration(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkeys are only available for password users"})
		return
	}
	if !ensurePasskeyLoginEnabled(c) {
		return
	}

	var req struct {
		Name            string `json:"name"`
		CurrentPassword string `json:"current_password" binding:"required"`
		MFACode         string `json:"mfa_code"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !model.CheckPassword(user.Password, req.CurrentPassword) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "current password is incorrect"})
		return
	}
	if user.MFAEnabled && !mfa.Verify(string(user.MFASecret), req.MFACode) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mfa code"})
		return
	}

	creation, err := passkey.BeginRegistration(c, user, req.Name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start passkey registration"})
		return
	}
	c.JSON(http.StatusOK, creation)
}

// FinishCurrentUserPasskeyRegistration 校验认证器的注册响应并落库新凭据。
//
// 路由：POST /api/users/me/passkeys/finish（需登录，仅本地密码用户）。
//
// 与 Begin 成对使用：认证器返回的 attestation 会与 Begin 阶段存进会话的
// challenge 比对，校验失败返回 400。
func FinishCurrentUserPasskeyRegistration(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkeys are only available for password users"})
		return
	}
	if !ensurePasskeyLoginEnabled(c) {
		return
	}

	credential, err := passkey.FinishRegistration(c, user)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to finish passkey registration"})
		return
	}
	c.JSON(http.StatusOK, credential)
}

// DeleteCurrentUserPasskey 删除当前登录用户的某个 Passkey。
//
// 路由：DELETE /api/users/me/passkeys/:id（需登录，仅本地密码用户）。
//
// 删除时以「用户 ID + 凭据 ID」为条件，因此无法删除属于其他用户的凭据。
func DeleteCurrentUserPasskey(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	if user.Provider != "" && user.Provider != model.AuthProviderPassword {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkeys are only available for password users"})
		return
	}
	if !ensurePasskeyLoginEnabled(c) {
		return
	}

	var id uint
	if _, err := fmt.Sscanf(c.Param("id"), "%d", &id); err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	if err := passkey.DeleteCredential(user.ID, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete passkey"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// ensurePasskeyLoginEnabled 检查全局是否开启了 Passkey 登录。
//
// 失败时它已经自行写好了响应（读取配置失败 500、未开启 403），
// 因此调用方只需在返回 false 时直接 return 即可。
func ensurePasskeyLoginEnabled(c *gin.Context) bool {
	enabled, err := passkey.Enabled()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load general setting"})
		return false
	}
	if !enabled {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkey login is disabled"})
		return false
	}
	return true
}

// ensureMFAEnabled 是 ensurePasskeyLoginEnabled 的 MFA 版本：
// 检查全局 enable_mfa 开关，失败时同样自己写响应（500 / 403）并返回 false。
func ensureMFAEnabled(c *gin.Context) bool {
	setting, err := model.GetGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load general setting"})
		return false
	}
	if !setting.EnableMFA {
		c.JSON(http.StatusForbidden, gin.H{"error": "mfa is disabled"})
		return false
	}
	return true
}

// DeleteUser 从 Kite 本地数据库中删除一个用户。
//
// 路由：DELETE /api/v1/admin/users/:id（仅管理员）。
//
// 只允许删除「身份归属于 Kite 本地」或「由 LDAP 同步」的账号：
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

	// Native and LDAP-provisioned users can be removed from Kite directly. For
	// LDAP users this only deletes the local record — it never touches the LDAP
	// directory. Other external (OIDC) users can only be disabled.
	if !isDeletableUser(user.Provider) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "users from OIDC sources cannot be deleted directly; disable the user instead"})
		return
	}

	if err := model.DeleteUserByID(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete user"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// isDeletableUser reports whether the account may be removed from the local
// Kite database directly. API-key pseudo users are managed separately and never
// appear in the regular user list.
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
	if err := model.ValidatePassword(req.Password, rbac.UserHasRole(*target, model.DefaultAdminRole.Name)); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if limit := model.PasswordHistoryLimit(); limit > 0 && model.PasswordReused(target.ID, req.Password, limit) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf("password cannot repeat any of the last %d passwords", limit),
		})
		return
	}
	if err := model.ResetPasswordByID(id, req.Password); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to reset password"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
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
	if err := model.SetUserEnabled(id, req.Enabled); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to set enabled"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// UpdateSidebarPreference 保存当前登录用户的个性化侧边栏布局。
//
// 路由：POST /api/users/sidebar_preference（需登录）。
//
// 管理员始终可以自定义自己的侧边栏；其他用户则在管理员设置了「全局侧边栏」
// 期间被拒绝（403），因为全局布局的语义就是强制统一。
func UpdateSidebarPreference(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	isAdmin := rbac.UserHasRole(user, model.DefaultAdminRole.Name)
	// 只有非管理员需要受全局策略约束：管理员可保留自己的个性化布局。
	if !isAdmin {
		setting, err := model.GetGeneralSetting()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load general setting"})
			return
		}
		if strings.TrimSpace(setting.GlobalSidebarPreference) != "" {
			c.JSON(http.StatusForbidden, gin.H{"error": "sidebar customization is disabled by global sidebar"})
			return
		}
	}
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

// UpdateGlobalSidebarPreference 设置全局侧边栏布局，对所有非管理员生效。
//
// 路由：POST /api/v1/admin/sidebar_preference/global（仅管理员）。
//
// 一旦设置，非管理员便不能再自定义自己的侧边栏（见 UpdateSidebarPreference）。
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

// ClearGlobalSidebarPreference 清除全局侧边栏策略（写回空字符串）。
//
// 路由：DELETE /api/v1/admin/sidebar_preference/global（仅管理员）。
//
// 清除后，非管理员用户恢复可以自定义各自的侧边栏。
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
