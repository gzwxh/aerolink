import { describe, expect, it, vi } from 'vitest'

import { normalizeAvatarUrl, resolveAvatarSrc } from './avatar-url'

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
      normalizeAvatarUrl('https://github.com/o/r/blob/main/a/b.png?raw=true#L1')
    ).toBe('https://raw.githubusercontent.com/o/r/main/a/b.png')
  })

  it('已经指向 raw 的链接同样归一化', () => {
    expect(normalizeAvatarUrl('https://github.com/o/r/raw/main/a.png')).toBe(
      'https://raw.githubusercontent.com/o/r/main/a.png'
    )
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

describe('resolveAvatarSrc', () => {
  it('上传的头像（站内路径）直接可用', () => {
    expect(resolveAvatarSrc('/api/users/7/avatar?v=3')).toBe(
      '/api/users/7/avatar?v=3'
    )
  })

  it('子路径部署时补上前缀，否则浏览器会请求到根路径上', () => {
    vi.stubEnv('AEROLINK_BASE', '/kite')

    expect(resolveAvatarSrc('/api/users/7/avatar?v=3')).toBe(
      '/kite/api/users/7/avatar?v=3'
    )
  })

  it('外链交给 normalizeAvatarUrl（GitHub 页面链接转 raw）', () => {
    expect(resolveAvatarSrc('https://github.com/o/r/blob/main/a.png')).toBe(
      'https://raw.githubusercontent.com/o/r/main/a.png'
    )
    expect(resolveAvatarSrc('https://img.example.com/a.png')).toBe(
      'https://img.example.com/a.png'
    )
  })

  it('空值返回 undefined（调用方据此渲染首字母占位）', () => {
    expect(resolveAvatarSrc('')).toBeUndefined()
    expect(resolveAvatarSrc('   ')).toBeUndefined()
    expect(resolveAvatarSrc(undefined)).toBeUndefined()
  })
})
