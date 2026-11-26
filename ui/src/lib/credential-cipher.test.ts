import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  randomFillSync,
  webcrypto,
} from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { encryptSecrets } from './credential-cipher'

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
})
const publicKeyBase64 = publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64')

function stubTransportKey() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            key_id: 'test',
            alg: 'RSA-OAEP-256',
            public_key: publicKeyBase64,
            max_age: 300,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
  )
}

function decrypt(cipherBase64: string): unknown {
  const plain = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(cipherBase64, 'base64')
  )
  return JSON.parse(plain.toString('utf8'))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('encryptSecrets', () => {
  // 回归：http://<内网IP> 不是安全上下文，crypto.subtle 为 undefined（登录直接崩在
  // importKey 上）。此时必须回退到纯 JS 的 OAEP，而不是抛错或退回明文。
  it('works without crypto.subtle', async () => {
    stubTransportKey()
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint8Array) => randomFillSync(target),
    })

    const encrypted = await encryptSecrets({ password: 'p@ss-中文' })

    expect(decrypt(encrypted.password_enc)).toMatchObject({
      v: 1,
      fields: { password: 'p@ss-中文' },
    })
  })

  it('uses WebCrypto when it is available', async () => {
    stubTransportKey()
    vi.stubGlobal('crypto', {
      subtle: webcrypto.subtle,
      getRandomValues: (target: Uint8Array) => randomFillSync(target),
    })

    const encrypted = await encryptSecrets({ password: 'secret' })

    expect(decrypt(encrypted.password_enc)).toMatchObject({
      v: 1,
      fields: { password: 'secret' },
    })
  })

  it('skips fields that were not provided', async () => {
    stubTransportKey()
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint8Array) => randomFillSync(target),
    })

    expect(await encryptSecrets({ current_password: undefined })).toEqual({})
  })
})
