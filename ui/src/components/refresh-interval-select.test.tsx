/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { RefreshIntervalSelect } from './refresh-interval-select'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

// jsdom 没有实现 Radix Select 依赖的 Pointer Events API 与 scrollIntoView。
beforeAll(() => {
  for (const [name, value] of [
    ['hasPointerCapture', () => false],
    ['setPointerCapture', () => undefined],
    ['releasePointerCapture', () => undefined],
    ['scrollIntoView', () => undefined],
  ] as const) {
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
})

describe('RefreshIntervalSelect', () => {
  it('显示当前间隔', () => {
    render(<RefreshIntervalSelect value={5000} onChange={() => undefined} />)

    expect(screen.getByRole('combobox')).toHaveTextContent('5s')
  })

  it('关闭时显示「关闭」而不是 0s', () => {
    render(<RefreshIntervalSelect value={0} onChange={() => undefined} />)

    expect(screen.getByRole('combobox')).toHaveTextContent(
      'resourceTable.refreshOff'
    )
  })

  it('列出全部可选间隔', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<RefreshIntervalSelect value={5000} onChange={() => undefined} />)

    await user.click(screen.getByRole('combobox'))

    const labels = screen
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(labels).toEqual([
      'resourceTable.refreshOff',
      '1s',
      '5s',
      '10s',
      '30s',
    ])
  })

  it('选择后以毫秒回调，关闭回调 0', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onChange = vi.fn()
    render(<RefreshIntervalSelect value={5000} onChange={onChange} />)

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: '10s' }))
    expect(onChange).toHaveBeenCalledWith(10000)

    await user.click(screen.getByRole('combobox'))
    await user.click(
      screen.getByRole('option', { name: 'resourceTable.refreshOff' })
    )
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('disabled 时不可交互', () => {
    render(
      <RefreshIntervalSelect value={5000} onChange={() => undefined} disabled />
    )

    expect(screen.getByRole('combobox')).toBeDisabled()
  })
})
