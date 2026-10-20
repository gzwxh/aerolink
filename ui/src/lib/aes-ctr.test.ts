import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { aesCtrEncrypt } from './aes-ctr'

function opensslAesCtr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): string {
  const cipher = createCipheriv('aes-256-ctr', Buffer.from(key), Buffer.from(iv))
  return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]).toString('hex')
}

describe('aesCtrEncrypt', () => {
  it('matches OpenSSL across block boundaries', () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 1) & 0xff)
    const iv = Uint8Array.from({ length: 16 }, (_, index) => (index + 9) & 0xff)

    for (const length of [0, 1, 15, 16, 17, 64, 255, 1000]) {
      const data = Uint8Array.from({ length }, (_, index) => (index * 13 + 5) & 0xff)
      expect(Buffer.from(aesCtrEncrypt(key, iv, data)).toString('hex')).toBe(
        opensslAesCtr(key, iv, data)
      )
    }
  })

  it('carries the 128-bit counter past a byte boundary', () => {
    const key = new Uint8Array(32).fill(0x2b)
    const iv = new Uint8Array(16).fill(0xff)
    iv[15] = 0xfd
    const data = new Uint8Array(48).fill(0x41)

    expect(Buffer.from(aesCtrEncrypt(key, iv, data)).toString('hex')).toBe(
      opensslAesCtr(key, iv, data)
    )
  })

  it('rejects wrong key or counter sizes', () => {
    expect(() => aesCtrEncrypt(new Uint8Array(16), new Uint8Array(16), new Uint8Array(1))).toThrow()
    expect(() => aesCtrEncrypt(new Uint8Array(32), new Uint8Array(8), new Uint8Array(1))).toThrow()
  })
})
