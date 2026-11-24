import { describe, expect, it } from 'vitest'

import {
  extractConditions,
  hasFailingCondition,
  isConditionPassing,
} from './resource-conditions'

// 回归（验收台账 D-175）：Gateway API / cert-manager 的健康信号只有状态条件，
// 原先通用详情页一处都不呈现，只能翻 YAML。

describe('extractConditions', () => {
  it('没有 status 时给空数组而不是报错', () => {
    expect(extractConditions(null)).toEqual([])
    expect(extractConditions({})).toEqual([])
    expect(extractConditions({ status: undefined })).toEqual([])
  })

  it('标准 status.conditions（cert-manager Certificate 的形状）', () => {
    const got = extractConditions({
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'SecretValid',
            message: 'Secret is valid',
            lastTransitionTime: '2026-11-24T10:00:00Z',
          },
        ],
      },
    })
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({
      type: 'Ready',
      status: 'True',
      reason: 'SecretValid',
      scope: undefined,
    })
  })

  // Gateway API v1 把路由的状态放在 status.parents[].conditions，而不是 status.conditions。
  it('路由的 status.parents[].conditions 要带上是哪个网关给的', () => {
    const got = extractConditions({
      status: {
        parents: [
          {
            parentName: 'default/gateway-a',
            controllerName: 'example.com/gateway',
            conditions: [
              { type: 'Accepted', status: 'True' },
              {
                type: 'ResolvedRefs',
                status: 'False',
                reason: 'BackendNotFound',
                message: 'service "web" not found',
              },
            ],
          },
        ],
      },
    })
    expect(got.map((c) => `${c.scope}/${c.type}=${c.status}`)).toEqual([
      'default/gateway-a/Accepted=True',
      'default/gateway-a/ResolvedRefs=False',
    ])
    expect(hasFailingCondition(got)).toBe(true)
  })

  it('Gateway 的逐监听器条件也收进来', () => {
    const got = extractConditions({
      status: {
        conditions: [{ type: 'Programmed', status: 'True' }],
        listeners: [
          {
            name: 'http',
            attachedRoutes: 1,
            conditions: [{ type: 'Accepted', status: 'False', reason: 'PortUnavailable' }],
          },
        ],
      },
    })
    expect(got.map((c) => `${c.scope ?? 'top'}/${c.type}`)).toEqual([
      'top/Programmed',
      'listener:http/Accepted',
    ])
  })

  it('缺 type 的条目丢掉，缺 status 的显示为 -', () => {
    const got = extractConditions({
      status: { conditions: [{ reason: 'no type' }, { type: 'Ready' }] },
    })
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'Ready', status: '-' })
  })

  it('conditions 不是数组时不炸', () => {
    expect(extractConditions({ status: { conditions: 'oops' } })).toEqual([])
  })

  it('True 之外的值都算需要看一眼', () => {
    expect(isConditionPassing({ type: 'Ready', status: 'True' })).toBe(true)
    expect(isConditionPassing({ type: 'Ready', status: 'Unknown' })).toBe(false)
    expect(hasFailingCondition([{ type: 'Ready', status: 'True' }])).toBe(false)
  })
})
