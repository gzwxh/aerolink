/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ResourceOverview } from './resource-overview'

// 回归（验收台账 D-175）：通用详情页要把状态条件呈现出来，
// 否则 Gateway API / cert-manager 的健康信号只能在 YAML 里找。

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api', () => ({
  useResourcesEvents: () => ({ data: [], isLoading: false }),
  useRelatedResources: () => ({ data: [], isLoading: false }),
}))

function renderOverview(resource: unknown) {
  return render(
    <ResourceOverview
      resourceType={'certificates' as never}
      name="web-cert"
      namespace="ui-smoke"
      metadata={{ name: 'web-cert' }}
      resource={resource}
    />
  )
}

describe('ResourceOverview 的状态条件', () => {
  it('有 status.conditions 时列出类型、状态与原因', () => {
    renderOverview({
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'FailedIssue',
            message: 'issuer not ready',
          },
        ],
      },
    })

    expect(screen.getByText('common.fields.conditions')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('False')).toBeInTheDocument()
    // reason 与 message 拼在同一条说明里，排查时不用再翻 YAML
    expect(screen.getByText(/FailedIssue/)).toHaveTextContent(
      'issuer not ready'
    )
  })

  it('路由的 parent 条件带上是哪个网关给的', () => {
    renderOverview({
      status: {
        parents: [
          {
            parentName: 'ui-smoke/ui-r22-gw',
            conditions: [{ type: 'Accepted', status: 'True' }],
          },
        ],
      },
    })

    expect(screen.getByText('ui-smoke/ui-r22-gw')).toBeInTheDocument()
    expect(screen.getByText('Accepted')).toBeInTheDocument()
  })

  it('没有条件时不出现这个卡片（不给纯 YAML 类资源添空区块）', () => {
    renderOverview({ status: { data: { k: 'v' } } })

    expect(
      screen.queryByText('common.fields.conditions')
    ).not.toBeInTheDocument()
  })
})
