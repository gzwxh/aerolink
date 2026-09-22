import { beforeEach, describe, expect, it } from 'vitest'

import {
  migrateLegacyKiteStorageKey,
  migrateLegacyStorageKey,
} from './storage-migration'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('migrateLegacyStorageKey', () => {
  it('旧键有值、新键为空时把值搬到新键并删掉旧键', () => {
    localStorage.setItem('kite-favorites', '["a"]')

    migrateLegacyStorageKey(
      localStorage,
      'kite-favorites',
      'aerolink-favorites'
    )

    expect(localStorage.getItem('aerolink-favorites')).toBe('["a"]')
    expect(localStorage.getItem('kite-favorites')).toBeNull()
  })

  it('新键已有值时保留新值、不动旧键（幂等）', () => {
    localStorage.setItem('kite-favorites', '["old"]')
    localStorage.setItem('aerolink-favorites', '["new"]')

    migrateLegacyStorageKey(
      localStorage,
      'kite-favorites',
      'aerolink-favorites'
    )

    expect(localStorage.getItem('aerolink-favorites')).toBe('["new"]')
    expect(localStorage.getItem('kite-favorites')).toBe('["old"]')
  })

  it('旧键为空时什么也不做', () => {
    migrateLegacyStorageKey(
      localStorage,
      'kite-favorites',
      'aerolink-favorites'
    )

    expect(localStorage.getItem('aerolink-favorites')).toBeNull()
  })

  it('存储不可访问时静默跳过，不抛错', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage

    expect(() =>
      migrateLegacyStorageKey(storage, 'kite-favorites', 'aerolink-favorites')
    ).not.toThrow()
  })
})

describe('migrateLegacyKiteStorageKey', () => {
  it('按前缀把 aerolink- 键对应到 kite- 旧键', () => {
    sessionStorage.setItem('kite-navigation-history', '{"entries":[]}')

    migrateLegacyKiteStorageKey(sessionStorage, 'aerolink-navigation-history')

    expect(sessionStorage.getItem('aerolink-navigation-history')).toBe(
      '{"entries":[]}'
    )
    expect(sessionStorage.getItem('kite-navigation-history')).toBeNull()
  })

  it('键名不带当前前缀时不做任何事', () => {
    sessionStorage.setItem('kite-navigation-history', '{"entries":[]}')

    migrateLegacyKiteStorageKey(sessionStorage, 'some-other-key')

    expect(sessionStorage.getItem('kite-navigation-history')).toBe(
      '{"entries":[]}'
    )
    expect(sessionStorage.getItem('some-other-key')).toBeNull()
  })
})
