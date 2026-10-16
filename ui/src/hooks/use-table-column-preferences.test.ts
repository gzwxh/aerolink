import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useTableColumnSizing } from './use-table-column-preferences'

describe('useTableColumnSizing', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('从 localStorage 恢复列宽并过滤非法值', () => {
    localStorage.setItem(
      'test-sizing',
      JSON.stringify({ name: 220, age: 'x', count: NaN, ns: 0.5 })
    )
    const { result } = renderHook(() => useTableColumnSizing('test-sizing'))
    expect(result.current[0]).toEqual({ name: 220, ns: 0.5 })
  })

  it('调整列宽后写入 localStorage', () => {
    const { result } = renderHook(() => useTableColumnSizing('test-sizing'))
    act(() => result.current[1]({ name: 300 }))
    expect(JSON.parse(localStorage.getItem('test-sizing') ?? '')).toEqual({
      name: 300,
    })
  })
})
