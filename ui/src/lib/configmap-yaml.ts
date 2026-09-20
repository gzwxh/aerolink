import type { ConfigMap } from 'kubernetes-types/core/v1'

import { decodeBase64Utf8, encodeBase64Utf8 } from './base64'

/**
 * 生成 YAML 视图用的 ConfigMap 副本。
 *
 * `showDecoded` 为 true 时，把 `binaryData` 中**能安全往返**的值换成明文，并把成功
 * 解码的键记录在 `decodedKeys` 里，供保存时重新编码。
 *
 * 判据是 `encode(decode(v)) === v`，与 `splitSecretData` 保持一致：只有往返一致
 * 才说明这串 base64 是文本。真二进制（图片、压缩包）解码成字符串会丢字节，再编码
 * 回去与原值不同——那类值必须原样留在 base64，否则「看一眼再保存」就把载荷改坏了。
 */
export function buildDecodedConfigMap(
  configMap: ConfigMap | undefined,
  showDecoded: boolean
): { yamlObject: ConfigMap | undefined; decodedKeys: Set<string> } {
  const decodedKeys = new Set<string>()
  if (!configMap || !showDecoded || !configMap.binaryData) {
    return { yamlObject: configMap, decodedKeys }
  }

  const binaryData: Record<string, string> = {}
  Object.entries(configMap.binaryData).forEach(([key, value]) => {
    const decoded = decodeBase64Utf8(value)
    if (encodeBase64Utf8(decoded) === value) {
      binaryData[key] = decoded
      decodedKeys.add(key)
    } else {
      binaryData[key] = value
    }
  })

  return { yamlObject: { ...configMap, binaryData }, decodedKeys }
}

/**
 * 保存前把解码视图还原成 API 期望的 base64。
 *
 * 只有当初被解码过、且本次仍按明文书写的键会重新编码；其余值（原本就是 base64 的
 * 二进制、或用户直接粘贴的 base64）原样保留，避免二次编码。
 */
export function restoreBinaryData(
  configMap: ConfigMap,
  decodedKeys: Set<string>
): ConfigMap {
  if (!configMap.binaryData || decodedKeys.size === 0) {
    return configMap
  }

  const binaryData: Record<string, string> = {}
  Object.entries(configMap.binaryData).forEach(([key, value]) => {
    const text = String(value)
    binaryData[key] = decodedKeys.has(key) ? encodeBase64Utf8(text) : text
  })

  return { ...configMap, binaryData }
}
