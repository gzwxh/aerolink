import { describe, expect, it } from 'vitest'

import { isClusterScopedOnly, isNodeOnlyRole } from './node-permissions'

describe('isClusterScopedOnly', () => {
  it('is false for an empty resource list', () => {
    expect(isClusterScopedOnly([])).toBe(false)
  })

  it('is true when every granted resource is cluster-scoped', () => {
    expect(isClusterScopedOnly(['nodes'])).toBe(true)
  })

  it('is false when a namespaced resource is granted too', () => {
    expect(isClusterScopedOnly(['nodes', 'pods'])).toBe(false)
  })

  it('is false for wildcard grants', () => {
    expect(isClusterScopedOnly(['*'])).toBe(false)
    expect(isClusterScopedOnly(['*', 'nodes'])).toBe(false)
  })
})

describe('isNodeOnlyRole', () => {
  it('is true only for a nodes-only grant', () => {
    expect(isNodeOnlyRole(['nodes'])).toBe(true)
  })

  it('is false for other resources', () => {
    expect(isNodeOnlyRole(['pods'])).toBe(false)
    expect(isNodeOnlyRole(['nodes', 'pods'])).toBe(false)
    expect(isNodeOnlyRole([])).toBe(false)
  })
})
