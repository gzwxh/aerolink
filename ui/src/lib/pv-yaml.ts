import * as yaml from 'js-yaml'
import { PersistentVolume } from 'kubernetes-types/core/v1'

import { parseMountOptions } from './mount-options'

/**
 * PersistentVolume 创建表单的取值与 YAML 生成。
 *
 * 抽成纯函数是为了能直接单测：表单里的一次点击最终变成什么 YAML，是本模块的唯一职责，
 * 页面只负责收集输入与提示错误。
 */

// PersistentVolume 是集群级资源：卷由管理员静态创建，再被命名空间里的 PVC 绑定。
export type VolumeSourceType = 'hostPath' | 'nfs' | 'local' | 'csi'
// Recycle 已废弃（`kubectl explain pv.spec.persistentVolumeReclaimPolicy` 明示），
// 现代 CSI / 本地盘都不支持回收，列出来只会让人以为数据会被自动清掉，故不提供。
export type ReclaimPolicy = 'Retain' | 'Delete'

/** 可选的回收策略。刻意不含已废弃的 Recycle（见文件顶部说明）。 */
export const reclaimPolicyOptions: readonly ReclaimPolicy[] = [
  'Retain',
  'Delete',
]
export type VolumeMode = 'Filesystem' | 'Block'

export const accessModeOptions = [
  'ReadWriteOnce',
  'ReadOnlyMany',
  'ReadWriteMany',
  'ReadWriteOncePod',
] as const

export const hostPathTypeOptions = [
  '',
  'DirectoryOrCreate',
  'Directory',
  'FileOrCreate',
  'File',
  'Socket',
  'CharDevice',
  'BlockDevice',
]

// 容量写法：数字 + 可选单位，例如 10Gi、500Mi、1Ti。
export const capacityPattern = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/

export interface PVFormData {
  name: string
  capacity: string
  accessModes: string[]
  reclaimPolicy: ReclaimPolicy
  storageClassName: string
  volumeMode: '' | VolumeMode
  // 挂载参数：逗号或换行分隔，例如 hard,nfsvers=4.1。
  mountOptions: string
  // 预绑定到指定 PVC（claimRef）：两个字段要同时填，用来把卷锁定给某个已有声明。
  claimRefNamespace: string
  claimRefName: string
  sourceType: VolumeSourceType
  // hostPath
  hostPathPath: string
  hostPathType: string
  // nfs
  nfsServer: string
  nfsPath: string
  nfsReadOnly: boolean
  // local
  localPath: string
  localNodeName: string
  // csi
  csiDriver: string
  csiVolumeHandle: string
  csiFsType: string
  csiReadOnly: boolean
}

export const initialData: PVFormData = {
  name: '',
  capacity: '',
  accessModes: ['ReadWriteOnce'],
  reclaimPolicy: 'Retain',
  storageClassName: '',
  volumeMode: 'Filesystem',
  mountOptions: '',
  claimRefNamespace: '',
  claimRefName: '',
  sourceType: 'hostPath',
  hostPathPath: '',
  hostPathType: 'DirectoryOrCreate',
  nfsServer: '',
  nfsPath: '',
  nfsReadOnly: false,
  localPath: '',
  localNodeName: '',
  csiDriver: '',
  csiVolumeHandle: '',
  csiFsType: '',
  csiReadOnly: false,
}

/**
 * claimRef 要同时给出命名空间与 PVC 名称；只填一个属于无效输入（生成 YAML 时会整段丢掉，
 * 用户以为已经预绑定了）。返回 true 表示需要拦下提交。
 */
export function hasPartialClaimRef(data: PVFormData): boolean {
  const namespace = data.claimRefNamespace.trim()
  const name = data.claimRefName.trim()
  return (namespace === '') !== (name === '')
}

export function generatePVYaml(data: PVFormData): string {
  const metadata: Record<string, unknown> = { name: data.name.trim() }

  const spec: Record<string, unknown> = {
    capacity: { storage: data.capacity.trim() },
    accessModes: data.accessModes,
    persistentVolumeReclaimPolicy: data.reclaimPolicy,
  }

  if (data.storageClassName.trim()) {
    spec.storageClassName = data.storageClassName.trim()
  }
  if (data.volumeMode) {
    spec.volumeMode = data.volumeMode
  }

  const mountOptions = parseMountOptions(data.mountOptions)
  if (mountOptions.length > 0) {
    spec.mountOptions = mountOptions
  }

  // 预绑定：两个字段都给全才写，半截输入由表单拦下（见 hasPartialClaimRef）。
  const claimRefNamespace = data.claimRefNamespace.trim()
  const claimRefName = data.claimRefName.trim()
  if (claimRefNamespace && claimRefName) {
    spec.claimRef = { namespace: claimRefNamespace, name: claimRefName }
  }

  switch (data.sourceType) {
    case 'hostPath':
      spec.hostPath = {
        path: data.hostPathPath.trim(),
        ...(data.hostPathType ? { type: data.hostPathType } : {}),
      }
      break
    case 'nfs':
      spec.nfs = {
        server: data.nfsServer.trim(),
        path: data.nfsPath.trim(),
        ...(data.nfsReadOnly ? { readOnly: true } : {}),
      }
      break
    case 'local':
      spec.local = { path: data.localPath.trim() }
      // 本地卷必须声明节点亲和，否则调度器不知道该卷在哪些节点可用。
      if (data.localNodeName.trim()) {
        spec.nodeAffinity = {
          required: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  {
                    key: 'kubernetes.io/hostname',
                    operator: 'In',
                    values: [data.localNodeName.trim()],
                  },
                ],
              },
            ],
          },
        }
      }
      break
    case 'csi':
      spec.csi = {
        driver: data.csiDriver.trim(),
        volumeHandle: data.csiVolumeHandle.trim(),
        ...(data.csiFsType.trim() ? { fsType: data.csiFsType.trim() } : {}),
        ...(data.csiReadOnly ? { readOnly: true } : {}),
      }
      break
  }

  return yaml.dump(
    { apiVersion: 'v1', kind: 'PersistentVolume', metadata, spec },
    { indent: 2, noRefs: true }
  )
}

/** 从线上 PV 的 spec 判断卷来源类型；表单不支持的来源返回 null（只读展示用）。 */
export function volumeSourceOf(pv: PersistentVolume): VolumeSourceType | null {
  const spec = pv.spec
  if (!spec) return null
  if (spec.hostPath) return 'hostPath'
  if (spec.nfs) return 'nfs'
  if (spec.local) return 'local'
  if (spec.csi) return 'csi'
  return null
}

/** 本地卷的节点名藏在 nodeAffinity 里（生成时就是那么写的），这里反着取回来。 */
function localNodeNameOf(pv: PersistentVolume): string {
  const terms = pv.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? []
  for (const term of terms) {
    for (const expression of term.matchExpressions ?? []) {
      if (
        expression.key === 'kubernetes.io/hostname' &&
        expression.values?.length
      ) {
        return expression.values.join(',')
      }
    }
  }
  return ''
}

/**
 * 线上 PV → 表单。编辑模式下只有「容量 / 访问模式 / 回收策略 / 挂载参数」是可编辑的，
 * 其余字段回填只是为了在界面上看得见（渲染成只读）。
 */
export function formFromPV(pv: PersistentVolume): PVFormData {
  const spec = pv.spec || {}
  return {
    ...initialData,
    name: pv.metadata?.name || '',
    capacity: spec.capacity?.storage ? String(spec.capacity.storage) : '',
    accessModes: (spec.accessModes || []).map((mode) => String(mode)),
    reclaimPolicy:
      (spec.persistentVolumeReclaimPolicy as ReclaimPolicy) || 'Retain',
    storageClassName: spec.storageClassName || '',
    volumeMode: (spec.volumeMode as VolumeMode) || 'Filesystem',
    mountOptions: (spec.mountOptions || []).join(', '),
    claimRefNamespace: spec.claimRef?.namespace || '',
    claimRefName: spec.claimRef?.name || '',
    sourceType: volumeSourceOf(pv) ?? initialData.sourceType,
    hostPathPath: spec.hostPath?.path || '',
    hostPathType: spec.hostPath?.type || '',
    nfsServer: spec.nfs?.server || '',
    nfsPath: spec.nfs?.path || '',
    nfsReadOnly: spec.nfs?.readOnly === true,
    localPath: spec.local?.path || '',
    localNodeName: localNodeNameOf(pv),
    csiDriver: spec.csi?.driver || '',
    csiVolumeHandle: spec.csi?.volumeHandle || '',
    csiFsType: spec.csi?.fsType || '',
    csiReadOnly: spec.csi?.readOnly === true,
  }
}

/**
 * 编辑模式要提交的对象：只取表单里**真正可变**的那几项，其余全部从线上对象带过去。
 *
 * 可改范围是实测出来的（k8s 1.32，见 docs/dev/plans/2026-09-20-PV与SC表单编辑.md）：
 *   ✓ capacity（可增）/ accessModes / persistentVolumeReclaimPolicy / mountOptions / 元数据
 *   ✗ 卷来源（hostPath、nfs、csi…）：Forbidden: spec.persistentvolumesource ...
 *   ✗ volumeMode：field is immutable
 * 表单没建模的（iops 这类扩展容量、status、uid…）同样原样保留 —— PUT 是整体替换，
 * 漏掉就等于删掉。
 */
export function pvUpdateFromForm(
  data: PVFormData,
  existing: PersistentVolume
): PersistentVolume {
  const spec: Record<string, unknown> = {
    ...existing.spec,
    // capacity 里可能还有 iops 这类扩展资源，只覆盖 storage 这一项。
    capacity: { ...existing.spec?.capacity, storage: data.capacity.trim() },
    accessModes: [...data.accessModes],
    persistentVolumeReclaimPolicy: data.reclaimPolicy,
  }

  const mountOptions = parseMountOptions(data.mountOptions)
  if (mountOptions.length > 0) {
    spec.mountOptions = mountOptions
  } else {
    // 「清空」就是不要：沿用线上对象的话就永远删不掉。
    delete spec.mountOptions
  }

  return { ...existing, spec } as PersistentVolume
}
