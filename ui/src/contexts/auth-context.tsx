/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import {
  clearTabSession,
  hasTabSession,
  markTabSession,
  probeLiveTabs,
  shouldRequireLogin,
  startTabSessionResponder,
} from '@/lib/tab-session'

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
  // 同一时刻也落下「本标签已经过认证」的票据：凭据登录、OAuth 往返之后
  // 都会走到这里，标签页闸门（见下方 tabGate）据此直接放行。
  markTabSession()
}

/** 标签页闸门状态：idle 未判定 / checking 正在问其它标签 / passed 已放行。 */
type TabGate = 'idle' | 'checking' | 'passed'

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

  const [tabGate, setTabGate] = useState<TabGate>('idle')
  const tabGateStarted = useRef(false)

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
    // 主动退出后本标签不再算「仍在使用」，否则别的标签会把它当成旁证。
    clearTabSession()
    tabGateStarted.current = false
    setTabGate('idle')
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

  // 标签页闸门：bootstrap 认为已登录，但本标签没有认证票据时，先确认同浏览器里
  // 是不是还有别的标签在用。有就放行（复制链接、从别的标签继续操作都算同一次使用），
  // 一个都没有说明所有页面都关过了，回登录页重新认证。
  //
  // 这里不能用 Redirect 之类的渲染期跳转：判定是异步的（要等其它标签回话），
  // 而且必须以整页跳转的方式落到登录页，好让 bootstrap 重新读一次 Cookie。
  //
  // 用 ref 而不是 state 记住「已判定过」：判定开始时会改 tabGate，若把它放进依赖，
  // 这次改动会把正在等待的 promise 判成过期，闸门就永远停在 checking。
  useEffect(() => {
    if (isLoading || !user || tabGateStarted.current) return
    if (typeof window === 'undefined') {
      setTabGate('passed')
      return
    }
    // 登录页不判定：用户多半是被这里赶过来的，再判定一次就是整页跳转死循环。
    if (hasTabSession() || window.location.pathname.endsWith('/login')) {
      tabGateStarted.current = true
      setTabGate('passed')
      return
    }
    tabGateStarted.current = true
    setTabGate('checking')
    void probeLiveTabs().then((hasLivePeer) => {
      if (shouldRequireLogin({ hasTicket: false, hasLivePeer })) {
        // 跳转没发出去（预算用完等）时也要解除阻断，否则会一直转圈。
        if (!redirectToLogin('session-ended')) setTabGate('passed')
        return
      }
      markTabSession()
      setTabGate('passed')
    })
  }, [isLoading, user])

  // 已通过闸门的标签回答别的标签的 ping（见 lib/tab-session.ts）。
  // 依赖用户 ID 而不是对象：bootstrap 每次 refetch 都会换一个新的 user 对象，
  // 跟着它重建广播通道没有意义。
  const userId = user?.id
  useEffect(() => {
    if (!userId || tabGate !== 'passed') return
    return startTabSessionResponder()
  }, [userId, tabGate])

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

  // 闸门还没放行时对调用方表现为「仍在加载」：路由守卫据此转圈，
  // 而不是先把主界面画出来再整页跳走。
  const tabGateBlocked = !!user && tabGate !== 'passed'

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
      isLoading: isLoading || tabGateBlocked,
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
    tabGateBlocked,
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
