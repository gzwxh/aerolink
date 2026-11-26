/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SecuritySetting } from '@/lib/api'

import { SecurityManagement } from './security-management'

// 回归（验收台账 D-167）：安全设置是**全局即时生效**的准入策略，以前点「提交」直接
// 就 PUT —— 把「仅允许指定来源登录」「仅允许已存在用户登录」「强制全员 MFA」打开，
// 配错就把自己和其他管理员一起关在门外，而平台没有恢复登录的入口。
// findLockoutRisks 自身的判定规则在 lib/security-lockout.test.ts 里钉；
// 这里钉的是**页面真的拦了下来**（漏接线正是 D-123 那类缺陷的形态）。

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh' },
  }),
}))

// 落到 loginPolicy 页签：危险字段都在那一页（组件从 URL 参数取当前页签）。
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams('tab=loginPolicy'), vi.fn()],
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { canViewSettingsSection: () => true } }),
}))

vi.mock('@/contexts/settings-section-context', () => ({
  SettingsSectionProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useSettingsSectionAccess: () => ({ readOnly: false }),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// 兄弟页签与侧板与被测路径无关，桩掉避免拖进一堆依赖
vi.mock('./authentication-management', () => ({
  AuthenticationManagement: () => null,
}))
vi.mock('./user-status-panel', () => ({ UserStatusPanel: () => null }))

let currentSetting: SecuritySetting
const mockUpdate = vi.fn()
vi.mock('@/lib/api', () => ({
  useSecuritySetting: () => ({ data: currentSetting, isLoading: false }),
  updateSecuritySetting: (payload: SecuritySetting) => mockUpdate(payload),
  fetchLockedLoginIPs: () => Promise.resolve({ items: [] }),
  fetchLockedLoginUsers: () => Promise.resolve({ items: [] }),
  blockLoginIP: vi.fn(),
  unblockLoginIP: vi.fn(),
  blockLoginUser: vi.fn(),
  unblockLoginUser: vi.fn(),
}))

const base = (): SecuritySetting => ({
  loginCaptchaEnabled: false,
  inactiveUserDisableDays: 999,
  defaultUserEnabled: true,
  defaultUserExpireDays: 0,
  remoteLoginNoticeEnabled: true,
  mfaPolicy: 'disabled',
  mfaThirdPartyEnabled: true,
  mfaStepUpEnabled: true,
  mfaVerifyTtlSeconds: 60,
  otpIssuerName: '鸢联 AeroLink',
  otpVerifyWindow: 2,
  userLoginFailLimit: 7,
  userLoginBlockMinutes: 30,
  ipLoginFailLimit: 5,
  ipLoginBlockMinutes: 30,
  ipWhitelist: [],
  ipBlacklist: [],
  singleDeviceLogin: false,
  rejectUnknownUsers: false,
  loginSourceEnforced: false,
  loginSourceAllowlist: [],
  passwordExpireDays: 900,
  passwordHistoryCount: 5,
  passwordMinLength: 8,
  passwordMinClasses: 3,
  adminPasswordMinLength: 12,
  passwordRequireUppercase: true,
  passwordRequireLowercase: true,
  passwordRequireDigit: true,
  passwordRequireSpecial: true,
  sessionExpireOnBrowserClose: true,
  sessionMaxIdleMinutes: 600,
  sessionMaxHours: 24,
})

/** SettingRow 的 label 与开关没有 aria 关联，按结构定位到所在行再取开关。 */
function switchOf(labelKey: string): HTMLElement {
  const label = screen.getByText(labelKey)
  const row = label.closest('div.flex')
  if (!row) throw new Error(`找不到 ${labelKey} 所在行`)
  return within(row as HTMLElement).getByRole('switch')
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SecurityManagement />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  currentSetting = base()
})

describe('安全设置提交前对收紧项的确认', () => {
  it('收紧准入策略时先确认，确认前不发请求', async () => {
    renderPage()
    const user = userEvent.setup()

    await user.click(switchOf('securitySettings.fields.rejectUnknownUsers'))
    await user.click(
      screen.getByRole('button', { name: 'common.actions.submit' })
    )

    // 弹窗列出具体是哪一项，而不是只问「确定吗」
    expect(
      await screen.findByText('securitySettings.lockoutConfirm.title')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'securitySettings.lockoutConfirm.risks.rejectUnknownUsers'
      )
    ).toBeInTheDocument()
    // 关键：还没写库
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('确认后才真正提交', async () => {
    renderPage()
    const user = userEvent.setup()

    await user.click(switchOf('securitySettings.fields.rejectUnknownUsers'))
    await user.click(
      screen.getByRole('button', { name: 'common.actions.submit' })
    )
    await user.click(
      await screen.findByRole('button', {
        name: 'securitySettings.lockoutConfirm.confirm',
      })
    )

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate.mock.calls[0][0].rejectUnknownUsers).toBe(true)
  })

  it('取消确认则不提交，页面回到可继续编辑', async () => {
    renderPage()
    const user = userEvent.setup()

    await user.click(switchOf('securitySettings.fields.rejectUnknownUsers'))
    await user.click(
      screen.getByRole('button', { name: 'common.actions.submit' })
    )
    await user.click(
      await screen.findByRole('button', { name: 'common.actions.cancel' })
    )

    expect(mockUpdate).not.toHaveBeenCalled()
    expect(
      screen.queryByText('securitySettings.lockoutConfirm.title')
    ).not.toBeInTheDocument()
  })

  // 反向：松绑与无关改动不该弹窗，否则确认会变成噪声（同 D-113 的把关强度取舍）。
  it('不含收紧的改动照常直接提交', async () => {
    currentSetting = { ...base(), rejectUnknownUsers: true }
    renderPage()
    const user = userEvent.setup()

    // 关掉它属于放宽
    await user.click(switchOf('securitySettings.fields.rejectUnknownUsers'))
    await user.click(
      screen.getByRole('button', { name: 'common.actions.submit' })
    )

    expect(
      screen.queryByText('securitySettings.lockoutConfirm.title')
    ).not.toBeInTheDocument()
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate.mock.calls[0][0].rejectUnknownUsers).toBe(false)
  })
})
