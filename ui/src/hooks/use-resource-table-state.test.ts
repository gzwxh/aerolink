import { describe, expect, it } from 'vitest'

import { resolveNamespaceSelection } from './use-resource-table-state'

// 回归：默认命名空间写死 `default` 时，只有部分命名空间权限的账号一进资源页
// 就被 RBAC 拒绝。默认值必须落在「当前用户能访问的命名空间」里。
describe('resolveNamespaceSelection', () => {
  it('没有保存过选择时优先 default', () => {
    expect(resolveNamespaceSelection(undefined, ['prod', 'default'])).toBe(
      'default'
    )
  })

  it('没有 default 时取第一个可访问的命名空间', () => {
    expect(resolveNamespaceSelection(undefined, ['prod', 'test'])).toBe('prod')
  })

  it('保存的选择仍可访问时保持不变', () => {
    expect(resolveNamespaceSelection('prod', ['prod', 'test'])).toBe('prod')
  })

  it('保存的选择已无权限时回落到第一个可访问的命名空间', () => {
    expect(resolveNamespaceSelection('default', ['prod', 'test'])).toBe('prod')
  })

  it('多选时剔除已无权限的命名空间', () => {
    expect(resolveNamespaceSelection('default,prod', ['prod', 'test'])).toBe(
      'prod'
    )
  })

  it('多选全部失去权限时回落', () => {
    expect(resolveNamespaceSelection('default,dev', ['prod', 'default'])).toBe(
      'default'
    )
  })

  it('_all 是显式选择，原样保留', () => {
    expect(resolveNamespaceSelection('_all', ['prod'])).toBe('_all')
  })
})
