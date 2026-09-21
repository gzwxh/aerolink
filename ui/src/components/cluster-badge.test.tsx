/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  CLUSTER_BADGE_TEXT_MAX_LENGTH,
  ClusterBadge,
  ClusterBadgeIcon,
  DEFAULT_CLUSTER_BADGE_COLOR,
  hasClusterBadge,
  resolveClusterBadgeColor,
} from './cluster-badge'

describe('resolveClusterBadgeColor', () => {
  it('非法颜色回落默认色，不把任意字符串塞进内联样式', () => {
    expect(resolveClusterBadgeColor('#0011ff')).toBe('#0011ff')
    expect(resolveClusterBadgeColor('  #AABBCC  ')).toBe('#AABBCC')
    expect(resolveClusterBadgeColor(undefined)).toBe(
      DEFAULT_CLUSTER_BADGE_COLOR
    )
    expect(resolveClusterBadgeColor('red')).toBe(DEFAULT_CLUSTER_BADGE_COLOR)
    expect(resolveClusterBadgeColor('#fff;background:url(x)')).toBe(
      DEFAULT_CLUSTER_BADGE_COLOR
    )
  })
})

describe('hasClusterBadge', () => {
  it('只有启用且有说明文本才算启用徽章', () => {
    expect(hasClusterBadge({ badgeEnabled: true, badgeText: '测试' })).toBe(
      true
    )
    expect(hasClusterBadge({ badgeEnabled: true, badgeText: '   ' })).toBe(
      false
    )
    expect(hasClusterBadge({ badgeEnabled: false, badgeText: '测试' })).toBe(
      false
    )
    expect(hasClusterBadge(null)).toBe(false)
  })
})

describe('ClusterBadge', () => {
  it('未启用或没有说明文本时不渲染占位', () => {
    const { container } = render(
      <>
        <ClusterBadge cluster={{ badgeText: '测试环境' }} />
        <ClusterBadge cluster={{ badgeEnabled: true, badgeText: '  ' }} />
        <ClusterBadge cluster={null} />
      </>
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('启用后显示说明文本与背景色，完整文案留在 title 上', () => {
    render(
      <ClusterBadge
        cluster={{
          badgeEnabled: true,
          badgeText: '  测试环境  ',
          badgeColor: '#0011ff',
        }}
      />
    )

    const badge = screen.getByTitle('测试环境')
    expect(badge).toHaveTextContent('测试环境')
    expect(badge).toHaveStyle({ backgroundColor: '#0011ff' })
  })

  // 说明文本上限 16 个字符，且必须整段显示：宽度就是按这个口径留的，
  // 加 max-w-* / truncate 会把末尾几个字吃掉。
  it('16 个字符的说明完整显示，不截断', () => {
    const text = '测'.repeat(CLUSTER_BADGE_TEXT_MAX_LENGTH)
    const { container } = render(
      <ClusterBadge cluster={{ badgeEnabled: true, badgeText: text }} />
    )

    expect(CLUSTER_BADGE_TEXT_MAX_LENGTH).toBe(16)
    expect(screen.getByTitle(text)).toHaveTextContent(text)
    expect(container.querySelector('.truncate')).toBeNull()
  })
})

describe('ClusterBadgeIcon', () => {
  it('没自定义图标时用默认集群图标', () => {
    const { container } = render(
      <ClusterBadgeIcon
        cluster={{ badgeEnabled: true, badgeText: '测试环境' }}
      />
    )

    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('自定义图标开启后用图标文本，并带上徽章底色', () => {
    const { container } = render(
      <ClusterBadgeIcon
        cluster={{
          badgeEnabled: true,
          badgeText: '测试环境',
          badgeColor: '#0011ff',
          badgeIconEnabled: true,
          badgeIconText: ' 测试 ',
        }}
      />
    )

    expect(container.querySelector('svg')).toBeNull()
    const icon = screen.getByTitle('测试')
    expect(icon).toHaveTextContent('测试')
    expect(icon).toHaveStyle({ backgroundColor: '#0011ff' })
  })

  // 图标与徽章开关互相独立：只换图标、不显示说明的集群也必须能看到自己的图标，
  // 否则「上传了图标但界面上毫无变化」。
  it('徽章未启用时，只设了图标文本也照样显示', () => {
    const { container } = render(
      <ClusterBadgeIcon
        cluster={{ badgeIconEnabled: true, badgeIconText: '测试' }}
      />
    )

    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByTitle('测试')).toHaveTextContent('测试')
  })

  it('上传的图片优先于图标文本', () => {
    const { container } = render(
      <ClusterBadgeIcon
        cluster={{
          badgeIconEnabled: true,
          badgeIconText: '测试',
          badgeIconUrl: '/api/v1/clusters/1/badge-icon?v=abc',
        }}
      />
    )

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toContain('/api/v1/clusters/1/badge-icon')
    expect(screen.queryByTitle('测试')).toBeNull()
  })

  it('图标开关关闭时即使有地址也回默认图标', () => {
    const { container } = render(
      <ClusterBadgeIcon
        cluster={{ badgeIconUrl: '/api/v1/clusters/1/badge-icon?v=abc' }}
      />
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  // 图标文本上限 6 个汉字，且必须整段显示：宽度按最长文本留白，
  // 加 truncate 会把第 5、6 个字吃掉。
  it('6 个汉字的图标文本完整显示，不截断', () => {
    const { container } = render(
      <ClusterBadgeIcon
        cluster={{ badgeIconEnabled: true, badgeIconText: '测试环境图标' }}
      />
    )

    const icon = screen.getByTitle('测试环境图标')
    expect(icon).toHaveTextContent('测试环境图标')
    expect(container.querySelector('.truncate')).toBeNull()
  })
})
