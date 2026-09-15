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
import { roleCanAccess, type CanAccessOptions } from '@/lib/rbac-permissions'
import { withSubPath } from '@/lib/subpath'

export type { CanAccessOptions }

interface User extends AuthUser {
  isAdmin(): boolean
  can(resource: string, verb: string, options?: CanAccessOptions): boolean

  Key(): string
}

interface AuthContextType {
  user: User | null
  isLoading: boolean
  hasGlobalSidebarPreference: boolean
  globalSidebarPreference: string
  credentialProviders: CredentialProvider[]
  oauthProviders: string[]
  loginPrompt: string
  mfaEnabled: boolean
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

const loginSucceededFlag = 'kite_just_logged_in'

// markLoginSucceeded remembers (in the same tab) that a login just succeeded so
// the auth provider can show a short confirmation toast once the user object is
// available — including after the OAuth provider round-trip redirect.
export function markLoginSucceeded() {
  try {
    sessionStorage.setItem(loginSucceededFlag, '1')
  } catch {
    // ignore storage failures
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
      return this.roles?.some((role) => role.name === 'admin') || false
    },
    can(resource, verb, options) {
      return roleCanAccess(this.roles, resource, verb, options)
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
      window.location.href = withSubPath('/login')
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
      // ignore storage failures
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
  const hasGlobalSidebarPreference =
    bootstrap?.hasGlobalSidebarPreference ??
    globalSidebarPreference.trim() !== ''
  const loginPrompt = bootstrap?.auth.loginPrompt || ''
  const mfaEnabled = bootstrap?.auth.mfaEnabled ?? true
  const loginCaptchaEnabled = bootstrap?.auth.loginCaptchaEnabled ?? false
  const capabilities = bootstrap?.capabilities ?? defaultCapabilities

  const value = useMemo(() => {
    const credentialProviders = bootstrap?.auth.credentialProviders ?? []
    const oauthProviders = bootstrap?.auth.oauthProviders ?? []

    return {
      user,
      isLoading,
      hasGlobalSidebarPreference,
      globalSidebarPreference,
      credentialProviders,
      oauthProviders,
      loginPrompt,
      mfaEnabled,
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
    hasGlobalSidebarPreference,
    globalSidebarPreference,
    bootstrap?.auth.credentialProviders,
    bootstrap?.auth.oauthProviders,
    loginPrompt,
    mfaEnabled,
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
