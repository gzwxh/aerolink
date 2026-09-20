/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import type { RelatedResources } from '@/types/api'

import { CompactRelatedResourcesCard } from './pod-overview-sidebar'

// 卡片本身只消费传入的 resources，这里挡掉 api 模块避免拉起真实请求层。
vi.mock('@/lib/api', () => ({
  useRelatedResources: () => ({ data: [], isLoading: false }),
}))
// 只替换 useTranslation（直接回显 key），保留真实模块的其它导出，
// 否则 i18n 初始化里的 initReactI18next 会拿不到。
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const service: RelatedResources = {
  type: 'services',
  name: 'kite',
  namespace: 'kite',
}

function renderCard(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <CompactRelatedResourcesCard resources={[service]} isLoading={false} />
    </MemoryRouter>
  )
}

describe('CompactRelatedResourcesCard', () => {
  it('点击相关资源直接跳转到该资源的详情页，而不是内嵌弹窗', () => {
    renderCard()

    const link = screen.getByText('kite').closest('a')
    expect(link).toHaveAttribute('href', '/services/kite/kite')
    // 旧的弹窗触发按钮不应再出现
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('iframe 视图下保留 iframe 参数', () => {
    renderCard('/?iframe=true')

    expect(screen.getByText('kite').closest('a')).toHaveAttribute(
      'href',
      '/services/kite/kite?iframe=true'
    )
  })
})
