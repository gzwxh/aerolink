import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SettingsSectionProvider,
  useSettingsSectionAccess,
} from './settings-section-context'

// useAuth 会拉起整个 AuthProvider（bootstrap + react-query），这里只需要它对章节
// 权限的判断，所以替换掉。
const { canManageSettingsSection } = vi.hoisted(() => ({
  canManageSettingsSection: vi.fn<(section: string) => boolean>(),
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { canManageSettingsSection } }),
}))

function Probe() {
  const { section, readOnly } = useSettingsSectionAccess()
  return <span data-testid="state">{`${section}|${readOnly}`}</span>
}

describe('useSettingsSectionAccess', () => {
  beforeEach(() => {
    canManageSettingsSection.mockReset()
  })

  it('is read-only when the user cannot manage the section', () => {
    canManageSettingsSection.mockReturnValue(false)

    render(
      <SettingsSectionProvider section="audit">
        <Probe />
      </SettingsSectionProvider>
    )

    // 章节名透传 + 只读，界面据此收起写入口。
    expect(screen.getByTestId('state').textContent).toBe('audit|true')
    expect(canManageSettingsSection).toHaveBeenCalledWith('audit')
  })

  it('is writable when the user manages the section', () => {
    canManageSettingsSection.mockReturnValue(true)

    render(
      <SettingsSectionProvider section="rbac">
        <Probe />
      </SettingsSectionProvider>
    )

    expect(screen.getByTestId('state').textContent).toBe('rbac|false')
  })

  it('defaults to writable outside a settings section', () => {
    // 没有 Provider 时（例如组件被非设置页复用）不改变行为：后端仍然是最终边界。
    render(<Probe />)

    expect(screen.getByTestId('state').textContent).toBe('|false')
    expect(canManageSettingsSection).not.toHaveBeenCalled()
  })
})
