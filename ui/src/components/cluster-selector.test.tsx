/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClusterSelector } from './cluster-selector'

vi.mock('react-i18next', () => ({
  // 组件只用 t(key, defaultValue)，直接回 defaultValue。
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
  }),
}))

const useCluster = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => useCluster(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  useCluster.mockReset()
})

function mockCluster(overrides: Record<string, unknown> = {}) {
  useCluster.mockReturnValue({
    clusters: [{ name: '开发环境', ...overrides }],
    currentCluster: '开发环境',
    setCurrentCluster: vi.fn(),
    isSwitching: false,
    isLoading: false,
  })
}

/** 固定所有元素的「内容宽 / 可见宽」，验证只在截断时挂原生 title。 */
function stubWidths(scrollWidth: number, clientWidth: number) {
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth)
}

describe('ClusterSelector 收起态的原生 title', () => {
  // 完整可见也弹 title 提示的话，会盖住侧边栏后面的菜单内容。
  it('集群名完整可见时不挂 title，悬停不再弹提示', () => {
    stubWidths(100, 100)
    mockCluster()
    render(<ClusterSelector />)

    expect(screen.getByText('开发环境')).not.toHaveAttribute('title')
  })

  it('集群名被截断时挂 title，保留完整名称兜底', () => {
    stubWidths(120, 100)
    mockCluster()
    render(<ClusterSelector />)

    expect(screen.getByText('开发环境')).toHaveAttribute('title', '开发环境')
  })

  it('描述完整可见时同样不挂 title', () => {
    stubWidths(100, 100)
    mockCluster({ description: '日常开发用集群' })
    render(<ClusterSelector />)

    expect(screen.getByText('日常开发用集群')).not.toHaveAttribute('title')
  })
})
