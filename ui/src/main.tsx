import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'

import './index.css'
import './i18n'

import { AppearanceProvider } from './components/appearance-provider'
import { AuthProvider } from './contexts/auth-context'
import { BrandingProvider } from './contexts/branding-context'
import { SidebarConfigProvider } from './contexts/sidebar-config-context'
import { QueryProvider } from './lib/query-provider'
import { router } from './routes'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <AppearanceProvider
        defaultTheme="system"
        defaultColorTheme="default"
        defaultFont="maple"
      >
        <AuthProvider>
          {/* 品牌配置（logo / 名称）来自公开的 bootstrap 接口，因此放在路由之外，
              登录页与初始化页也能读到同一份配置。 */}
          <BrandingProvider>
            <SidebarConfigProvider>
              <RouterProvider router={router} />
            </SidebarConfigProvider>
          </BrandingProvider>
        </AuthProvider>
      </AppearanceProvider>
    </QueryProvider>
  </StrictMode>
)
