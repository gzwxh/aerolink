import { useQuery } from '@tanstack/react-query'

import type { AuthUser, CredentialProvider } from './auth'
import { fetchAPI } from './shared'

export interface BootstrapSetup {
  initialized: boolean
  step: number
}

export interface BootstrapCapabilities {
  aiEnabled: boolean
  kubectlEnabled: boolean
}

/** 本次登录的会话：superseded 表示它把其他设备上的旧会话顶下线了（单点登录）。 */
export interface BootstrapSession {
  seq: number
  superseded: boolean
}

/** 控制台外观：logoUrl 为空表示由前端使用内置图标。 */
export interface BootstrapBranding {
  logoUrl: string
  /** 控制台名称；为空表示由前端使用默认名 “Kite”。 */
  siteName: string
}

export interface AuthProviderCatalog {
  providers: string[]
  credentialProviders: CredentialProvider[]
  oauthProviders: string[]
  loginPrompt: string
  mfaEnabled: boolean
  /** 来自安全设置的全局 MFA 策略：disabled / all / admin。 */
  mfaPolicy: 'disabled' | 'all' | 'admin'
  loginCaptchaEnabled: boolean
}

export interface BootstrapResponse {
  setup: BootstrapSetup
  auth: AuthProviderCatalog
  capabilities: BootstrapCapabilities
  branding: BootstrapBranding
  session: BootstrapSession
  user: AuthUser | null
  globalSidebarPreference: string
}

export const fetchBootstrap = (): Promise<BootstrapResponse> => {
  return fetchAPI<BootstrapResponse>('/bootstrap')
}

export const useBootstrap = (options?: {
  enabled?: boolean
  staleTime?: number
}) => {
  return useQuery({
    queryKey: ['bootstrap'],
    queryFn: fetchBootstrap,
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime ?? 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}
