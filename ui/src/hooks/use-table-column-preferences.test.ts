import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  useTableColumnOrder,
  useTableColumnSizing,
} from './use-table-column-preferences'

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

describe('useTableColumnOrder', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('从 localStorage 恢复列序并过滤非字符串项', () => {
    localStorage.setItem(
      'test-order',
      JSON.stringify(['b', 'a', 42, null, 'c'])
    )
    const { result } = renderHook(() => useTableColumnOrder('test-order'))
    expect(result.current[0]).toEqual(['b', 'a', 'c'])
  })

  it('调整列序后写入 localStorage', () => {
    const { result } = renderHook(() => useTableColumnOrder('test-order'))
    act(() => result.current[1](['b', 'a']))
    expect(JSON.parse(localStorage.getItem('test-order') ?? '')).toEqual([
      'b',
      'a',
    ])
  })
})
