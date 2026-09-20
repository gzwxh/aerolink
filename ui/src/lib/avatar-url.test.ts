import { describe, expect, it } from 'vitest'

import { normalizeAvatarUrl } from './avatar-url'

describe('normalizeAvatarUrl', () => {
  it('把 GitHub 页面链接转成 raw 直链', () => {
    expect(
      normalizeAvatarUrl(
        'https://github.com/fastapiadmin/FastapiAdmin/blob/master/frontend/web/public/logo.png'
      )
    ).toBe(
      'https://raw.githubusercontent.com/fastapiadmin/FastapiAdmin/master/frontend/web/public/logo.png'
    )
  })

  it('去掉页面链接上的查询串与 hash', () => {
    expect(
      normalizeAvatarUrl(
        'https://github.com/o/r/blob/main/a/b.png?raw=true#L1'
      )
    ).toBe('https://raw.githubusercontent.com/o/r/main/a/b.png')
  })

  it('已经指向 raw 的链接同样归一化', () => {
    expect(
      normalizeAvatarUrl('https://github.com/o/r/raw/main/a.png')
    ).toBe('https://raw.githubusercontent.com/o/r/main/a.png')
  })

  it('普通图片直链原样返回', () => {
    const url = 'https://avatars.githubusercontent.com/u/1?v=4'
    expect(normalizeAvatarUrl(url)).toBe(url)
    expect(normalizeAvatarUrl('https://img.example.com/a.png')).toBe(
      'https://img.example.com/a.png'
    )
  })

  it('空值与空白返回空字符串', () => {
    expect(normalizeAvatarUrl('')).toBe('')
    expect(normalizeAvatarUrl('   ')).toBe('')
    expect(normalizeAvatarUrl(undefined)).toBe('')
  })
})
