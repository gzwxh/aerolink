import { authApiClient } from '../api-client'
import { encryptSecrets } from '../credential-cipher'

export type CredentialProvider = 'password' | 'ldap'

export interface AuthRole {
  name: string
  clusters?: string[]
  resources?: string[]
  namespaces?: string[]
  verbs?: string[]
}

export interface AuthUser {
  id: string
  username: string
  name: string
  avatar_url: string
  provider: string
  mfa_enabled?: boolean
  mfa_required?: boolean
  /** 初始化创建的超级管理员账号（不可停用，保护手段是绑定 MFA）。 */
  isSuperAdmin?: boolean
  roles?: AuthRole[]
  /**
   * 命名空间级权限绑定组带来的角色（含组内集群与命名空间范围，见后端
   * rbac.NamespaceScopedBindingGroupRoles）。只参与资源权限判定，
   * 不参与 isAdmin 与设置章节判定——与后端的 IsAdministrator / CanAccess 保持一致。
   */
  namespaceScopedRoles?: AuthRole[]
  sidebar_preference?: string
  // 以下字段由 bootstrap 返回的用户对象提供（为空时后端会省略，所以都是可选的）。
  /** 通知邮件的收件地址。 */
  email?: string
  phone?: string
  /** 所属用户组（来自 LDAP / OIDC 同步或本地配置）。 */
  oidc_groups?: string[]
  enabled?: boolean
  createdAt?: string
  lastLoginAt?: string
  /** 密码最后一次修改时间（用于过期策略展示）。 */
  password_updated_at?: string
}

export interface OAuthLoginResponse {
  auth_url: string
  provider: string
}

export const initiateOAuthLogin = async (
  provider: string
): Promise<OAuthLoginResponse> => {
  return authApiClient.get<OAuthLoginResponse>(
    `/auth/login?provider=${encodeURIComponent(provider)}`,
    {
      retryOnUnauthorized: false,
    }
  )
}

export interface LoginCaptchaChallenge {
  /** 验证码挑战的签名 id，与答案一起回传。 */
  idKey: string
  /** 服务端渲染出的 PNG data URL。 */
  image: string
}

export const fetchLoginCaptcha = async (): Promise<LoginCaptchaChallenge> => {
  return authApiClient.get<LoginCaptchaChallenge>('/auth/captcha', {
    retryOnUnauthorized: false,
  })
}

export interface LoginCaptchaAnswer {
  idKey: string
  code: string
}

export const loginWithCredentials = async (
  provider: CredentialProvider,
  username: string,
  password: string,
  mfaCode?: string,
  captcha?: LoginCaptchaAnswer
): Promise<void> => {
  // 口令与动态码都以密文上行；验证码是绑定 challenge 的一次性答案，保持明文。
  const encrypted = await encryptSecrets({
    password,
    mfa_code: mfaCode,
  })
  await authApiClient.post<void>(
    `/auth/login/${provider}`,
    {
      username,
      ...encrypted,
      ...(captcha
        ? { captcha_token: captcha.idKey, captcha_code: captcha.code }
        : {}),
    },
    { retryOnUnauthorized: false }
  )
}

/**
 * 第三方登录补验动态码。
 *
 * OIDC 这类重定向流没法在回调里收动态码，回调会跳回登录页并带上 `mfa_pending` 票据；
 * 票据只证明身份源认证通过，换不到任何权限，必须配上动态码才能换到会话。
 */
export const verifyPendingMFA = async (
  ticket: string,
  code: string
): Promise<void> => {
  // 动态码在有效期内等同一次临时口令，与登录口令走同一套加密。
  const encrypted = await encryptSecrets({ mfa_code: code })
  await authApiClient.post<void>(
    '/auth/mfa/verify',
    { mfa_pending: ticket, ...encrypted },
    { retryOnUnauthorized: false }
  )
}

export const refreshAuthToken = async (): Promise<void> => {
  await authApiClient.post<void>('/auth/refresh', undefined, {
    retryOnUnauthorized: false,
  })
}

export const logout = async (): Promise<void> => {
  await authApiClient.post<void>('/auth/logout', undefined, {
    retryOnUnauthorized: false,
  })
}

// 修改当前登录用户自己的资料。目录用户（LDAP / OIDC）只有 avatar_url 会被接受，
// 其余字段由身份源管辖（后端静默忽略，不是错误）。
export const updateCurrentUser = async (data: {
  name?: string
  email?: string
  phone?: string
  avatar_url?: string
}): Promise<AuthUser> => {
  return authApiClient.put<AuthUser>('/users/me', data)
}

// 上传当前用户头像（multipart，字段名 file）。服务端会写回 users.avatar_url，
// 返回更新后的用户对象；限制与说明见 docs/dev/plans/2026-09-20-头像上传.md。
export const uploadCurrentUserAvatar = async (
  file: File
): Promise<AuthUser> => {
  const form = new FormData()
  form.append('file', file)
  return authApiClient.post<AuthUser>('/users/me/avatar', form)
}

// 清除当前用户头像（恢复首字母占位）。
export const deleteCurrentUserAvatar = async (): Promise<AuthUser> => {
  return authApiClient.delete<AuthUser>('/users/me/avatar')
}

export const changeCurrentUserPassword = async (
  currentPassword: string,
  newPassword: string
): Promise<void> => {
  const encrypted = await encryptSecrets({
    current_password: currentPassword,
    new_password: newPassword,
  })
  await authApiClient.post<void>('/users/me/password', encrypted)
}

export interface MFASetupResponse {
  secret: string
  otpauth_url: string
  qr_code: string
}

/**
 * 发起动态码绑定，返回密钥、otpauth 链接与二维码。
 *
 * `currentPassword` 是本地密码账号的再认证凭据；LDAP 账号没有本地口令，不传该字段，
 * 后端改用「最近重新登录过」判定（不满足时返回 `mfa_reauth_required`）。
 */
export const setupCurrentUserMFA = async (
  currentPassword?: string
): Promise<MFASetupResponse> => {
  const encrypted = await encryptSecrets({
    current_password: currentPassword,
  })
  return authApiClient.post<MFASetupResponse>('/users/me/mfa/setup', encrypted)
}

export const enableCurrentUserMFA = async (code: string): Promise<AuthUser> => {
  return authApiClient.post<AuthUser>(
    '/users/me/mfa/enable',
    await encryptSecrets({ code })
  )
}

export const verifyCurrentUserMFA = async (code: string): Promise<void> => {
  await authApiClient.post<void>(
    '/users/me/mfa/verify',
    await encryptSecrets({ code })
  )
}

export const disableCurrentUserMFA = async (
  code: string
): Promise<AuthUser> => {
  return authApiClient.post<AuthUser>(
    '/users/me/mfa/disable',
    await encryptSecrets({ code })
  )
}
