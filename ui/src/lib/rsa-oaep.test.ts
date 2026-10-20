import { constants, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseRsaPublicKey, rsaOaepEncrypt } from './rsa-oaep'
import { sha256 } from './sha256'

describe('sha256', () => {
  it('matches the Node implementation', () => {
    for (const length of [0, 3, 55, 56, 64, 65, 1000]) {
      const input = new Uint8Array(length).map((_, index) => (index * 7 + 13) & 0xff)
      const expected = createHash('sha256').update(input).digest('hex')
      expect(Buffer.from(sha256(input)).toString('hex')).toBe(expected)
    }
  })
})

describe('rsaOaepEncrypt', () => {
  it('produces ciphertext that OpenSSL can decrypt', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 })
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }))
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ v: 1, ts: 1760000000, fields: { password: 'p@ss-中文' } })
    )

    const cipher = rsaOaepEncrypt(spki, plaintext)
    expect(cipher).toHaveLength(384)

    const decrypted = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(cipher)
    )
    // 用十六进制比较：jsdom 环境下 Buffer 与 Uint8Array 的原型不同，toStrictEqual 会误判。
    expect(decrypted.toString('hex')).toBe(Buffer.from(plaintext).toString('hex'))
  })

  it('reads modulus and exponent from the DER payload', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }))

    const { modulus, exponent } = parseRsaPublicKey(spki)
    expect(modulus.toString(2)).toHaveLength(2048)
    expect(exponent).toBe(65537n)
  })

  it('rejects payloads that do not fit the key', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }))

    expect(() => rsaOaepEncrypt(spki, new Uint8Array(2048))).toThrow()
  })
})
