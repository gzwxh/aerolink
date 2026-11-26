// 请求体里的口令类字段在离开浏览器前就用服务端公钥加密，避免它们以明文出现在
// 反向代理日志、APM 抓包与浏览器开发者工具里（见 pkg/transportkey）。
//
// 这不是 TLS 的替代品：整段请求仍可被中间人转发或重放。
//
// 长文本（kubeconfig、Secret data、Helm values、设置整包）走 transport-envelope.ts 的
// 信封格式，两者共用同一份公钥与 `_enc`/`enc` 的约定。
import { rsaOaepEncrypt } from './rsa-oaep'
import { bytesToBase64, fetchTransportKey } from './transport-key'

const ALGORITHM = 'RSA-OAEP'

/**
 * 加密一组敏感字段，返回 `{ <name>_enc: 密文 }`。
 *
 * 每次调用都重新取公钥：服务端多副本的私钥不一致或刚重启时，缓存下来的旧公钥会让
 * 服务端只能报「凭据无效」，用户会误以为口令输错了。多一次 GET 的代价可以接受。
 */
export async function encryptSecrets(
  fields: Record<string, string | undefined>
): Promise<Record<string, string>> {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
  if (entries.length === 0) {
    return {}
  }

  const key = await fetchTransportKey()
  const ts = Math.floor(Date.now() / 1000)
  const encrypted: Record<string, string> = {}

  for (const [name, value] of entries) {
    const payload = JSON.stringify({ v: 1, ts, fields: { [name]: value } })
    const plaintext = new TextEncoder().encode(payload)
    const cipher = key.webKey
      ? new Uint8Array(
          await crypto.subtle.encrypt(
            { name: ALGORITHM },
            key.webKey,
            plaintext
          )
        )
      : rsaOaepEncrypt(key.spki, plaintext)
    encrypted[`${name}_enc`] = bytesToBase64(cipher)
  }

  return encrypted
}
