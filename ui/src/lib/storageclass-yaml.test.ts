import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  defaultClassAnnotation,
  findDuplicateParameterKeys,
  generateStorageClassYaml,
  initialData,
  parseAllowedTopologies,
  parseMountOptions,
  resolveVolumeBindingMode,
  staticProvisioner,
  type ParameterRow,
  type StorageClassFormData,
} from './storageclass-yaml'

const form = (
  overrides: Partial<StorageClassFormData> = {}
): StorageClassFormData => ({
  ...initialData,
  name: 'fast-ssd',
  provisioner: 'rancher.io/local-path',
  ...overrides,
})

type SCYaml = {
  apiVersion: string
  kind: string
  metadata: { name: string; annotations?: Record<string, string> }
  provisioner: string
  reclaimPolicy: string
  volumeBindingMode: string
  allowVolumeExpansion?: boolean
  parameters?: Record<string, string>
  mountOptions?: string[]
  allowedTopologies?: Array<{
    matchLabelExpressions: Array<{ key: string; values: string[] }>
  }>
}

const parse = (input: StorageClassFormData): SCYaml =>
  yaml.load(generateStorageClassYaml(input)) as SCYaml

describe('generateStorageClassYaml', () => {
  it('writes the basic fields and leaves optional ones out', () => {
    const doc = parse(form())
    expect(doc.apiVersion).toBe('storage.k8s.io/v1')
    expect(doc.kind).toBe('StorageClass')
    expect(doc.metadata).toEqual({ name: 'fast-ssd' })
    expect(doc.provisioner).toBe('rancher.io/local-path')
    expect(doc.reclaimPolicy).toBe('Delete')
    expect(doc.volumeBindingMode).toBe('Immediate')
    expect(doc.allowVolumeExpansion).toBeUndefined()
    expect(doc.parameters).toBeUndefined()
    expect(doc.mountOptions).toBeUndefined()
  })

  it('marks the class as default and allows expansion only when asked', () => {
    const doc = parse(form({ isDefault: true, allowVolumeExpansion: true }))
    expect(doc.metadata.annotations).toEqual({
      [defaultClassAnnotation]: 'true',
    })
    expect(doc.allowVolumeExpansion).toBe(true)
  })

  it('drops parameter rows without a key but keeps empty values', () => {
    const doc = parse(
      form({
        parameters: [
          { key: 'server', value: '10.0.0.10' },
          { key: '   ', value: 'ignored' },
          { key: 'share', value: '' },
        ],
      })
    )
    expect(doc.parameters).toEqual({ server: '10.0.0.10', share: '' })
  })

  it('splits mount options on commas and newlines, dropping blanks', () => {
    const doc = parse(form({ mountOptions: 'hard,nfsvers=4.1\n ,noatime ' }))
    expect(doc.mountOptions).toEqual(['hard', 'nfsvers=4.1', 'noatime'])
  })
})

describe('allowedTopologies', () => {
  it('turns one line per term into matchLabelExpressions', () => {
    const doc = parse(
      form({
        allowedTopologies:
          'topology.kubernetes.io/zone=cn-south-1a,cn-south-1b\n\ntopology.kubernetes.io/region=cn-south-1',
      })
    )
    expect(doc.allowedTopologies).toEqual([
      {
        matchLabelExpressions: [
          {
            key: 'topology.kubernetes.io/zone',
            values: ['cn-south-1a', 'cn-south-1b'],
          },
        ],
      },
      {
        matchLabelExpressions: [
          { key: 'topology.kubernetes.io/region', values: ['cn-south-1'] },
        ],
      },
    ])
  })

  it('omits the field when nothing is configured', () => {
    expect(
      parse(form({ allowedTopologies: '  \n ' })).allowedTopologies
    ).toBeUndefined()
  })

  it('reports lines that are not key=value1,value2', () => {
    expect(parseAllowedTopologies('').invalidLines).toEqual([])
    expect(
      parseAllowedTopologies('zone\n=value\nkey=\ntopology.kubernetes.io/zone=')
        .invalidLines
    ).toEqual(['zone', '=value', 'key=', 'topology.kubernetes.io/zone='])
    expect(
      parseAllowedTopologies('topology.kubernetes.io/zone=a').invalidLines
    ).toEqual([])
  })
})

describe('parseMountOptions', () => {
  it('returns nothing for an empty string', () => {
    expect(parseMountOptions('')).toEqual([])
    expect(parseMountOptions('  ,  \n ')).toEqual([])
  })
})

// 纯静态卷（no-provisioner）没有动态供给：Immediate 会让 PVC 一创建就去绑任意可用 PV，
// 对带 nodeAffinity 的 node-local PV 会绑到 Pod 调度不上去的节点（Bound 却一直 Pending）。
describe('resolveVolumeBindingMode', () => {
  it('switches a fresh static provisioner to WaitForFirstConsumer', () => {
    expect(resolveVolumeBindingMode(staticProvisioner, 'Immediate')).toBe(
      'WaitForFirstConsumer'
    )
    // 前后空格、大小写按输入原样比较（驱动的写法是固定的）。
    expect(
      resolveVolumeBindingMode(`  ${staticProvisioner}  `, 'Immediate')
    ).toBe('WaitForFirstConsumer')
  })

  it('leaves dynamic provisioners and explicit choices alone', () => {
    expect(resolveVolumeBindingMode('rancher.io/local-path', 'Immediate')).toBe(
      'Immediate'
    )
    // 用户已经把静态卷手动改成其它模式时不再覆盖。
    expect(resolveVolumeBindingMode(staticProvisioner, 'Immediate')).toBe(
      'WaitForFirstConsumer'
    )
    expect(
      resolveVolumeBindingMode(staticProvisioner, 'WaitForFirstConsumer')
    ).toBe('WaitForFirstConsumer')
  })

  it('does not treat an empty provisioner as the static one', () => {
    expect(resolveVolumeBindingMode('', 'Immediate')).toBe('Immediate')
  })
})

// 同名参数在生成 YAML 时会后者覆盖前者（只保留最后一行），必须让用户看见而不是静默丢弃。
describe('findDuplicateParameterKeys', () => {
  const row = (key: string): ParameterRow => ({ key, value: 'v' })

  it('reports nothing for unique keys and blank rows', () => {
    expect(findDuplicateParameterKeys([])).toEqual(new Set())
    expect(
      findDuplicateParameterKeys([row('server'), row('share'), row('')])
    ).toEqual(new Set())
    expect(findDuplicateParameterKeys([row('  '), row('\n')])).toEqual(
      new Set()
    )
  })

  it('reports each repeated key once, ignoring surrounding spaces', () => {
    expect(
      findDuplicateParameterKeys([
        row('server'),
        row(' share '),
        row('share'),
        row('server'),
      ])
    ).toEqual(new Set(['server', 'share']))
    expect(findDuplicateParameterKeys([row('a'), row('a'), row('a')])).toEqual(
      new Set(['a'])
    )
  })
})
