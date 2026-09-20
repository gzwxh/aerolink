/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AccountPage } from './account-page'

const { mockUseAuth } = vi.hoisted(() => ({ mockUseAuth: vi.fn() }))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: mockUseAuth,
}))

vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))

// 只关心「哪个区块被渲染」：各区块自身的行为由各自的测试覆盖。
vi.mock('@/components/account/profile-section', () => ({
  ProfileSection: () => <div>PROFILE_SECTION</div>,
}))
vi.mock('@/components/account/appearance-section', () => ({
  AppearanceSection: () => <div>APPEARANCE_SECTION</div>,
}))
vi.mock('@/components/account/password-section', () => ({
  PasswordSection: () => <div>PASSWORD_SECTION</div>,
}))
vi.mock('@/components/account/mfa-section', () => ({
  MFASection: () => <div>MFA_SECTION</div>,
}))

// 用标记串替掉真实文案：断言不依赖某个语言包的具体措辞。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'accountSettings.tabs.security': 'TAB_SECURITY',
        'accountSettings.tabs.profile': 'TAB_PROFILE',
        'accountSettings.tabs.appearance': 'TAB_APPEARANCE',
      }
      return map[key] ?? fallback ?? key
    },
  }),
}))

const authUser = (provider: string, extra: Record<string, unknown> = {}) => ({
  id: '1',
  username: 'alice',
  name: 'Alice',
  avatar_url: '',
  provider,
  ...extra,
})

const renderPage = (tab = 'security') =>
  render(
    <MemoryRouter initialEntries={[`/account?tab=${tab}`]}>
      <AccountPage />
    </MemoryRouter>
  )

// 「安全」页签的可见范围：能自助绑定动态码的账号（本地密码 / LDAP），
// 以及已经绑定过动态码的账号（让它仍能自行解绑）。
describe('用户信息页的安全页签', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
  })

  it('LDAP 账号能看到安全页签，但不显示改密码区块', () => {
    mockUseAuth.mockReturnValue({ user: authUser('ldap') })

    renderPage()

    expect(
      screen.getByRole('tab', { name: 'TAB_SECURITY' })
    ).toBeInTheDocument()
    expect(screen.getByText('MFA_SECTION')).toBeInTheDocument()
    expect(screen.queryByText('PASSWORD_SECTION')).not.toBeInTheDocument()
  })

  it('本地密码账号两个区块都有', () => {
    mockUseAuth.mockReturnValue({ user: authUser('password') })

    renderPage()

    expect(screen.getByText('MFA_SECTION')).toBeInTheDocument()
    expect(screen.getByText('PASSWORD_SECTION')).toBeInTheDocument()
  })

  it('OIDC 账号没有安全页签，带 ?tab=security 进来会落回基础信息', () => {
    mockUseAuth.mockReturnValue({ user: authUser('oidc') })

    renderPage()

    expect(
      screen.queryByRole('tab', { name: 'TAB_SECURITY' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('MFA_SECTION')).not.toBeInTheDocument()
    expect(screen.getByText('PROFILE_SECTION')).toBeInTheDocument()
  })

  it('已绑定动态码的 OIDC 账号仍可进来解绑', () => {
    mockUseAuth.mockReturnValue({
      user: authUser('oidc', { mfa_enabled: true }),
    })

    renderPage()

    expect(
      screen.getByRole('tab', { name: 'TAB_SECURITY' })
    ).toBeInTheDocument()
    expect(screen.getByText('MFA_SECTION')).toBeInTheDocument()
  })
})
