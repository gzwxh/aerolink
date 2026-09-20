/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MFAEnrollmentGate } from './mfa-enrollment-gate'

const { mockUseAuth, setupCurrentUserMFA, enableCurrentUserMFA, logout } =
  vi.hoisted(() => ({
    mockUseAuth: vi.fn(),
    setupCurrentUserMFA: vi.fn(),
    enableCurrentUserMFA: vi.fn(),
    logout: vi.fn(),
  }))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: mockUseAuth,
}))

vi.mock('@/lib/api', () => ({
  setupCurrentUserMFA,
  enableCurrentUserMFA,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// 用标记串替掉真实文案：断言不依赖某个语言包的具体措辞。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'mfaEnrollment.continue': 'CONTINUE',
        'mfaEnrollment.passwordLabel': 'PASSWORD_LABEL',
        'mfaEnrollment.reauthAction': 'REAUTH_ACTION',
        'mfaEnrollment.directoryStepHint': 'DIRECTORY_STEP_HINT',
        'mfaEnrollment.passwordStepHint': 'PASSWORD_STEP_HINT',
        'mfaEnrollment.errors.passwordRequired': 'PASSWORD_REQUIRED',
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

// 目录账号（LDAP）在 Kite 里没有可提交的口令：向导不索要密码，
// 后端按「最近重新登录过」判定，不满足时给出重新登录的入口。
describe('被强制绑定 MFA 时的向导', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    setupCurrentUserMFA.mockReset()
    enableCurrentUserMFA.mockReset()
    logout.mockReset()
  })

  it('本地密码账号仍然索要当前密码', async () => {
    mockUseAuth.mockReturnValue({
      user: authUser('password', { mfa_required: true, mfa_enabled: false }),
      logout,
    })
    setupCurrentUserMFA.mockResolvedValue({
      secret: 'S',
      otpauth_url: 'otpauth://x',
      qr_code: 'data:image/png;base64,AA',
    })

    render(
      <MFAEnrollmentGate>
        <div>APP</div>
      </MFAEnrollmentGate>
    )

    expect(screen.queryByText('APP')).not.toBeInTheDocument()
    const password = screen.getByLabelText('PASSWORD_LABEL')
    fireEvent.change(password, { target: { value: 'old-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }))

    await waitFor(() =>
      expect(setupCurrentUserMFA).toHaveBeenCalledWith('old-secret')
    )
  })

  it('LDAP 账号不索要密码，直接发起绑定', async () => {
    mockUseAuth.mockReturnValue({
      user: authUser('ldap', { mfa_required: true, mfa_enabled: false }),
      logout,
    })
    setupCurrentUserMFA.mockResolvedValue({
      secret: 'S',
      otpauth_url: 'otpauth://x',
      qr_code: 'data:image/png;base64,AA',
    })

    render(
      <MFAEnrollmentGate>
        <div>APP</div>
      </MFAEnrollmentGate>
    )

    expect(screen.queryByLabelText('PASSWORD_LABEL')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }))

    await waitFor(() =>
      expect(setupCurrentUserMFA).toHaveBeenCalledWith(undefined)
    )
  })

  it('会话过旧时提示重新登录，而不是把密码框塞给目录账号', async () => {
    mockUseAuth.mockReturnValue({
      user: authUser('ldap', { mfa_required: true, mfa_enabled: false }),
      logout,
    })
    setupCurrentUserMFA.mockRejectedValue({ code: 'mfa_reauth_required' })

    render(
      <MFAEnrollmentGate>
        <div>APP</div>
      </MFAEnrollmentGate>
    )

    fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }))

    const relogin = await screen.findByRole('button', {
      name: 'REAUTH_ACTION',
    })
    fireEvent.click(relogin)
    expect(logout).toHaveBeenCalled()
  })

  it('不需要绑定时直接渲染子节点', () => {
    mockUseAuth.mockReturnValue({
      user: authUser('password', { mfa_required: false, mfa_enabled: false }),
      logout,
    })

    render(
      <MFAEnrollmentGate>
        <div>APP</div>
      </MFAEnrollmentGate>
    )

    expect(screen.getByText('APP')).toBeInTheDocument()
    expect(setupCurrentUserMFA).not.toHaveBeenCalled()
  })
})
