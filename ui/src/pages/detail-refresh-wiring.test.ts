import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 详情页的「刷新」必须把走 SSE 的 Pods 列表一并重取。
 *
 * Pods 走 `useResourcesWatch`：数据在本地 state 里，不归 react-query 管，外壳的
 * `refetchQueries` 碰不到它。只接主资源就会出现用户报过的现象——Pod 已经删掉，
 * 点「刷新」列表还是旧的，只有整页重载才更新。
 *
 * 详情页没有组件级测试（要 mock 路由、api、权限与 Monaco，成本远超这条约定本身），
 * 因此这里照 `i18n/locales.test.ts` 的做法用源码断言兜住：用了 watch 的详情页，
 * 必须把那条 watch 的 refetch 命名成 `refetchPods` 并在刷新里调用它。
 */
describe('详情页刷新接线', () => {
  const pagesDir = join(process.cwd(), 'src/pages')

  it('用到 Pod watch 的详情页都调用了它自己的 refetch', () => {
    const offenders = readdirSync(pagesDir)
      .filter((file) => file.endsWith('-detail.tsx'))
      .filter((file) => {
        const source = readFileSync(join(pagesDir, file), 'utf-8')
        return (
          source.includes('useResourcesWatch') &&
          !source.includes('refetchPods()')
        )
      })

    expect(offenders).toEqual([])
  })
})
