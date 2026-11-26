import {
  constants,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
  randomFillSync,
  webcrypto,
} from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  encryptRequestBody,
  type EncryptedEnvelope,
} from './transport-envelope'

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
            key_id: 'test-key',
            alg: 'RSA-OAEP-256',
            public_key: publicKeyBase64,
            max_age: 300,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
  )
}

// 按服务端（Go pkg/transportkey）的步骤校验并还原：先认 MAC，再解 AES-CTR。
function openEnvelope(envelope: EncryptedEnvelope): {
  ts: number
  body: unknown
} {
  const sessionKey = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(envelope.wrapped_key, 'base64')
  )
  expect(sessionKey).toHaveLength(64)

  const iv = Buffer.from(envelope.iv, 'base64')
  const data = Buffer.from(envelope.data, 'base64')
  const expectedMac = createHmac('sha256', sessionKey.subarray(32))
    .update(iv)
    .update(data)
    .digest('hex')
  expect(Buffer.from(envelope.mac, 'base64').toString('hex')).toBe(expectedMac)

  const decipher = createDecipheriv(
    'aes-256-ctr',
    sessionKey.subarray(0, 32),
    iv
  )
  const plaintext = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString('utf8')
  return JSON.parse(plaintext) as { ts: number; body: unknown }
}

function stubCrypto(withSubtle: boolean) {
  vi.stubGlobal('crypto', {
    ...(withSubtle ? { subtle: webcrypto.subtle } : {}),
    getRandomValues: (target: Uint8Array) => randomFillSync(target),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('encryptRequestBody', () => {
  it('produces an envelope the server can open with WebCrypto', async () => {
    stubTransportKey()
    stubCrypto(true)

    const encrypted = await encryptRequestBody({
      kind: 'Secret',
      data: { token: 'p@ss-中文' },
    })

    expect(encrypted.enc.alg).toBe('RSA-OAEP-256+AES-256-CTR-HMAC-SHA256')
    expect(encrypted.enc.key_id).toBe('test-key')
    const opened = openEnvelope(encrypted.enc)
    expect(opened.body).toEqual({
      kind: 'Secret',
      data: { token: 'p@ss-中文' },
    })
    expect(Math.abs(opened.ts - Math.floor(Date.now() / 1000))).toBeLessThan(10)
  })

  // 回归：http://<内网IP> 没有 crypto.subtle，长文本也必须能加密，且不能退回明文。
  it('produces an envelope the server can open without crypto.subtle', async () => {
    stubTransportKey()
    stubCrypto(false)

    const body = {
      kind: 'Secret',
      data: { 'tls.key': '-----BEGIN PRIVATE KEY-----' },
    }
    const encrypted = await encryptRequestBody(body)

    expect(JSON.stringify(encrypted)).not.toContain('BEGIN PRIVATE KEY')
    expect(openEnvelope(encrypted.enc).body).toEqual(body)
  })

  it('handles kubeconfig-sized payloads', async () => {
    stubTransportKey()
    stubCrypto(false)

    const kubeconfig = `apiVersion: v1\nclusters:\n${'  - name: c\n'.repeat(2000)}`
    const encrypted = await encryptRequestBody({ config: kubeconfig })

    expect(JSON.stringify(encrypted)).not.toContain('apiVersion')
    expect(openEnvelope(encrypted.enc).body).toEqual({ config: kubeconfig })
  })
})
