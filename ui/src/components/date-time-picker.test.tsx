/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DateTimePicker } from './date-time-picker'

vi.mock('react-i18next', () => ({
  // 组件只用 t(key, defaultValue)，直接回 defaultValue；日期按钮按数字取。
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
  }),
}))

function pad(value: number) {
  return String(value).padStart(2, '0')
}

describe('DateTimePicker', () => {
  it('没选过时显示占位文案', () => {
    render(<DateTimePicker value="" onChange={vi.fn()} />)

    expect(screen.getByRole('button')).toHaveTextContent('选择时间')
  })

  it('点日历上的日期再确认，回写本地时间字符串', () => {
    const onChange = vi.fn()
    render(<DateTimePicker value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button'))
    // 月历默认落在当前月份，所以 15 号就是本月的 15 号。
    fireEvent.click(screen.getByRole('button', { name: '15' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    const now = new Date()
    expect(onChange).toHaveBeenCalledWith(
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-15 00:00:00`
    )
  })

  it('可以清空已选的时间', () => {
    const onChange = vi.fn()
    render(<DateTimePicker value="2026-09-21 22:00:00" onChange={onChange} />)

    expect(screen.getByRole('button')).toHaveTextContent('2026-09-21 22:00:00')

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    expect(onChange).toHaveBeenCalledWith('')
  })

  // 打开面板只是拷一份草稿，没点确认就关掉时不能改外部状态。
  it('只关掉面板不会回写', () => {
    const onChange = vi.fn()
    render(<DateTimePicker value="2026-09-21 22:00:00" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: '15' }))
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })

    expect(onChange).not.toHaveBeenCalled()
  })
})
