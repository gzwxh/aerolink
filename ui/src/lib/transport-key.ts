// 取服务端下发的一次性公钥，以及信封/字段加密共用的 base64 编解码。
//
// 每次提交都重新取公钥：服务端多副本私钥不一致或刚重启时，缓存下来的旧公钥会让服务端
// 只能报「凭据无效」，用户会误以为口令输错了。多一次 GET 的代价可以接受。
import { withSubPath } from './subpath'

const KEY_ENDPOINT = '/api/v1/transport-key'
const ALGORITHM = 'RSA-OAEP'
const HASH = 'SHA-256'

interface TransportKeyResponse {
  key_id: string
  alg: string
  public_key: string
  max_age: number
}

export interface PublicKeyMaterial {
  keyId: string
  spki: Uint8Array<ArrayBuffer>
  // crypto.subtle 只在安全上下文存在（https / localhost）；http://<内网IP> 打开时为
  // undefined，此时走 rsa-oaep.ts / aes-ctr.ts 的纯 JS 实现。
  webKey?: CryptoKey
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  // 显式用 ArrayBuffer 构造：crypto.subtle 的 BufferSource 不接受 SharedArrayBuffer 视图。
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  // 一次 btoa 传整个数组在长载荷下会超参数上限，分块拼接。
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export async function fetchTransportKey(): Promise<PublicKeyMaterial> {
  const response = await fetch(withSubPath(KEY_ENDPOINT), {
    credentials: 'include',
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`transport key unavailable: HTTP ${response.status}`)
  }
  const payload = (await response.json()) as TransportKeyResponse
  if (!payload.public_key) {
    throw new Error('transport key unavailable: empty public key')
  }
  const spki = base64ToBytes(payload.public_key)
  if (!globalThis.crypto?.subtle) {
    return { keyId: payload.key_id, spki }
  }
  const webKey = await crypto.subtle.importKey(
    'spki',
    spki,
    { name: ALGORITHM, hash: HASH },
    false,
    ['encrypt']
  )
  return { keyId: payload.key_id, spki, webKey }
}
