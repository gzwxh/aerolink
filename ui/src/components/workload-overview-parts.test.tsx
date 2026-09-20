/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SelectorBadges } from './workload-overview-parts'

// 概览列比较窄，而 Selector 的键值对可能很长
// （app.kubernetes.io/instance=very-long-release-name）。以前用 truncate
// 会把它截成省略号，看不到完整内容。
describe('SelectorBadges', () => {
  it('长键值对换行显示完整内容，不再截断', () => {
    const key = 'app.kubernetes.io/instance'
    const value = 'a-very-long-release-name-that-would-not-fit'
    render(<SelectorBadges entries={[[key, value]]} />)

    const badge = screen.getByText(`${key}=${value}`)
    expect(badge).toBeInTheDocument()
    expect(badge.className).not.toContain('truncate')
    expect(badge.className).toContain('whitespace-normal')
    expect(badge.className).toContain('break-all')
    // 悬停仍能看到完整文本
    expect(badge).toHaveAttribute('title', `${key}=${value}`)
  })

  it('没有选择器时显示占位符', () => {
    render(<SelectorBadges entries={[]} />)

    expect(screen.getByText('-')).toBeInTheDocument()
  })
})
