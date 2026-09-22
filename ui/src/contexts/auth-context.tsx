/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type {
  BootstrapCapabilities,
  CredentialProvider,
  LoginCaptchaAnswer,
} from '@/lib/api'
import {
  loginWithCredentials as authenticateWithCredentials,
  initiateOAuthLogin,
  logout as logoutUser,
  refreshAuthToken,
  useBootstrap,
  type AuthUser,
} from '@/lib/api'
import { redirectToLogin } from '@/lib/api-client'
import {
  permissionRoles,
  roleCanAccess,
  roleCanAccessAnySettingsSection,
  roleCanManageSettingsSection,
  roleCanManageSystemSettings,
  roleCanViewSettingsSection,
  separationOfDutiesConflict,
  type CanAccessOptions,
} from '@/lib/rbac-permissions'
import { withSubPath } from '@/lib/subpath'

export type { CanAccessOptions }

interface User extends AuthUser {
  isAdmin(): boolean
  can(resource: string, verb: string, options?: CanAccessOptions): boolean
  /**
   * 用户是否可以修改*所有*控制台设置与权限。
   * 对应 rbac.CanManageSystemSettings（父级 "settings" 资源）。
   */
  canManageSettings(): boolean
  /**
   * 用户是否至少可以打开一个控制台设置页面。对应
   * rbac.CanAccessAnySettingsSection：设置区本身以此为准，
   * 因此审计管理员（只有 settings.audit）可以打开审计页面，
   * 而无需持有完整的管理员角色。
   */
  canViewSettings(): boolean
  /** 用户是否可以打开某个控制台设置分区。 */
  canViewSettingsSection(section: string): boolean
  /** 用户是否可以修改某个控制台设置分区。 */
  canManageSettingsSection(section: string): boolean
  /**
   * 职责分离（三权分立）冲突：账号同时持有互斥的管理员角色时，管理面会被后端
   * 整体拒绝（见 rbac.SeparationOfDutiesConflict），界面据此给出提示并隐藏入口。
   */
  roleConflict(): { conflict: boolean; roles: string[] }

  Key(): string
}

interface AuthContextType {
  user: User | null
  isLoading: boolean
  globalSidebarPreference: string
  credentialProviders: CredentialProvider[]
  oauthProviders: string[]
  loginPrompt: string
  /**
   * 通用设置里的动态码功能闸：true 表示这个部署允许绑定动态码。
   * 安全策略（「谁必须绑定」）走用户对象上的 mfa_required，与此无关。
   */
  mfaAvailable: boolean
  loginCaptchaEnabled: boolean
  capabilities: BootstrapCapabilities
  login: (provider?: string) => Promise<void>
  loginWithCredentials: (
    provider: CredentialProvider,
    username: string,
    password: string,
    mfaCode?: string,
    captcha?: LoginCaptchaAnswer
  ) => Promise<void>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
  refreshToken: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

const loginSucceededFlag = 'aerolink_just_logged_in'

// markLoginSucceeded 在同一标签页内记住刚刚登录成功，
// 使认证提供方能在用户对象可用后展示一次简短的确认 toast——
// 包括 OAuth 提供方往返重定向之后。
export function markLoginSucceeded() {
  try {
    sessionStorage.setItem(loginSucceededFlag, '1')
  } catch {
    // 忽略存储失败
  }
}

const defaultCapabilities: BootstrapCapabilities = {
  aiEnabled: false,
  kubectlEnabled: true,
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

interface AuthProviderProps {
  children: ReactNode
}

function normalizeUser(user: AuthUser): User {
  return {
    ...user,
    isAdmin() {
      // 与后端 rbac.IsAdministrator 保持一致：持有 admin 系统角色。
      return this.roles?.some((role) => role.name === 'admin') || false
    },
    can(resource, verb, options) {
      // 命名空间级权限绑定组的角色也要参与：否则绑定组用户会看到范围外的操作入口。
      // isAdmin 供「创建命名空间」使用（只认管理员，不看角色）。
      return roleCanAccess(
        permissionRoles(this.roles, this.namespaceScopedRoles),
        resource,
        verb,
        { ...options, isAdmin: this.isAdmin() }
      )
    },
    canManageSettings() {
      return roleCanManageSystemSettings(this.roles)
    },
    canViewSettings() {
      return roleCanAccessAnySettingsSection(this.roles)
    },
    canViewSettingsSection(section: string) {
      return roleCanViewSettingsSection(this.roles, section)
    },
    canManageSettingsSection(section: string) {
      return roleCanManageSettingsSection(this.roles, section)
    },
    roleConflict() {
      return separationOfDutiesConflict(this.roles)
    },
    Key() {
      return this.username || this.id
    },
  }
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation()
  const {
    data: bootstrap,
    isLoading,
    refetch: refetchBootstrap,
  } = useBootstrap()

  const checkAuth = useCallback(async () => {
    await refetchBootstrap()
  }, [refetchBootstrap])

  const login = useCallback(async (provider: string = 'github') => {
    markLoginSucceeded()
    const { auth_url } = await initiateOAuthLogin(provider)
    window.location.href = auth_url
  }, [])

  const loginWithCredentials = useCallback(
    async (
      provider: CredentialProvider,
      username: string,
      password: string,
      mfaCode?: string,
      captcha?: LoginCaptchaAnswer
    ) => {
      await authenticateWithCredentials(
        provider,
        username,
        password,
        mfaCode,
        captcha
      )
      markLoginSucceeded()
      await checkAuth()
    },
    [checkAuth]
  )

  const logout = useCallback(async () => {
    await logoutUser()
    await refetchBootstrap()
    window.location.href = withSubPath('/login')
  }, [refetchBootstrap])

  const refreshToken = useCallback(async () => {
    try {
      await refreshAuthToken()
    } catch (error) {
      console.error('Token refresh failed:', error)
      await refetchBootstrap()
      // 复用 api-client 的防重入跳转，避免登录页重复 401 造成刷新循环
      redirectToLogin()
    }
  }, [refetchBootstrap])

  const user = useMemo(
    () => (bootstrap?.user ? normalizeUser(bootstrap.user) : null),
    [bootstrap?.user]
  )

  useEffect(() => {
    if (isLoading || !user || typeof window === 'undefined') return
    let justLoggedIn = false
    try {
      justLoggedIn = sessionStorage.getItem(loginSucceededFlag) === '1'
      if (justLoggedIn) sessionStorage.removeItem(loginSucceededFlag)
    } catch {
      // 忽略存储失败
    }
    if (justLoggedIn) {
      toast.success(t('login.success', 'Login successful'), { duration: 2000 })
    }
  }, [user, isLoading, t])

  useEffect(() => {
    if (!user) return
    const refreshKey = 'lastRefreshTokenAt'
    const lastRefreshAt = localStorage.getItem(refreshKey)
    const now = Date.now()

    if (!lastRefreshAt || now - Number(lastRefreshAt) > 30 * 60 * 1000) {
      refreshToken()
      localStorage.setItem(refreshKey, String(now))
    }

    const refreshInterval = setInterval(
      () => {
        refreshToken()
        localStorage.setItem(refreshKey, String(Date.now()))
      },
      30 * 60 * 1000
    )

    return () => clearInterval(refreshInterval)
  }, [user, refreshToken])

  const globalSidebarPreference = String(
    bootstrap?.globalSidebarPreference || ''
  )
  const loginPrompt = bootstrap?.auth.loginPrompt || ''
  const mfaAvailable = bootstrap?.auth.mfaAvailable ?? false
  const loginCaptchaEnabled = bootstrap?.auth.loginCaptchaEnabled ?? false
  const capabilities = bootstrap?.capabilities ?? defaultCapabilities

  const value = useMemo(() => {
    const credentialProviders = bootstrap?.auth.credentialProviders ?? []
    const oauthProviders = bootstrap?.auth.oauthProviders ?? []

    return {
      user,
      isLoading,
      globalSidebarPreference,
      credentialProviders,
      oauthProviders,
      loginPrompt,
      mfaAvailable,
      loginCaptchaEnabled,
      capabilities,
      login,
      loginWithCredentials,
      logout,
      checkAuth,
      refreshToken,
    }
  }, [
    user,
    isLoading,
    globalSidebarPreference,
    bootstrap?.auth.credentialProviders,
    bootstrap?.auth.oauthProviders,
    loginPrompt,
    mfaAvailable,
    loginCaptchaEnabled,
    capabilities,
    login,
    loginWithCredentials,
    logout,
    checkAuth,
    refreshToken,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
