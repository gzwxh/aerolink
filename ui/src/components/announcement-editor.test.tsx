/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AnnouncementEditor } from './announcement-editor'

vi.mock('react-i18next', () => {
  // 与 zh.json 同口径的色名：`t('…colors.<name>')` 这条调用没有 defaultValue，
  // 落到这里回显，测试里才能按中文名去找色块。
  const COLOR_LABELS: Record<string, string> = {
    primary: '主题色',
    muted: '次要灰',
    info: '信息蓝',
    success: '成功绿',
    warning: '警告橙',
    attention: '提示黄',
    danger: '危险红',
  }
  return {
    // 组件用 t(key, defaultValue)：有 defaultValue 就用它，否则按上面的表兜底。
    useTranslation: () => ({
      t: (key: string, options?: unknown) => {
        if (typeof options === 'string') {
          return options
        }
        if (options && typeof options === 'object') {
          const { defaultValue } = options as { defaultValue?: string }
          return defaultValue ?? key
        }
        if (key.startsWith('notifications.announcements.colors.')) {
          const name = key.slice(key.lastIndexOf('.') + 1)
          return COLOR_LABELS[name] ?? name
        }
        return key
      },
    }),
  }
})

/** 受控外壳：编辑器是受控组件，断言最终回写的标记。 */
function Harness({ initial = '今晚停服' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <AnnouncementEditor value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  )
}

function selectAllInEditor() {
  const box = screen.getByRole('textbox')
  const range = document.createRange()
  range.selectNodeContents(box)
  const selection = window.getSelection()
  if (!selection) {
    throw new Error('jsdom 没有 Selection')
  }
  selection.removeAllRanges()
  selection.addRange(range)
  return box
}

describe('AnnouncementEditor', () => {
  it('挂载时把已有标记铺成带样式的 DOM', () => {
    render(<Harness initial="{warning}停服{/warning} **注意**" />)

    const box = screen.getByRole('textbox')
    expect(
      box.querySelector('span[data-announcement-color="warning"]')
    ).not.toBeNull()
    expect(box.querySelector('strong')).not.toBeNull()
    expect(box.textContent).toBe('停服 注意')
  })

  // 所见即所得的核心：选中文字点「加粗」，输入区里立刻出现 <strong>，回写的仍是受控标记。
  it('选中文字点加粗会就地加粗并回写标记', () => {
    render(<Harness />)

    const box = selectAllInEditor()
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))

    expect(box.querySelector('strong')?.textContent).toBe('今晚停服')
    expect(screen.getByTestId('value')).toHaveTextContent('**今晚停服**')
  })

  it('再点一次同一个按钮会取消加粗', () => {
    render(<Harness />)

    selectAllInEditor()
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))
    selectAllInEditor()
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))

    expect(screen.getByRole('textbox').querySelector('strong')).toBeNull()
    expect(screen.getByTestId('value')).toHaveTextContent('今晚停服')
  })

  // 颜色收在「A + 色线」按钮的色板里，不再平铺在工具栏上（见 announcement-editor.tsx）。
  it('选中文字后从色板选色会包一层带语义色的 span 并回写标记', () => {
    render(<Harness />)

    const box = selectAllInEditor()
    fireEvent.click(screen.getByRole('button', { name: '文字颜色' }))
    fireEvent.click(screen.getByRole('button', { name: '警告橙' }))

    const span = box.querySelector('span[data-announcement-color="warning"]')
    expect(span?.textContent).toBe('今晚停服')
    // 编辑器里用语义 token 上色（跟随配色主题），落库仍是标记。
    expect(span?.className).toBe('text-warning')
    expect(screen.getByTestId('value')).toHaveTextContent(
      '{warning}今晚停服{/warning}'
    )
  })

  it('色板里的「默认颜色」摘掉颜色标记但保留文字', () => {
    render(<Harness initial="{warning}今晚停服{/warning}" />)

    selectAllInEditor()
    fireEvent.click(screen.getByRole('button', { name: '文字颜色' }))
    fireEvent.click(screen.getByRole('button', { name: '默认颜色' }))

    const box = screen.getByRole('textbox')
    expect(box.querySelector('[data-announcement-color]')).toBeNull()
    expect(box.textContent).toBe('今晚停服')
    expect(screen.getByTestId('value')).toHaveTextContent('今晚停服')
  })

  it('色板默认收起，选完颜色后自动收起', () => {
    render(<Harness />)

    selectAllInEditor()
    expect(screen.queryByRole('group', { name: '选择颜色' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '文字颜色' }))
    expect(screen.getByRole('group', { name: '选择颜色' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '警告橙' }))
    expect(screen.queryByRole('group', { name: '选择颜色' })).toBeNull()
  })

  it('没有选区时点按钮不改动内容', () => {
    render(<Harness />)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))

    expect(screen.getByTestId('value')).toHaveTextContent('今晚停服')
    expect(screen.getByRole('textbox').querySelector('strong')).toBeNull()
  })

  it('粘贴只取纯文本，丢掉外部样式', () => {
    render(<Harness />)

    selectAllInEditor()
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        getData: () => '<b>带标签的</b>',
      },
    })

    expect(screen.getByRole('textbox').textContent).toBe('<b>带标签的</b>')
    expect(screen.getByTestId('value')).toHaveTextContent('<b>带标签的</b>')
  })

  it('选中文字加链接会包成 a 并回写链接标记', () => {
    render(<Harness />)

    const box = selectAllInEditor()
    fireEvent.click(screen.getByRole('button', { name: '链接' }))
    fireEvent.change(screen.getByLabelText('链接地址'), {
      target: { value: 'https://example.com/ops' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))

    const link = box.querySelector('a')
    expect(link?.textContent).toBe('今晚停服')
    expect(link?.getAttribute('href')).toBe('https://example.com/ops')
    expect(screen.getByTestId('value')).toHaveTextContent(
      '[今晚停服](https://example.com/ops)'
    )
  })

  it('清除格式摘掉加粗与颜色，文字保留', () => {
    render(<Harness initial="**注意**{warning}停服{/warning}" />)

    const box = selectAllInEditor()
    fireEvent.click(screen.getByRole('button', { name: '清除格式' }))

    expect(box.querySelector('strong')).toBeNull()
    expect(box.querySelector('[data-announcement-color]')).toBeNull()
    expect(box.textContent).toBe('注意停服')
    expect(screen.getByTestId('value')).toHaveTextContent('注意停服')
  })

  // 源码模式是显式的第二套输入界面：不转义，切回来时再按标记铺 DOM。
  it('Markdown 模式原文照写，切回所见即所得后按标记渲染', () => {
    render(<Harness initial="**注意**" />)

    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    const source = screen.getByRole('textbox')
    expect(source.tagName).toBe('TEXTAREA')

    fireEvent.change(source, { target: { value: '**更粗** 与 # 不是标题' } })

    expect(screen.getByTestId('value')).toHaveTextContent(
      '**更粗** 与 # 不是标题'
    )
    // 预览走顶栏那套渲染：星号已经变成加粗。
    expect(screen.getByText('更粗').tagName).toBe('STRONG')

    fireEvent.click(screen.getByRole('button', { name: '所见即所得' }))
    expect(
      screen.getByRole('textbox').querySelector('strong')?.textContent
    ).toBe('更粗')
  })

  it('只读时不可编辑且工具栏按钮禁用', () => {
    render(
      <AnnouncementEditor
        value="停服"
        onChange={vi.fn()}
        disabled
        labelledBy="x"
      />
    )

    expect(screen.getByRole('textbox')).toHaveAttribute(
      'contenteditable',
      'false'
    )
    expect(screen.getByRole('button', { name: '加粗' })).toBeDisabled()
  })
})
