import { expect, test } from '@playwright/test'

import { e2eContextName } from '../env'
import { expectJSON, expectStatus } from '../support/admin-api'

/**
 * 集群级存储资源的创建冒烟测试：StorageClass 与 PersistentVolume 各走一次真实界面，
 * 用 API 复核落库结果，最后无论成功失败都删掉创建出来的对象。
 *
 * 这两个资源页以前完全没有自动化覆盖，而它们有两个「不报错但会坑人」的点，本文件
 * 专门锁住（口径见 docs/dev/plans/2026-09-20-storage-create-hardening.md）：
 *   1. no-provisioner（纯静态卷）必须用 WaitForFirstConsumer，否则 PVC 可能绑到
 *      Pod 调度不上去的节点上（Bound 却一直 Pending）；
 *   2. 同名参数在生成的 YAML 里只会保留最后一行，界面必须拦下而不是静默丢弃。
 *
 * 运行（对已有集群、真实 K8s，两个用例都自清理）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config \
 *     E2E_CLUSTER_NAME=<context 名> E2E_CONTEXT_NAME=<context 名> E2E_NODE_NAME=<node> \
 *     SPEC="specs/storage-creation.spec.ts"
 */

const cluster = e2eContextName
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(cluster)}`

const uniqueName = (kind: string) => `zz-e2e-${kind}-${Date.now().toString(36)}`

const staticProvisioner = 'kubernetes.io/no-provisioner'

type StorageClass = {
  provisioner: string
  reclaimPolicy: string
  volumeBindingMode: string
  allowedTopologies?: Array<{
    matchLabelExpressions: Array<{ key: string; values: string[] }>
  }>
}

type PersistentVolume = {
  spec: {
    capacity: { storage: string }
    accessModes: string[]
    persistentVolumeReclaimPolicy: string
    hostPath?: { path: string; type?: string }
    storageClassName?: string
    mountOptions?: string[]
    claimRef?: { namespace: string; name: string }
  }
}

test('a static StorageClass is created with WaitForFirstConsumer', async ({
  page,
  request,
}) => {
  const name = uniqueName('sc')

  try {
    await page.goto('/storageclasses/create')
    await page.getByPlaceholder('fast-ssd').fill(name)
    // 纯静态卷：界面应自动改用 WaitForFirstConsumer 并说明原因。
    await page.getByPlaceholder('rancher.io/local-path').fill(staticProvisioner)
    await expect(
      page.getByText('the binding mode was switched to WaitForFirstConsumer')
    ).toBeVisible()
    await page
      .getByPlaceholder('topology.kubernetes.io/zone=cn-south-1a')
      .fill('topology.kubernetes.io/zone=cn-south-1a,cn-south-1b')

    await page.getByRole('button', { name: 'Create StorageClass' }).click()
    await page.waitForURL((url) => url.pathname === '/storageclasses')

    const created = await expectJSON<StorageClass>(
      await request.get(`${clusterPath}/storageclasses/_all/${name}`),
      200
    )
    expect(created.provisioner).toBe(staticProvisioner)
    expect(created.volumeBindingMode).toBe('WaitForFirstConsumer')
    expect(created.reclaimPolicy).toBe('Delete')
    expect(created.allowedTopologies).toEqual([
      {
        matchLabelExpressions: [
          {
            key: 'topology.kubernetes.io/zone',
            values: ['cn-south-1a', 'cn-south-1b'],
          },
        ],
      },
    ])
  } finally {
    await request
      .delete(`${clusterPath}/storageclasses/_all/${name}`)
      .catch(() => undefined)
  }
})

test('a StorageClass with duplicate parameter names is rejected by the form', async ({
  page,
  request,
}) => {
  const name = uniqueName('scdup')

  try {
    await page.goto('/storageclasses/create')
    await page.getByPlaceholder('fast-ssd').fill(name)
    await page.getByPlaceholder('rancher.io/local-path').fill('csi-hostpath')

    const keys = page.getByPlaceholder('Key')
    await keys.first().fill('server')
    await page.getByRole('button', { name: 'Add parameter' }).click()
    await keys.nth(1).fill('server')

    await expect(
      page.getByText('Duplicate parameter names: server')
    ).toBeVisible()
    await page.getByRole('button', { name: 'Create StorageClass' }).click()

    // 什么都没建出去：拦在界面这一层，不是靠服务端拒绝。
    await expectStatus(
      await request.get(`${clusterPath}/storageclasses/_all/${name}`),
      404
    )
  } finally {
    await request
      .delete(`${clusterPath}/storageclasses/_all/${name}`)
      .catch(() => undefined)
  }
})

test('a hostPath PersistentVolume is created with the fields from the form', async ({
  page,
  request,
}) => {
  const name = uniqueName('pv')

  try {
    await page.goto('/persistentvolumes/create')
    await page.getByPlaceholder('pv-data-01', { exact: true }).fill(name)
    await page.getByPlaceholder('10Gi').fill('10Gi')
    await page
      .getByPlaceholder('/data/volumes/pv-data-01', { exact: true })
      .fill('/data/volumes/zz-e2e')
    await page.getByPlaceholder('hard, nfsvers=4.1').fill('hard, nfsvers=4.1')
    await page.getByPlaceholder('Namespace', { exact: true }).fill('default')
    await page
      .getByPlaceholder('PVC name', { exact: true })
      .fill(`zz-e2e-pvc-${Date.now().toString(36)}`)

    await page.getByRole('button', { name: 'Create PersistentVolume' }).click()
    await page.waitForURL((url) => url.pathname === '/persistentvolumes')

    const created = await expectJSON<PersistentVolume>(
      await request.get(`${clusterPath}/persistentvolumes/_all/${name}`),
      200
    )
    expect(created.spec.capacity.storage).toBe('10Gi')
    expect(created.spec.accessModes).toEqual(['ReadWriteOnce'])
    expect(created.spec.persistentVolumeReclaimPolicy).toBe('Retain')
    expect(created.spec.hostPath?.path).toBe('/data/volumes/zz-e2e')
    expect(created.spec.hostPath?.type).toBe('DirectoryOrCreate')
    expect(created.spec.mountOptions).toEqual(['hard', 'nfsvers=4.1'])
    // 预绑定：指向一个此刻还不存在的 PVC，卷会被保留给它。
    expect(created.spec.claimRef?.namespace).toBe('default')
    expect(created.spec.claimRef?.name).toMatch(/^zz-e2e-pvc-/)
  } finally {
    await request
      .delete(`${clusterPath}/persistentvolumes/_all/${name}`)
      .catch(() => undefined)
  }
})

test('a PersistentVolume with a malformed capacity is rejected by the form', async ({
  page,
  request,
}) => {
  const name = uniqueName('pvb')

  try {
    await page.goto('/persistentvolumes/create')
    await page.getByPlaceholder('pv-data-01', { exact: true }).fill(name)
    await page.getByPlaceholder('10Gi').fill('abc')
    await page
      .getByPlaceholder('/data/volumes/pv-data-01', { exact: true })
      .fill('/data/volumes/zz-e2e')

    await page.getByRole('button', { name: 'Create PersistentVolume' }).click()

    // 同一条文案也会以 toast 形式出现，这里只看页面上的错误框。
    await expect(
      page.getByRole('main').getByText('Capacity looks like 10Gi, 500Mi or 1Ti')
    ).toBeVisible()
    await expectStatus(
      await request.get(`${clusterPath}/persistentvolumes/_all/${name}`),
      404
    )
  } finally {
    await request
      .delete(`${clusterPath}/persistentvolumes/_all/${name}`)
      .catch(() => undefined)
  }
})
