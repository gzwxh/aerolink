// 整段请求体的信封加密：kubeconfig、Secret data、Helm values、设置类凭据这类长文本没法
// 用 RSA 直接加密，改成「RSA 包封会话密钥 + AES-256-CTR + HMAC-SHA256」。
//
// 服务端（pkg/transportkey 的 UnwrapEnvelopeBody）还原成原始 JSON 再交给 handler，所以
// 审计、绑定与既有 handler 都不需要感知这个格式。
//
// 同样不是 TLS 的替代品：它只降低代理日志与抓包留痕。
import { aesCtrEncrypt } from './aes-ctr'
import { rsaOaepEncrypt } from './rsa-oaep'
import { concatBytes, hmacSha256 } from './sha256'
import {
  bytesToBase64,
  fetchTransportKey,
  type PublicKeyMaterial,
} from './transport-key'

const ENVELOPE_ALG = 'RSA-OAEP-256+AES-256-CTR-HMAC-SHA256'
const SESSION_KEY_BYTES = 64 // 前 32 字节 AES 密钥，后 32 字节 HMAC 密钥
const IV_BYTES = 16

export interface EncryptedEnvelope {
  v: number
  key_id: string
  alg: string
  wrapped_key: string
  iv: string
  data: string
  mac: string
}

export interface EncryptedRequestBody {
  enc: EncryptedEnvelope
}

async function encryptWithSessionKey(
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) {
    const subtleKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'AES-CTR' },
      false,
      ['encrypt']
    )
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: iv, length: 128 },
      subtleKey,
      plaintext
    )
    return new Uint8Array(cipher)
  }
  return aesCtrEncrypt(key, iv, plaintext)
}

async function authenticate(
  key: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) {
    const subtleKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    return new Uint8Array(await crypto.subtle.sign('HMAC', subtleKey, message))
  }
  return hmacSha256(key, message)
}

async function wrapSessionKey(
  key: PublicKeyMaterial,
  sessionKey: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> {
  if (key.webKey) {
    return new Uint8Array(
      await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key.webKey, sessionKey)
    )
  }
  return rsaOaepEncrypt(key.spki, sessionKey)
}

/**
 * 把整个请求体封进信封，返回可直接作为请求体提交的 `{ enc: … }`。
 *
 * 离开浏览器后，代理日志里只会看到 key_id 与算法标识，正文与时间戳都在 MAC 保护范围内。
 */
export async function encryptRequestBody(
  body: unknown
): Promise<EncryptedRequestBody> {
  const transportKey = await fetchTransportKey()
  const sessionKey = crypto.getRandomValues(new Uint8Array(SESSION_KEY_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))

  const payload = new TextEncoder().encode(
    JSON.stringify({ ts: Math.floor(Date.now() / 1000), body })
  )
  const data = await encryptWithSessionKey(
    sessionKey.subarray(0, 32),
    iv,
    payload
  )
  const mac = await authenticate(
    sessionKey.subarray(32),
    concatBytes([iv, data])
  )
  const wrappedKey = await wrapSessionKey(transportKey, sessionKey)

  return {
    enc: {
      v: 1,
      key_id: transportKey.keyId,
      alg: ENVELOPE_ALG,
      wrapped_key: bytesToBase64(wrappedKey),
      iv: bytesToBase64(iv),
      data: bytesToBase64(data),
      mac: bytesToBase64(mac),
    },
  }
}
