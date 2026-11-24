import { beforeEach, describe, expect, it } from 'vitest'

import type { Cluster } from '@/types/api'

import {
  acknowledgeTerminal,
  classifyWriteOperation,
  currentWriteConfirmRequest,
  hasAnyWriteConfirm,
  isSystemNamespace,
  isTerminalAcknowledged,
  parseWriteTarget,
  requestWriteConfirm,
  requiresWriteConfirm,
  resetWriteConfirmForTest,
  resolveWriteConfirm,
  setClusterConfirmPolicies,
  writeConfirmFor,
  type WriteConfirmRequest,
} from './write-confirm'

const cluster = (name: string, extra: Partial<Cluster> = {}): Cluster =>
  ({ name, ...extra }) as Cluster

describe('系统命名空间的写操作一律要确认（验收台账 D-144）', () => {
  it('kube-* 前缀算系统命名空间', () => {
    expect(isSystemNamespace('kube-system')).toBe(true)
    expect(isSystemNamespace('kube-public')).toBe(true)
    expect(isSystemNamespace('default')).toBe(false)
    expect(isSystemNamespace(undefined)).toBe(false)
  })

  it('集群开关全关时，kube-system 里的删除仍然拦一道', () => {
    setClusterConfirmPolicies([cluster('dev')])
    window.sessionStorage.setItem('current-cluster', 'dev')

    const request = writeConfirmFor(
      'DELETE',
      '/pods/kube-system/calico-node-abc123'
    )
    expect(request).not.toBeNull()
    expect(request?.system).toBe(true)
    expect(request?.target.namespace).toBe('kube-system')
  })

  it('同样的开关下，业务命名空间照旧直接放行（不把确认变成日常噪声）', () => {
    setClusterConfirmPolicies([cluster('dev')])
    window.sessionStorage.setItem('current-cluster', 'dev')

    const request = writeConfirmFor('DELETE', '/pods/team-a/web-1')
    expect(request).toBeNull()
  })

  it('开关打开时，业务命名空间的请求标记为非系统', () => {
    setClusterConfirmPolicies([cluster('dev', { confirmDelete: true })])
    window.sessionStorage.setItem('current-cluster', 'dev')

    expect(writeConfirmFor('DELETE', '/pods/team-a/web-1')?.system).toBe(false)
  })
})

describe('classifyWriteOperation', () => {
  it('按 HTTP 方法推断常规 CRUD', () => {
    expect(classifyWriteOperation('DELETE', '/deployments/default/nginx')).toBe(
      'delete'
    )
    expect(classifyWriteOperation('POST', '/deployments/default')).toBe(
      'create'
    )
    expect(classifyWriteOperation('PUT', '/deployments/default/nginx')).toBe(
      'update'
    )
    expect(classifyWriteOperation('PATCH', '/pods/default/web')).toBe('update')
  })

  it('只读请求不参与确认', () => {
    expect(
      classifyWriteOperation('GET', '/deployments/default/nginx')
    ).toBeNull()
    expect(classifyWriteOperation('HEAD', '/nodes')).toBeNull()
  })

  // 改 AeroLink 自身配置的接口不该再弹一次确认，否则「打开确认开关」这个动作本身都要确认。
  it('排除后台管理与认证接口', () => {
    expect(classifyWriteOperation('PUT', '/admin/clusters/1')).toBeNull()
    expect(classifyWriteOperation('POST', '/admin/templates/')).toBeNull()
    expect(classifyWriteOperation('POST', '/auth/login/password')).toBeNull()
    expect(classifyWriteOperation('POST', '/auth/refresh')).toBeNull()
  })

  it('首段不是 k8s 资源的写请求不参与（个人设置、通知这类）', () => {
    expect(classifyWriteOperation('PUT', '/notifications/read-all')).toBeNull()
    expect(classifyWriteOperation('POST', '/sidebar/preference')).toBeNull()
  })

  it('节点维护类靠路径识别（与普通 PUT 区分）', () => {
    expect(classifyWriteOperation('PUT', '/nodes/_all/node-1/drain')).toBe(
      'nodeMaintenance'
    )
    expect(classifyWriteOperation('PUT', '/nodes/_all/node-1/cordon')).toBe(
      'nodeMaintenance'
    )
    expect(classifyWriteOperation('PUT', '/nodes/_all/node-1/taint')).toBe(
      'nodeMaintenance'
    )
  })

  // 重启与普通修改同 URL 同 method，只有调用方标注才能区分。
  it('显式标注优先', () => {
    expect(
      classifyWriteOperation('PATCH', '/deployments/default/nginx', 'restart')
    ).toBe('restart')
  })

  it('YAML apply 与 Helm release 走 k8s 写口径', () => {
    expect(classifyWriteOperation('POST', '/resources/apply')).toBe('create')
    expect(classifyWriteOperation('PUT', '/helmrelease/ns/rel/upgrade')).toBe(
      'update'
    )
    expect(classifyWriteOperation('DELETE', '/helmrelease/ns/rel')).toBe(
      'delete'
    )
  })
})

describe('parseWriteTarget', () => {
  it('解析资源 / 命名空间 / 名称', () => {
    expect(parseWriteTarget('/deployments/default/nginx')).toEqual({
      resource: 'deployments',
      namespace: 'default',
      name: 'nginx',
    })
    expect(parseWriteTarget('/deployments/default')).toEqual({
      resource: 'deployments',
      namespace: 'default',
      name: undefined,
    })
  })

  it('_all 不是真正的命名空间', () => {
    expect(parseWriteTarget('/nodes/_all/node-1/drain')).toEqual({
      resource: 'nodes',
      namespace: undefined,
      name: 'node-1',
    })
  })

  it('同样剥掉 /_clusters/<集群名> 前缀', () => {
    expect(
      parseWriteTarget('/_clusters/prod-1/deployments/default/nginx')
    ).toEqual({
      resource: 'deployments',
      namespace: 'default',
      name: 'nginx',
    })
  })
})

describe('按集群的确认策略', () => {
  beforeEach(() => {
    resetWriteConfirmForTest()
    window.sessionStorage.clear()
  })

  it('只对该集群开启的类别要求确认', () => {
    setClusterConfirmPolicies([
      cluster('dev', { confirmDelete: true, confirmRestart: true }),
      cluster('prod'),
    ])

    expect(requiresWriteConfirm('dev', 'delete')).toBe(true)
    expect(requiresWriteConfirm('dev', 'restart')).toBe(true)
    expect(requiresWriteConfirm('dev', 'create')).toBe(false)
    expect(requiresWriteConfirm('prod', 'delete')).toBe(false)
    // 未知集群（缓存里没有）按不需要处理，避免误弹。
    expect(requiresWriteConfirm('unknown', 'delete')).toBe(false)
    expect(requiresWriteConfirm(null, 'delete')).toBe(false)
  })

  it('开关关闭时 writeConfirmFor 直接放行', () => {
    setClusterConfirmPolicies([cluster('dev')])
    window.sessionStorage.setItem('current-cluster', 'dev')

    expect(writeConfirmFor('DELETE', '/deployments/default/nginx')).toBeNull()
  })

  it('开关打开时给出确认请求（含集群与操作对象）', () => {
    setClusterConfirmPolicies([cluster('dev', { confirmDelete: true })])
    window.sessionStorage.setItem('current-cluster', 'dev')

    expect(writeConfirmFor('DELETE', '/deployments/default/nginx')).toEqual({
      cluster: 'dev',
      kind: 'delete',
      method: 'DELETE',
      target: { resource: 'deployments', namespace: 'default', name: 'nginx' },
      system: false,
    })
  })

  it('带 /_clusters/<集群名> 前缀的请求同样给出确认请求', () => {
    setClusterConfirmPolicies([cluster('dev', { confirmDelete: true })])
    window.sessionStorage.setItem('current-cluster', 'dev')

    expect(
      writeConfirmFor('DELETE', '/_clusters/dev/deployments/default/nginx')
    ).toEqual({
      cluster: 'dev',
      kind: 'delete',
      method: 'DELETE',
      target: { resource: 'deployments', namespace: 'default', name: 'nginx' },
      system: false,
    })
  })
})

// 批量操作（如一次重启多个 Deployment）会并发进入确认桥。这里锁住两点：同类合并成
// 一次确认、异类排队逐个确认，且每个 Promise 都有结果——单槽 pending 曾让先到的请求
// 被后到的覆盖而永久挂起，界面卡在「处理中 (1/3)」。
describe('并发写入的确认桥', () => {
  beforeEach(() => {
    resetWriteConfirmForTest()
  })

  const restart = (name: string): WriteConfirmRequest => ({
    cluster: 'dev',
    kind: 'restart',
    method: 'PATCH',
    target: { resource: 'deployments', namespace: 'default', name },
  })

  it('同类并发请求合并成一次确认，确认后全部放行', async () => {
    const waiting = ['a', 'b', 'c'].map((name) =>
      requestWriteConfirm(restart(name))
    )

    expect(currentWriteConfirmRequest()).toEqual({
      request: restart('a'),
      count: 3,
    })

    resolveWriteConfirm(true)

    await expect(Promise.all(waiting)).resolves.toEqual([true, true, true])
    expect(currentWriteConfirmRequest()).toBeNull()
  })

  it('取消时同类并发请求全部不放行', async () => {
    const waiting = ['a', 'b'].map((name) => requestWriteConfirm(restart(name)))
    expect(currentWriteConfirmRequest()?.count).toBe(2)

    resolveWriteConfirm(false)

    await expect(Promise.all(waiting)).resolves.toEqual([false, false])
  })

  it('不同类别排队逐个确认，前一个不被后一个覆盖', async () => {
    const first = requestWriteConfirm(restart('a'))
    const second = requestWriteConfirm({
      ...restart('b'),
      kind: 'delete',
      method: 'DELETE',
    })

    expect(currentWriteConfirmRequest()?.request.kind).toBe('restart')
    resolveWriteConfirm(true)
    await expect(first).resolves.toBe(true)

    expect(currentWriteConfirmRequest()?.request.kind).toBe('delete')
    resolveWriteConfirm(true)
    await expect(second).resolves.toBe(true)
    expect(currentWriteConfirmRequest()).toBeNull()
  })
})

// 终端（交互式 kubectl / exec）绕过 api-client，拦不住具体命令，
// 只能在进入前提示一次；这组用例锁住「什么时候提示、提示一次还是每次都提示」。
describe('终端风险提示的判定', () => {
  beforeEach(() => {
    resetWriteConfirmForTest()
    window.sessionStorage.clear()
  })

  it('只有开启了任一类别才算需要提示', () => {
    setClusterConfirmPolicies([
      cluster('dev', { confirmDelete: true }),
      cluster('prod'),
    ])

    expect(hasAnyWriteConfirm('dev')).toBe(true)
    expect(hasAnyWriteConfirm('prod')).toBe(false)
    expect(hasAnyWriteConfirm('unknown')).toBe(false)
    expect(hasAnyWriteConfirm(null)).toBe(false)
  })

  it('确认过一次后本次会话不再提示同一集群', () => {
    expect(isTerminalAcknowledged('dev')).toBe(false)

    acknowledgeTerminal('dev')

    expect(isTerminalAcknowledged('dev')).toBe(true)
    // 别的集群不受影响。
    expect(isTerminalAcknowledged('prod')).toBe(false)
  })

  it('没有当前集群时不需要提示', () => {
    expect(isTerminalAcknowledged(null)).toBe(true)
  })
})
