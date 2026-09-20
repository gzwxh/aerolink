import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  formEditableResourceTypes,
  getResourceFormEditPath,
  hasResourceFormEdit,
  isClusterScopedResource,
} from './resource-catalog'

describe('getResourceFormEditPath', () => {
  it('命名空间级资源的路径带命名空间段', () => {
    expect(getResourceFormEditPath('secrets', 'kite-secret', 'kite')).toBe(
      '/secrets/kite/kite-secret/edit'
    )
    expect(
      getResourceFormEditPath('configmaps', 'nginx conf', 'kube-system')
    ).toBe('/configmaps/kube-system/nginx%20conf/edit')
  })

  it('集群级资源的路径不带命名空间段', () => {
    expect(getResourceFormEditPath('persistentvolumes', 'pv-data-01')).toBe(
      '/persistentvolumes/pv-data-01/edit'
    )
    expect(getResourceFormEditPath('storageclasses', 'fast-ssd')).toBe(
      '/storageclasses/fast-ssd/edit'
    )
  })

  it('没有表单编辑页的资源返回 undefined', () => {
    expect(hasResourceFormEdit('ingresses')).toBe(false)
    expect(
      getResourceFormEditPath('ingresses', 'web', 'default')
    ).toBeUndefined()
    expect(getResourceFormEditPath('nodes', 'node1')).toBeUndefined()
  })
})

/**
 * 路径表与 `routes.tsx` 必须对得上。
 *
 * 漏登记或写错段的后果是「点了编辑什么也没发生」（路由不匹配直接 404），
 * 手工点一遍很容易漏掉某一类资源，所以这里直接核对路由表本身。
 */
describe('表单编辑页的路由覆盖', () => {
  // vitest 的 root 是 ui/ 目录（见 vitest.config.ts），相对路径按它展开。
  const routesSource = readFileSync(resolve('src/routes.tsx'), 'utf8')
  const routePaths = new Set(
    [...routesSource.matchAll(/path: '([^']+)'/g)].map((match) => match[1])
  )

  it('每个登记的表单编辑资源都有对应的编辑路由', () => {
    // 先确认确实解析到了路由，否则下面循环空转也会「通过」。
    expect(routePaths.size).toBeGreaterThan(0)

    for (const resource of formEditableResourceTypes) {
      const expected = isClusterScopedResource(resource)
        ? `${resource}/:name/edit`
        : `${resource}/:namespace/:name/edit`
      expect(routePaths, `${resource} 缺少编辑路由`).toContain(expected)
    }
  })
})
