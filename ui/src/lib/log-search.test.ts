import { describe, expect, it } from 'vitest'

import { findTermRanges, normalizeSearchTerm } from './log-search'

describe('findTermRanges', () => {
  it('returns empty for empty term or no match', () => {
    expect(findTermRanges('hello world', '')).toEqual([])
    expect(findTermRanges('hello world', 'foo')).toEqual([])
  })

  it('matches case-insensitively', () => {
    expect(findTermRanges('Error: bad ERROR', 'error')).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
    ])
  })

  it('finds adjacent and repeated occurrences', () => {
    expect(findTermRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  it('matches CJK text', () => {
    expect(findTermRanges('部署完成，部署失败', '部署')).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ])
  })

  it('treats the whole phrase with spaces as one keyword', () => {
    const line = 'I1013 10:48:35.394999    14 warnings.go:107] unknown field'
    expect(findTermRanges(line, 'I1013 10:48:35.394999')).toEqual([
      { start: 0, end: 21 },
    ])
    expect(
      findTermRanges(line, 'Warning: unknown field "status"')
    ).toEqual([])
  })

  it('matches keyword copied with non-breaking spaces', () => {
    const line = 'I1013 10:48:35.394999    14 warnings.go:107] unknown field'
    const copied = 'I1013\u00a010:48:35.394999'
    expect(findTermRanges(line, copied)).toEqual([{ start: 0, end: 21 }])
    expect(line.includes(copied)).toBe(false)
  })

  it('strips newlines from keyword before matching', () => {
    expect(findTermRanges('hello world', 'hello\n')).toEqual([
      { start: 0, end: 5 },
    ])
    expect(findTermRanges('hello world', 'he\r\nllo')).toEqual([
      { start: 0, end: 5 },
    ])
  })

  it('normalizeSearchTerm strips line breaks and normalizes NBSP', () => {
    expect(normalizeSearchTerm('I1013 10:48:35.394999\n')).toBe(
      'I1013 10:48:35.394999'
    )
    expect(normalizeSearchTerm('a\u00a0b')).toBe('a b')
  })
})
