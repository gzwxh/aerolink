import { describe, expect, it } from 'vitest'

import { decodeBase64Utf8, encodeBase64Utf8, splitSecretData } from './base64'

describe('UTF-8 安全的 base64', () => {
  it('中文等非 Latin-1 字符能原样往返', () => {
    const value = '密码：中文与 emoji 🙂'
    expect(decodeBase64Utf8(encodeBase64Utf8(value))).toBe(value)
  })
})

// 编辑 Secret 时的预填：只有能安全编解码往返的值才能当文本处理，
// 二进制值（keystore、证书）解码成字符串会丢字节，必须原样留在二进制标签页。
describe('splitSecretData', () => {
  it('文本值进明文行，二进制值进二进制行且保持原 base64', () => {
    const text = encodeBase64Utf8('hello 世界')
    // 0xFF 0xFE：不是合法 UTF-8，解码会得到替换字符，再编码就与原值不同。
    const binary = '//4='

    const { text: textRows, binary: binaryRows } = splitSecretData({
      greeting: text,
      keystore: binary,
    })

    expect(textRows).toEqual([['greeting', 'hello 世界']])
    expect(binaryRows).toEqual([['keystore', binary]])
  })

  it('空或缺失的 data 不报错', () => {
    expect(splitSecretData(undefined)).toEqual({ text: [], binary: [] })
    expect(splitSecretData({})).toEqual({ text: [], binary: [] })
  })
})
