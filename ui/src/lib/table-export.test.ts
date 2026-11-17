import { describe, expect, it } from 'vitest'

import { escapeCsvCell, toCsv } from './table-export'

describe('escapeCsvCell', () => {
  it('quotes values containing comma, quote or line break', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('keeps plain values as-is', () => {
    expect(escapeCsvCell('node-1')).toBe('node-1')
    expect(escapeCsvCell(0)).toBe('0')
    expect(escapeCsvCell(false)).toBe('false')
  })

  it('normalizes empty values and lists', () => {
    expect(escapeCsvCell(null)).toBe('')
    expect(escapeCsvCell(undefined)).toBe('')
    expect(escapeCsvCell(['a=1', 'b=2'])).toBe('a=1; b=2')
    // 对象序列化成 JSON，其中的引号按 CSV 规则翻倍
    expect(escapeCsvCell({ a: 1 })).toBe('"{""a"":1}"')
  })
})

describe('toCsv', () => {
  it('writes a header row followed by CRLF-separated rows', () => {
    expect(
      toCsv(
        ['Name', 'Status'],
        [
          ['node-1', 'Ready'],
          ['node-2', 'NotReady, cordoned'],
        ]
      )
    ).toBe('Name,Status\r\nnode-1,Ready\r\nnode-2,"NotReady, cordoned"')
  })
})
