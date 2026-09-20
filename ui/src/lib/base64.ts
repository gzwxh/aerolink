/**
 * UTF-8 安全的 Base64 编解码。
 *
 * Secret 的值可能包含中文等非 Latin-1 字符，直接 `btoa` / `atob` 会抛
 * `InvalidCharacterError` 或产生乱码，所以统一走 TextEncoder/TextDecoder。
 */

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

export function decodeBase64Utf8(value: string): string {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    // 不是合法 base64（或被截断）时按原样返回，避免整页渲染失败。
    return value
  }
}

/** 批量把 `{ key: 明文 }` 编码为 `{ key: base64 }`。 */
export function encodeBase64Map(
  entries: Record<string, string>
): Record<string, string> {
  const encoded: Record<string, string> = {}
  Object.entries(entries).forEach(([key, value]) => {
    encoded[key] = encodeBase64Utf8(value)
  })
  return encoded
}

/**
 * 把 Secret 的 `data`（base64）拆成「能安全往返的文本值」与「二进制值」。
 *
 * 只有 `encode(decode(v)) === v` 的值才能当文本处理：keystore、证书这类二进制内容
 * 解码成字符串会丢字节，再编码回去就与原值不同 —— 那类值必须原样留在二进制标签页
 * （那里存的本来就是 base64），否则「只改一个标签」也会把载荷改坏。
 */
export function splitSecretData(data: Record<string, string> | undefined): {
  text: Array<[string, string]>
  binary: Array<[string, string]>
} {
  const text: Array<[string, string]> = []
  const binary: Array<[string, string]> = []
  Object.entries(data || {}).forEach(([key, value]) => {
    const decoded = decodeBase64Utf8(value)
    if (encodeBase64Utf8(decoded) === value) {
      text.push([key, decoded])
    } else {
      binary.push([key, value])
    }
  })
  return { text, binary }
}
