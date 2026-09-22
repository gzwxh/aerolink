/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from 'react'
import DefaultLogo from '@/assets/icon.svg'

import { useBootstrap } from '@/lib/api/bootstrap'

/** 控制台外观：管理员可在「系统设置 → 通用 → 品牌」里替换 logo 与名称。 */
export interface Branding {
  /** 自定义 logo 或内置图标。 */
  logoUrl: string
  /** 是否为自定义 logo（内置图标在深色模式下要反色，自定义的不应该被反色）。 */
  isCustomLogo: boolean
  /** 控制台名称（侧边栏、登录页、浏览器标签共用）。 */
  siteName: string
  /** 管理员配置过名称或 logo：此时收起版本号等 AeroLink 自身信息（见侧边栏）。 */
  isCustomBranding: boolean
}

/** 默认站点名；管理员留空时使用。 */
export const DEFAULT_SITE_NAME = '鸢联 AeroLink'

const BrandingContext = createContext<Branding>({
  logoUrl: DefaultLogo,
  isCustomLogo: false,
  siteName: DEFAULT_SITE_NAME,
  isCustomBranding: false,
})

/**
 * 提供品牌配置。数据来自公开的 bootstrap 接口，因此登录页、初始化页（未登录）与
 * 登录后的界面用的是同一份配置；没包 Provider 的地方（例如组件单测）会退回默认值。
 */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const { data } = useBootstrap({ staleTime: 5 * 60 * 1000 })
  const customLogo = data?.branding?.logoUrl?.trim() ?? ''
  const customName = data?.branding?.siteName?.trim() ?? ''

  return (
    <BrandingContext.Provider
      value={{
        logoUrl: customLogo || DefaultLogo,
        isCustomLogo: customLogo !== '',
        siteName: customName || DEFAULT_SITE_NAME,
        // 看的是“配没配”而不是“和默认值一不一样”：管理员就是把名字填成默认名
        // 也算自定义，留空才是用默认值。
        isCustomBranding: customLogo !== '' || customName !== '',
      }}
    >
      {children}
    </BrandingContext.Provider>
  )
}

/** 读取品牌配置（见 Branding）。 */
export function useBranding(): Branding {
  return useContext(BrandingContext)
}
