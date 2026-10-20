import { constants, createPublicKey, publicEncrypt } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'

/** 服务端按短字段加密识别的凭据字段（与 pkg/transportkey 的解密点一一对应）。 */
const CREDENTIAL_FIELDS = [
  'password',
  'current_password',
  'new_password',
  'mfa_code',
  'code',
] as const

/**
 * 把请求体里的明文口令换成 `*_enc` 密文。
 *
 * 服务端可以用 AEROLINK_REQUIRE_ENCRYPTED_CREDENTIALS 拒收明文凭据；打开
 * `E2E_ENCRYPT_CREDENTIALS=1` 时走密文，用来验证强制模式下的全量用例。
 * 默认关闭，因为默认部署仍要覆盖「明文兼容」这条路径。
 */
export async function credentials(
  request: APIRequestContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (process.env.E2E_ENCRYPT_CREDENTIALS !== '1') {
    return body
  }

  const result: Record<string, unknown> = { ...body }
  for (const field of CREDENTIAL_FIELDS) {
    const value = result[field]
    if (typeof value !== 'string' || value === '') {
      continue
    }
    result[`${field}_enc`] = await encryptField(request, field, value)
    delete result[field]
  }
  return result
}

/** 取 GET /api/v1/transport-key 的公钥，按 pkg/transportkey 的载荷格式加密一个字段。 */
async function encryptField(
  request: APIRequestContext,
  field: string,
  value: string
): Promise<string> {
  const response = await request.get('/api/v1/transport-key')
  if (!response.ok()) {
    throw new Error(`transport key request failed: ${response.status()}`)
  }
  const { public_key: encoded } = (await response.json()) as { public_key: string }
  const key = createPublicKey({
    key: Buffer.from(encoded, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const payload = JSON.stringify({
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    fields: { [field]: value },
  })
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(payload)
  ).toString('base64')
}
