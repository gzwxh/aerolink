import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { KeyValueDataViewer } from './key-value-data-viewer'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) => {
      if (typeof options === 'string') return options
      if (!options) return key
      const template =
        typeof options.defaultValue === 'string' ? options.defaultValue : key
      // 简易插值，够覆盖 {{key}} / {{total}} 这类占位符
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(options[name] ?? '')
      )
    },
  }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('KeyValueDataViewer', () => {
  it('打码时只渲染 ***，明文不进入 DOM', () => {
    render(
      <KeyValueDataViewer entries={{ 'ca.key': 'super-secret' }} sensitive />
    )

    expect(screen.queryByText('super-secret')).toBeNull()
    expect(screen.getAllByText('***')).toHaveLength(1)
  })

  it('点「显示」后才渲染明文', () => {
    render(
      <KeyValueDataViewer entries={{ 'ca.key': 'super-secret' }} sensitive />
    )

    fireEvent.click(screen.getByTitle('显示'))
    expect(screen.getByText('super-secret')).toBeTruthy()
  })

  it('未提供 onSave 时不显示编辑入口', () => {
    render(<KeyValueDataViewer entries={{ a: 'b25l' }} />)

    expect(screen.queryByText('编辑')).toBeNull()
  })

  it('canEdit=false 时即使提供 onSave 也不显示编辑入口', () => {
    render(
      <KeyValueDataViewer
        entries={{ a: 'b25l' }}
        canEdit={false}
        onSave={vi.fn()}
      />
    )

    expect(screen.queryByText('编辑')).toBeNull()
  })

  it('编辑态可以修改、新增与删除条目，保存回传明文 map', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <KeyValueDataViewer
        entries={{ a: btoa('one'), b: btoa('two') }}
        base64Encoded
        onSave={onSave}
      />
    )

    fireEvent.click(screen.getByText('编辑'))
    // 编辑态展示的是解码后的明文
    expect(screen.getByDisplayValue('one')).toBeTruthy()

    fireEvent.change(screen.getByDisplayValue('one'), {
      target: { value: 'updated' },
    })

    // 删除第二条
    fireEvent.click(screen.getAllByLabelText('删除')[1])

    // 新增一条
    fireEvent.click(screen.getByText('新增条目'))
    const keyInputs = screen.getAllByPlaceholderText('键')
    const valueInputs = screen.getAllByPlaceholderText('值')
    fireEvent.change(keyInputs[keyInputs.length - 1], {
      target: { value: 'c' },
    })
    fireEvent.change(valueInputs[valueInputs.length - 1], {
      target: { value: 'three' },
    })

    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ a: 'updated', c: 'three' })
  })

  it('键重复时阻止保存并提示', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<KeyValueDataViewer entries={{ a: '1' }} onSave={onSave} />)

    fireEvent.click(screen.getByText('编辑'))
    fireEvent.click(screen.getByText('新增条目'))
    const keyInputs = screen.getAllByPlaceholderText('键')
    fireEvent.change(keyInputs[keyInputs.length - 1], {
      target: { value: 'a' },
    })

    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(screen.getByText(/键 a 重复/)).toBeTruthy())
    expect(onSave).not.toHaveBeenCalled()
  })
})
