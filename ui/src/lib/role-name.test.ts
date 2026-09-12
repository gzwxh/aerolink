import { describe, expect, it } from 'vitest'

import { applyRoleNamePrefix, normalizeRoleName } from './role-name'

describe('normalizeRoleName', () => {
  it('returns the name unchanged when no prefix is configured', () => {
    expect(normalizeRoleName('wangxinghong')).toBe('wangxinghong')
  })

  it('adds the prefix when the name does not have it', () => {
    expect(normalizeRoleName('wangxinghong', 'node-')).toBe('node-wangxinghong')
  })

  it('does not double an existing prefix', () => {
    expect(normalizeRoleName('node-wangxinghong', 'node-')).toBe(
      'node-wangxinghong'
    )
  })

  it('falls back to the bare prefix for empty or partial prefixes', () => {
    expect(normalizeRoleName('', 'node-')).toBe('node-')
    expect(normalizeRoleName('   ', 'node-')).toBe('node-')
    expect(normalizeRoleName('no', 'node-')).toBe('node-')
    expect(normalizeRoleName('node', 'node-')).toBe('node-')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeRoleName('  node-web  ', 'node-')).toBe('node-web')
    expect(normalizeRoleName('  web  ', 'node-')).toBe('node-web')
  })
})

describe('applyRoleNamePrefix', () => {
  it('keeps a value that already carries the prefix', () => {
    expect(applyRoleNamePrefix('node-web', 'node-')).toBe('node-web')
  })

  it('leaves a partially deleted prefix alone while typing', () => {
    expect(applyRoleNamePrefix('node', 'node-')).toBe('node')
    expect(applyRoleNamePrefix('no', 'node-')).toBe('no')
    expect(applyRoleNamePrefix('', 'node-')).toBe('')
  })

  it('prepends the prefix to anything else', () => {
    expect(applyRoleNamePrefix('web', 'node-')).toBe('node-web')
    expect(applyRoleNamePrefix('mynode-web', 'node-')).toBe('node-mynode-web')
  })

  it('is a no-op without a prefix', () => {
    expect(applyRoleNamePrefix('web', undefined)).toBe('web')
  })
})
