import { describe, expect, it } from 'vitest'

import { buildDecodedConfigMap, restoreBinaryData } from './configmap-yaml'

const textPayload = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))

describe('buildDecodedConfigMap', () => {
  it('开启解码时，binaryData 里能安全往返的值以明文展示', () => {
    const { yamlObject, decodedKeys } = buildDecodedConfigMap(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'demo' },
        data: { 'app.conf': 'debug=true' },
        binaryData: { script: textPayload('echo hello') },
      },
      true
    )

    expect(yamlObject?.binaryData?.script).toBe('echo hello')
    expect(decodedKeys.has('script')).toBe(true)
  })

  it('非法 UTF-8 的载荷保持 base64 原样', () => {
    // 0xFF 0xFE 不是合法 UTF-8，解码会得到替换字符，再编码就与原值不同
    const binary = '//4='
    const { yamlObject, decodedKeys } = buildDecodedConfigMap(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'demo' },
        binaryData: { blob: binary },
      },
      true
    )

    expect(yamlObject?.binaryData?.blob).toBe(binary)
    expect(decodedKeys.size).toBe(0)
  })

  it('非标准 base64（缺 padding）也不会被当成文本', () => {
    const { yamlObject, decodedKeys } = buildDecodedConfigMap(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'demo' },
        binaryData: { blob: 'aGVsbG8' },
      },
      true
    )

    expect(yamlObject?.binaryData?.blob).toBe('aGVsbG8')
    expect(decodedKeys.size).toBe(0)
  })

  it('未开启解码时原样返回', () => {
    const configMap = {
      apiVersion: 'v1' as const,
      kind: 'ConfigMap' as const,
      metadata: { name: 'demo' },
      binaryData: { script: textPayload('echo hello') },
    }
    const { yamlObject, decodedKeys } = buildDecodedConfigMap(configMap, false)

    expect(yamlObject).toBe(configMap)
    expect(decodedKeys.size).toBe(0)
  })
})

describe('restoreBinaryData', () => {
  it('解码视图保存后与原始 base64 完全一致（含中文与多行）', () => {
    const original = '第一行\nsecond line\n'
    const base64 = textPayload(original)
    const configMap = {
      apiVersion: 'v1' as const,
      kind: 'ConfigMap' as const,
      metadata: { name: 'demo' },
      binaryData: { readme: base64 },
    }

    const { yamlObject, decodedKeys } = buildDecodedConfigMap(configMap, true)
    expect(yamlObject?.binaryData?.readme).toBe(original)

    const restored = restoreBinaryData(yamlObject!, decodedKeys)
    expect(restored.binaryData?.readme).toBe(base64)
  })

  it('用户改写过的明文会被重新编码，二进制键不受影响', () => {
    const binary = '//4='
    const configMap = {
      apiVersion: 'v1' as const,
      kind: 'ConfigMap' as const,
      metadata: { name: 'demo' },
      binaryData: { script: textPayload('old'), blob: binary },
    }

    const { yamlObject, decodedKeys } = buildDecodedConfigMap(configMap, true)
    yamlObject!.binaryData!.script = 'new'

    const restored = restoreBinaryData(yamlObject!, decodedKeys)
    expect(restored.binaryData?.script).toBe(textPayload('new'))
    expect(restored.binaryData?.blob).toBe(binary)
  })

  it('没有解码过任何键时不做改动', () => {
    const configMap = {
      apiVersion: 'v1' as const,
      kind: 'ConfigMap' as const,
      metadata: { name: 'demo' },
      binaryData: { blob: '//4=' },
    }

    expect(restoreBinaryData(configMap, new Set())).toBe(configMap)
  })
})
