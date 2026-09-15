import { authApiClient } from '../api-client'

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
  roles?: AuthRole[]
  sidebar_preference?: string
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
  /** Signed id of the challenge, sent back together with the answer. */
  idKey: string
  /** PNG data URL rendered by the server. */
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
  await authApiClient.post<void>(
    `/auth/login/${provider}`,
    {
      username,
      password,
      ...(mfaCode ? { mfa_code: mfaCode } : {}),
      ...(captcha
        ? { captcha_token: captcha.idKey, captcha_code: captcha.code }
        : {}),
    },
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

export const updateCurrentUser = async (data: {
  name: string
}): Promise<AuthUser> => {
  return authApiClient.put<AuthUser>('/users/me', data)
}

export const changeCurrentUserPassword = async (
  currentPassword: string,
  newPassword: string
): Promise<void> => {
  await authApiClient.post<void>('/users/me/password', {
    current_password: currentPassword,
    new_password: newPassword,
  })
}

export interface MFASetupResponse {
  secret: string
  otpauth_url: string
  qr_code: string
}

export const setupCurrentUserMFA = async (
  currentPassword: string
): Promise<MFASetupResponse> => {
  return authApiClient.post<MFASetupResponse>('/users/me/mfa/setup', {
    current_password: currentPassword,
  })
}

export const enableCurrentUserMFA = async (code: string): Promise<AuthUser> => {
  return authApiClient.post<AuthUser>('/users/me/mfa/enable', { code })
}

export const verifyCurrentUserMFA = async (code: string): Promise<void> => {
  await authApiClient.post<void>('/users/me/mfa/verify', { code })
}

export const disableCurrentUserMFA = async (
  code: string
): Promise<AuthUser> => {
  return authApiClient.post<AuthUser>('/users/me/mfa/disable', { code })
}
