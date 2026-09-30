import { describe, expect, it } from 'vitest'

import { knownNodePortRange } from './node-port-range'

/**
 * NodePort 的合法范围只有从 kube-apiserver 真正读到才算数：后端读不到 flag 时会回退成
 * K8s 默认的 30000-32767 并标 `source: "default"`，接口本身还要求管理员。把那个回退值
 * 当集群事实去校验，会把合法端口（集群自定义了范围时）标红，所以这里一律返回 null。
 */
describe('knownNodePortRange', () => {
  it('读到的范围来自 kube-apiserver 时才返回', () => {
    expect(
      knownNodePortRange({ min: 20000, max: 30000, source: 'kube-apiserver' })
    ).toEqual({ min: 20000, max: 30000 })
  })

  it('后端回退到默认值、没数据、或范围本身不合法时返回 null', () => {
    expect(
      knownNodePortRange({ min: 30000, max: 32767, source: 'default' })
    ).toBeNull()
    expect(knownNodePortRange(undefined)).toBeNull()
    expect(
      knownNodePortRange({ min: 30000, max: 30000, source: 'kube-apiserver' })
    ).toBeNull()
    expect(
      knownNodePortRange({ min: 0, max: 32767, source: 'kube-apiserver' })
    ).toBeNull()
  })
})
