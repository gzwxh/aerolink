import * as yaml from 'js-yaml'
import { PersistentVolume } from 'kubernetes-types/core/v1'
import { describe, expect, it } from 'vitest'

import {
  formFromPV,
  generatePVYaml,
  hasPartialClaimRef,
  initialData,
  pvUpdateFromForm,
  reclaimPolicyOptions,
  volumeSourceOf,
  type PVFormData,
} from './pv-yaml'

/** 一份最小的合法表单，各用例只覆盖自己关心的字段。 */
const form = (overrides: Partial<PVFormData> = {}): PVFormData => ({
  ...initialData,
  name: 'pv-1',
  capacity: '10Gi',
  hostPathPath: '/data/volumes/pv-1',
  ...overrides,
})

type PVYaml = {
  apiVersion: string
  kind: string
  metadata: Record<string, unknown>
  spec: Record<string, never> & {
    capacity: { storage: string }
    accessModes: string[]
    persistentVolumeReclaimPolicy: string
    volumeMode?: string
    storageClassName?: string
    mountOptions?: string[]
    claimRef?: { namespace: string; name: string }
    hostPath?: { path: string; type?: string }
    local?: { path: string }
    nfs?: { server: string; path: string; readOnly?: boolean }
    csi?: {
      driver: string
      volumeHandle: string
      fsType?: string
      readOnly?: boolean
    }
    nodeAffinity?: {
      required: {
        nodeSelectorTerms: Array<{
          matchExpressions: Array<{
            key: string
            operator: string
            values: string[]
          }>
        }>
      }
    }
  }
}

const parse = (input: PVFormData): PVYaml =>
  yaml.load(generatePVYaml(input)) as PVYaml

describe('generatePVYaml', () => {
  it('writes the hostPath volume, capacity and access mode from the form', () => {
    const doc = parse(form())
    expect(doc.apiVersion).toBe('v1')
    expect(doc.kind).toBe('PersistentVolume')
    // 集群级资源不该带命名空间。
    expect(doc.metadata).toEqual({ name: 'pv-1' })
    expect(doc.spec.capacity).toEqual({ storage: '10Gi' })
    expect(doc.spec.accessModes).toEqual(['ReadWriteOnce'])
    expect(doc.spec.persistentVolumeReclaimPolicy).toBe('Retain')
    expect(doc.spec.volumeMode).toBe('Filesystem')
    expect(doc.spec.hostPath).toEqual({
      path: '/data/volumes/pv-1',
      type: 'DirectoryOrCreate',
    })
  })

  it('omits optional fields the form left empty', () => {
    const doc = parse(
      form({ storageClassName: '', volumeMode: '', hostPathType: '' })
    )
    expect(doc.spec.storageClassName).toBeUndefined()
    expect(doc.spec.volumeMode).toBeUndefined()
    expect(doc.spec.hostPath).toEqual({ path: '/data/volumes/pv-1' })
  })

  it('passes through the chosen storage class and reclaim policy', () => {
    const doc = parse(
      form({ storageClassName: 'hostpath', reclaimPolicy: 'Delete' })
    )
    expect(doc.spec.storageClassName).toBe('hostpath')
    expect(doc.spec.persistentVolumeReclaimPolicy).toBe('Delete')
  })

  it('builds the node affinity a local volume requires', () => {
    const doc = parse(
      form({
        sourceType: 'local',
        localPath: '/mnt/disks/ssd1',
        localNodeName: 'node-1',
      })
    )
    expect(doc.spec.local).toEqual({ path: '/mnt/disks/ssd1' })
    expect(doc.spec.hostPath).toBeUndefined()
    expect(
      doc.spec.nodeAffinity?.required.nodeSelectorTerms[0].matchExpressions[0]
    ).toEqual({
      key: 'kubernetes.io/hostname',
      operator: 'In',
      values: ['node-1'],
    })
  })

  it('writes nfs and only emits readOnly when it is on', () => {
    const base = {
      sourceType: 'nfs' as const,
      nfsServer: '10.0.0.10',
      nfsPath: '/exports/data',
    }
    expect(parse(form(base)).spec.nfs).toEqual({
      server: '10.0.0.10',
      path: '/exports/data',
    })
    expect(parse(form({ ...base, nfsReadOnly: true })).spec.nfs).toEqual({
      server: '10.0.0.10',
      path: '/exports/data',
      readOnly: true,
    })
  })

  it('writes the csi source and omits an empty fsType', () => {
    const doc = parse(
      form({
        sourceType: 'csi',
        csiDriver: 'csi-hostpath',
        csiVolumeHandle: 'vol-1',
        csiFsType: 'ext4',
        csiReadOnly: true,
        volumeMode: 'Block',
      })
    )
    expect(doc.spec.csi).toEqual({
      driver: 'csi-hostpath',
      volumeHandle: 'vol-1',
      fsType: 'ext4',
      readOnly: true,
    })
    expect(
      parse(form({ sourceType: 'csi', csiDriver: 'd', csiVolumeHandle: 'v' }))
        .spec.csi
    ).toEqual({ driver: 'd', volumeHandle: 'v' })
    expect(doc.spec.volumeMode).toBe('Block')
  })

  it('keeps every selected access mode in order', () => {
    const doc = parse(form({ accessModes: ['ReadWriteOnce', 'ReadOnlyMany'] }))
    expect(doc.spec.accessModes).toEqual(['ReadWriteOnce', 'ReadOnlyMany'])
  })

  it('writes mount options and omits them when the field is empty', () => {
    expect(
      parse(form({ mountOptions: 'hard, nfsvers=4.1' })).spec.mountOptions
    ).toEqual(['hard', 'nfsvers=4.1'])
    expect(
      parse(form({ mountOptions: '  ' })).spec.mountOptions
    ).toBeUndefined()
  })

  it('pre-binds to a claim only when both namespace and name are given', () => {
    expect(
      parse(form({ claimRefNamespace: 'dev', claimRefName: 'data' })).spec
        .claimRef
    ).toEqual({ namespace: 'dev', name: 'data' })
    // 半截输入不写进 YAML（由表单拦下，见 hasPartialClaimRef）。
    expect(
      parse(form({ claimRefNamespace: 'dev' })).spec.claimRef
    ).toBeUndefined()
    expect(parse(form({ claimRefName: 'data' })).spec.claimRef).toBeUndefined()
  })

  it('flags a half-filled claim binding', () => {
    expect(hasPartialClaimRef(form())).toBe(false)
    expect(
      hasPartialClaimRef(
        form({ claimRefNamespace: 'dev', claimRefName: 'data' })
      )
    ).toBe(false)
    expect(hasPartialClaimRef(form({ claimRefNamespace: 'dev' }))).toBe(true)
    expect(hasPartialClaimRef(form({ claimRefName: 'data' }))).toBe(true)
    // 只有空白也算没填：与生成 YAML 时的 trim 口径一致。
    expect(
      hasPartialClaimRef(
        form({ claimRefNamespace: '  ', claimRefName: 'data' })
      )
    ).toBe(true)
  })

  // Recycle 已被 Kubernetes 标记为废弃，且要求底层插件支持回收；现代 CSI / 本地盘都不支持，
  // 选它等于「看起来会回收、实际什么都不做」。这里锁住「下拉里不可能出现它」。
  it('offers only the two supported reclaim policies', () => {
    expect([...reclaimPolicyOptions]).toEqual(['Retain', 'Delete'])
    expect(reclaimPolicyOptions).not.toContain('Recycle')
  })
})

/** 一个「线上」的 hostPath PV：带不可变字段、扩展容量与没建模的字段。 */
const livePV = (): PersistentVolume =>
  ({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: {
      name: 'pv-1',
      uid: 'uid-1',
      labels: { keep: 'me' },
      annotations: { 'aerolink.internal/note': 'keep me' },
    },
    spec: {
      capacity: { storage: '10Gi', iops: '3000' },
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain',
      volumeMode: 'Filesystem',
      storageClassName: 'fast-ssd',
      mountOptions: ['noatime'],
      claimRef: { namespace: 'dev', name: 'data' },
      hostPath: { path: '/data/volumes/pv-1', type: 'Directory' },
    },
    status: { phase: 'Bound' },
  }) as unknown as PersistentVolume

describe('PV 编辑（只放行可变字段）', () => {
  it('线上对象预填回表单', () => {
    const data = formFromPV(livePV())
    expect(data.name).toBe('pv-1')
    expect(data.capacity).toBe('10Gi')
    expect(data.accessModes).toEqual(['ReadWriteOnce'])
    expect(data.reclaimPolicy).toBe('Retain')
    expect(data.mountOptions).toBe('noatime')
    expect(data.volumeMode).toBe('Filesystem')
    expect(data.storageClassName).toBe('fast-ssd')
    expect(data.claimRefNamespace).toBe('dev')
    expect(data.claimRefName).toBe('data')
    expect(data.sourceType).toBe('hostPath')
    expect(data.hostPathPath).toBe('/data/volumes/pv-1')
    expect(data.hostPathType).toBe('Directory')
  })

  it('能识别不支持的卷来源', () => {
    expect(volumeSourceOf(livePV())).toBe('hostPath')
    const rbd = {
      spec: { capacity: { storage: '1Gi' }, rbd: { pool: 'p', image: 'i' } },
    } as unknown as PersistentVolume
    expect(volumeSourceOf(rbd)).toBeNull()
  })

  // PUT 是整体替换：漏掉一个字段就等于删掉它。不可变字段与表单没建模的
  // 字段（iops 这类扩展容量、status、uid）都必须原样带过去。
  it('只改表单里的可变字段，其余原样保留', () => {
    const existing = livePV()
    const updated = pvUpdateFromForm(
      form({
        capacity: '20Gi',
        accessModes: ['ReadWriteMany'],
        reclaimPolicy: 'Delete',
        mountOptions: 'noatime,nodiratime',
      }),
      existing
    )

    const spec = updated.spec as Record<string, unknown>
    expect(spec.capacity).toEqual({ storage: '20Gi', iops: '3000' })
    expect(spec.accessModes).toEqual(['ReadWriteMany'])
    expect(spec.persistentVolumeReclaimPolicy).toBe('Delete')
    expect(spec.mountOptions).toEqual(['noatime', 'nodiratime'])
    // 不可变的来源与卷模式、以及绑定语义相关字段都没动。
    expect(spec.volumeMode).toBe('Filesystem')
    expect(spec.storageClassName).toBe('fast-ssd')
    expect(spec.claimRef).toEqual({ namespace: 'dev', name: 'data' })
    expect(spec.hostPath).toEqual({
      path: '/data/volumes/pv-1',
      type: 'Directory',
    })
    expect(updated.metadata?.labels).toEqual({ keep: 'me' })
    expect(updated.metadata?.annotations).toEqual({
      'aerolink.internal/note': 'keep me',
    })
    expect(updated.status?.phase).toBe('Bound')
  })

  it('清空挂载参数就是删掉它', () => {
    const updated = pvUpdateFromForm(form({ mountOptions: '' }), livePV())
    expect(
      (updated.spec as Record<string, unknown>).mountOptions
    ).toBeUndefined()
  })
})
