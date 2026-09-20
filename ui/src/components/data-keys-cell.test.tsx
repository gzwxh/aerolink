/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DataKeysCell } from './data-keys-cell'

// 只关心「截断与悬浮」的行为，文案用标记串替掉。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { count?: number }) =>
      `COUNT:${options?.count}`,
  }),
}))

const keys = Array.from(
  { length: 12 },
  (_, index) => `very-long-config-key-${index}`
)

describe('数据键单元格', () => {
  it('没有键时显示占位符', () => {
    render(<DataKeysCell keys={[]} />)

    expect(screen.getByText('-')).toBeInTheDocument()
  })

  // 回归：单元格一度把键直接铺开，一个 150+ 个键的 ConfigMap 能把表格撑到两倍宽。
  it('内容带截断类（表格不会因长内容变宽）', () => {
    render(<DataKeysCell keys={keys} />)

    const cell = screen.getByText(keys.join(', '))
    expect(cell).toHaveClass('truncate')
    expect(cell).toHaveClass('max-w-72')
  })

  it('悬浮时展示键的数量与完整列表', async () => {
    render(<DataKeysCell keys={keys} />)

    await userEvent.hover(screen.getByText(keys.join(', ')))

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent(`COUNT:${keys.length}`)
    expect(tooltip).toHaveTextContent(keys[keys.length - 1])
  })
})
