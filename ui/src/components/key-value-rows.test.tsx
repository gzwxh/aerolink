/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ValueRows } from './key-value-rows'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// 配置内容（nginx.conf、证书、token、JSON）本来就是多行的，
// 值输入框必须是文本域，否则既看不全也不好编辑。
const baseProps = {
  rows: [{ key: 'app.conf', value: 'server {\n  listen 80;\n}' }],
  mode: 'text' as const,
  keyPlaceholder: 'key-placeholder',
  valuePlaceholder: 'value-placeholder',
  chooseFileLabel: 'choose file',
  binaryLoadedLabel: 'loaded',
  removeLabel: 'Remove',
  onKeyChange: vi.fn(),
  onValueChange: vi.fn(),
  onRemove: vi.fn(),
  onPickFile: vi.fn(),
}

describe('ValueRows 的值输入框', () => {
  it('多行模式下值是文本域，并且保留换行', () => {
    render(<ValueRows {...baseProps} multilineValues />)

    const field = screen.getByPlaceholderText('value-placeholder')
    expect(field.tagName).toBe('TEXTAREA')
    expect(field).toHaveValue('server {\n  listen 80;\n}')
  })

  it('未开启多行时仍是单行输入框', () => {
    render(<ValueRows {...baseProps} />)

    expect(screen.getByPlaceholderText('value-placeholder').tagName).toBe(
      'INPUT'
    )
  })

  it('敏感值在多行模式下默认遮住，点「显示」后换成文本域', () => {
    render(<ValueRows {...baseProps} maskValues multilineValues />)

    const masked = screen.getByPlaceholderText('value-placeholder')
    expect(masked.tagName).toBe('INPUT')
    expect(masked).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: '显示' }))

    const revealed = screen.getByPlaceholderText('value-placeholder')
    expect(revealed.tagName).toBe('TEXTAREA')
    expect(revealed).toHaveValue('server {\n  listen 80;\n}')
  })
})
