/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TransferBox, type TransferItem } from './transfer-box'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options
      if (options && typeof options === 'object') {
        const fallback = (options as { defaultValue?: unknown }).defaultValue
        if (typeof fallback === 'string') return fallback
      }
      return key
    },
  }),
}))

const items: TransferItem[] = [
  { id: 'a', label: 'alpha' },
  { id: 'b', label: 'beta' },
  { id: 'c', label: 'gamma' },
]

function renderBox(props: {
  onGrantAll: (ids: string[]) => void
  filterValue?: string
}) {
  return render(
    <TransferBox
      title="TITLE"
      availableLabel="AVAILABLE"
      includedLabel="INCLUDED"
      available={items}
      included={[]}
      filterValue={props.filterValue ?? ''}
      onFilterChange={() => {}}
      filterPlaceholder="FILTER"
      availableEmptyText="NO_AVAILABLE"
      includedEmptyText="NO_INCLUDED"
      onSelect={() => {}}
      onGrant={() => {}}
      onRevoke={() => {}}
      onGrantAll={props.onGrantAll}
      onRevokeAll={() => {}}
      moveLabels={{
        grantAll: 'GRANT_ALL',
        grantSelected: 'GRANT_SELECTED',
        revokeSelected: 'REVOKE_SELECTED',
        revokeAll: 'REVOKE_ALL',
      }}
    />
  )
}

describe('TransferBox 全选搬运', () => {
  // 回归：过滤后点「全选」此前搬的是全量数据，应该只搬当前可见（过滤后）的条目。
  // 过滤词用 'alp'：只命中 alpha（'a' 会连 beta/gamma 一起命中——三个 label 都含 a）。
  it('有过滤词时只搬运匹配的条目', async () => {
    const user = userEvent.setup()
    const onGrantAll = vi.fn()
    renderBox({ onGrantAll, filterValue: 'alp' })

    await user.click(screen.getByRole('button', { name: 'GRANT_ALL' }))

    expect(onGrantAll).toHaveBeenCalledTimes(1)
    expect(onGrantAll).toHaveBeenCalledWith(['a'])
  })

  it('没有过滤词时搬运全部条目', async () => {
    const user = userEvent.setup()
    const onGrantAll = vi.fn()
    renderBox({ onGrantAll })

    await user.click(screen.getByRole('button', { name: 'GRANT_ALL' }))

    expect(onGrantAll).toHaveBeenCalledWith(['a', 'b', 'c'])
  })
})
