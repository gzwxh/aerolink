/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CurrentClusterBadge } from './current-cluster-badge'

vi.mock('react-i18next', () => ({
  // 组件只用 t(key, defaultValue)，直接回 defaultValue。
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
  }),
}))

vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({
    currentCluster: 'devops-wxh',
    clusters: [
      {
        name: 'devops-wxh',
        badgeEnabled: true,
        badgeText: '生产环境',
        badgeColor: '#0011ff',
      },
    ],
  }),
}))

describe('CurrentClusterBadge', () => {
  // 集群名不再带「当前集群：」前缀：前缀只是重复的标签，字小又要多看一眼。
  it('只显示集群名，不显示「当前集群：」前缀', () => {
    render(<CurrentClusterBadge />)

    expect(screen.queryByText(/当前集群/)).toBeNull()
    expect(screen.getByText('devops-wxh')).toBeInTheDocument()
  })

  // 前缀从界面上拿掉后，语义挪到 title 上：悬停仍能确认这个徽章是「当前集群」。
  it('集群名徽章的 title 说明它是当前集群', () => {
    render(<CurrentClusterBadge />)

    expect(screen.getByTitle('当前集群')).toHaveTextContent('devops-wxh')
  })

  it('自定义说明徽章照常显示', () => {
    render(<CurrentClusterBadge />)

    expect(screen.getByTitle('生产环境')).toHaveTextContent('生产环境')
  })
})
