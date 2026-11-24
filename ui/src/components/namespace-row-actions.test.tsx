/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DeleteNamespaceDialog } from './namespace-row-actions'

// 回归（验收台账 D-113）：删命名空间会级联删掉里面所有资源，原先点「删除」就直接生效，
// 而角色 / ClusterRole / 用户组 / 权限绑定的删除都要逐字输入名称。把关强度必须一致。

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api', () => ({
  // 计数面板要发的请求：给空结果即可，被测的是底部那道输入确认。
  fetchResources: () => Promise.resolve({ items: [] }),
}))

/** 确认输入框：label 是「输入 <名称> 以确认」三段文本，只能按可访问名的正则取。 */
function confirmInput(name: string): HTMLElement {
  const input = screen.getByRole('textbox', {
    name: new RegExp(`deleteConfirmation.typeToConfirm ${name}`),
  })
  return input
}

function renderDialog(onConfirm = vi.fn()) {
  render(
    <DeleteNamespaceDialog
      name="team-a"
      deleting={false}
      onConfirm={onConfirm}
      onClose={vi.fn()}
    />
  )
  return onConfirm
}

describe('删命名空间要逐字输入名称', () => {
  it('没输入名称时删除按钮不可点', async () => {
    renderDialog()
    const user = userEvent.setup()

    const deleteBtn = screen.getByRole('button', {
      name: 'common.actions.delete',
    })
    expect(deleteBtn).toBeDisabled()

    // 输入错的名字也不算确认
    await user.type(confirmInput('team-a'), 'team-b')
    expect(deleteBtn).toBeDisabled()
  })

  it('逐字输入名称后才能删，且只触发一次', async () => {
    const onConfirm = renderDialog()
    const user = userEvent.setup()

    await user.type(confirmInput('team-a'), 'team-a')
    const deleteBtn = screen.getByRole('button', {
      name: 'common.actions.delete',
    })
    expect(deleteBtn).toBeEnabled()

    await user.click(deleteBtn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('切换目标命名空间时确认文本不残留（否则会带着上一个名字直接放行）', async () => {
    const { rerender } = render(
      <DeleteNamespaceDialog
        name="team-a"
        deleting={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const user = userEvent.setup()
    await user.type(confirmInput('team-a'), 'team-a')

    rerender(
      <DeleteNamespaceDialog
        name="team-b"
        deleting={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect((confirmInput('team-b') as HTMLInputElement).value).toBe('')
    expect(
      screen.getByRole('button', { name: 'common.actions.delete' })
    ).toBeDisabled()
  })
})
