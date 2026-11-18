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
  resolveClusterBadgeForeground,
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

describe('resolveClusterBadgeForeground', () => {
  it('浅色底选黑字，深色底（含默认色与非法回落）选白字', () => {
    expect(resolveClusterBadgeForeground('#ffffff').color).toBe('#000000')
    expect(resolveClusterBadgeForeground('#e6f4f0').color).toBe('#000000')
    expect(resolveClusterBadgeForeground('#0011ff').color).toBe('#ffffff')
    expect(resolveClusterBadgeForeground('#000000').color).toBe('#ffffff')
    // 非法颜色回落默认色（深蓝），同样白字。
    expect(resolveClusterBadgeForeground('red').color).toBe('#ffffff')
  })

  // 黑/白两字的对比度曲线在亮度约 0.18 处相交，交点约 4.58:1——
  // 所以「自动选更清晰的那种」对任何底色都至少 AA（4.5:1），
  // 这是不依赖具体取值的性质，配置弹窗也因此不需要低对比警示。
  it('任何合法底色，选出的字色对比度都不低于 4.5:1', () => {
    const samples = [
      '#ffffff',
      '#e6f4f0',
      '#b0b0b0',
      '#808080',
      '#444444',
      '#0011ff',
      '#000000',
    ]
    for (const color of samples) {
      expect(
        resolveClusterBadgeForeground(color).contrast
      ).toBeGreaterThanOrEqual(4.5)
    }
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
    // 深色底自动配白字。
    expect(badge).toHaveStyle({ color: '#ffffff' })
  })

  it('浅色自选底自动配黑字，不再写死白字', () => {
    render(
      <ClusterBadge
        cluster={{
          badgeEnabled: true,
          badgeText: '测试环境',
          badgeColor: '#e6f4f0',
        }}
      />
    )

    expect(screen.getByTitle('测试环境')).toHaveStyle({ color: '#000000' })
  })

  // 字色可单独设置；留空或非法时按背景色自动取黑/白，默认配置始终可读。
  it('说明文字颜色可单独设置，留空或非法时按背景色自动', () => {
    render(
      <>
        <ClusterBadge
          cluster={{
            badgeEnabled: true,
            badgeText: '自定义',
            badgeColor: '#0011ff',
            badgeTextColor: '#ffcc00',
          }}
        />
        <ClusterBadge
          cluster={{
            badgeEnabled: true,
            badgeText: '自动',
            badgeColor: '#0011ff',
          }}
        />
        <ClusterBadge
          cluster={{
            badgeEnabled: true,
            badgeText: '脏值',
            badgeColor: '#0011ff',
            badgeTextColor: 'red',
          }}
        />
      </>
    )

    expect(screen.getByTitle('自定义')).toHaveStyle({ color: '#ffcc00' })
    expect(screen.getByTitle('自动')).toHaveStyle({ color: '#ffffff' })
    expect(screen.getByTitle('脏值')).toHaveStyle({ color: '#ffffff' })
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

describe('ClusterBadge 字号与加粗', () => {
  it('未设置字号时按默认档渲染，且不加粗', () => {
    render(
      <ClusterBadge cluster={{ badgeEnabled: true, badgeText: '测试环境' }} />
    )

    const badge = screen.getByTitle('测试环境')
    expect(badge.className).toContain('text-xs')
    expect(badge.className).toContain('font-medium')
  })

  it('小 / 大两档换成不同字号，加粗开启后字重更粗', () => {
    render(
      <>
        <ClusterBadge
          cluster={{ badgeEnabled: true, badgeText: '小', badgeTextSize: 'sm' }}
        />
        <ClusterBadge
          cluster={{
            badgeEnabled: true,
            badgeText: '大',
            badgeTextSize: 'lg',
            badgeBold: true,
          }}
        />
      </>
    )

    expect(screen.getByTitle('小').className).toContain('text-[10px]')
    const large = screen.getByTitle('大')
    expect(large.className).toContain('text-sm')
    expect(large.className).toContain('font-bold')
  })

  // 自定义像素字号走内联 font-size（值已由前后端限定在 10~24 的整数）。
  it('自定义像素字号按原值渲染，越界值回落默认档', () => {
    render(
      <>
        <ClusterBadge
          cluster={{
            badgeEnabled: true,
            badgeText: '十六',
            badgeColor: '#0011ff',
            badgeTextSize: '18',
          }}
        />
        <ClusterBadge
          cluster={{
            badgeEnabled: true,
            badgeText: '越界',
            badgeColor: '#0011ff',
            badgeTextSize: '99',
          }}
        />
      </>
    )

    expect(screen.getByTitle('十六').style.fontSize).toBe('18px')
    const fallback = screen.getByTitle('越界')
    expect(fallback.style.fontSize).toBe('')
    expect(fallback.className).toContain('text-xs')
  })

  // 字号会进类名，未知值不能拼进样式：库里手工写脏了按默认档渲染。
  it('未知档位回落默认档', () => {
    render(
      <ClusterBadge
        cluster={{
          badgeEnabled: true,
          badgeText: '测试环境',
          badgeTextSize: 'xl',
        }}
      />
    )

    expect(screen.getByTitle('测试环境').className).toContain('text-xs')
  })
})

describe('ClusterBadgeIcon', () => {
  // 自定义图标默认关闭，关掉时连默认图标都不占位：顶栏、切换器、管理列表都不该
  // 凭空多出一个集群图标。
  it('图标开关关闭时不渲染任何图标', () => {
    const { container } = render(
      <ClusterBadgeIcon
        cluster={{ badgeEnabled: true, badgeText: '测试环境' }}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('图标开关开启但还没选图标时，用默认图标占位', () => {
    const { container } = render(
      <ClusterBadgeIcon cluster={{ badgeIconEnabled: true }} />
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
    expect(icon).toHaveStyle({ color: '#ffffff' })
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

  it('图标开关关闭时即使有地址也不渲染图标', () => {
    const { container } = render(
      <ClusterBadgeIcon
        cluster={{ badgeIconUrl: '/api/v1/clusters/1/badge-icon?v=abc' }}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  // 图标文本有自己的字号 / 加粗 / 底色 / 字色，直接读 badgeIcon* 字段。
  it('图标文本使用自己的字号、加粗、底色与字色', () => {
    render(
      <ClusterBadgeIcon
        cluster={{
          badgeIconEnabled: true,
          badgeIconText: '生产',
          badgeColor: '#0011ff',
          badgeIconTextSize: 'lg',
          badgeIconBold: true,
          badgeIconTextColor: '#ffcc00',
          badgeIconTextBackground: '#112233',
        }}
      />
    )

    const icon = screen.getByTitle('生产')
    expect(icon.className).toContain('text-sm')
    expect(icon.className).toContain('font-bold')
    expect(icon).toHaveStyle({ color: '#ffcc00' })
    expect(icon).toHaveStyle({ backgroundColor: '#112233' })
  })

  // 底色留空才用徽章背景色；字色留空 / 非法时按**实际**底色自动取黑/白。
  it('图标文本底色与字色留空时分别回落徽章底色与自动黑白', () => {
    render(
      <>
        <ClusterBadgeIcon
          cluster={{
            badgeIconEnabled: true,
            badgeIconText: 'A',
            badgeColor: '#0011ff',
          }}
        />
        <ClusterBadgeIcon
          cluster={{
            badgeIconEnabled: true,
            badgeIconText: 'B',
            badgeColor: '#0011ff',
            badgeIconTextColor: 'red',
          }}
        />
        {/* 浅色底要自动选黑字，否则浅底白字什么都看不见。 */}
        <ClusterBadgeIcon
          cluster={{
            badgeIconEnabled: true,
            badgeIconText: 'C',
            badgeColor: '#0011ff',
            badgeIconTextBackground: '#ffffff',
          }}
        />
      </>
    )

    expect(screen.getByTitle('A')).toHaveStyle({
      color: '#ffffff',
      backgroundColor: '#0011ff',
    })
    expect(screen.getByTitle('B')).toHaveStyle({ color: '#ffffff' })
    expect(screen.getByTitle('C')).toHaveStyle({
      color: '#000000',
      backgroundColor: '#ffffff',
    })
  })

  // 图标文本与「自定义说明」是两处独立设置：说明选了大字号 + 加粗，图标文本不跟着变。
  it('图标文本不跟随说明的字号与加粗', () => {
    render(
      <ClusterBadgeIcon
        cluster={{
          badgeIconEnabled: true,
          badgeIconText: '生产',
          badgeTextSize: 'lg',
          badgeBold: true,
        }}
      />
    )

    const icon = screen.getByTitle('生产')
    expect(icon.className).toContain('text-[9px]')
    expect(icon.className).toContain('font-medium')
    expect(icon.className).not.toContain('font-bold')
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
