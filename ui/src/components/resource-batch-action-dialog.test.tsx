/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ResourceBatchActionDialog } from './resource-batch-action-dialog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// 用标记串替掉真实文案：断言不依赖语言包措辞。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      const map: Record<string, string> = {
        'resourceTable.batchActions.resourcesLabel': 'RESOURCES_LABEL',
      }
      if (map[key]) return map[key]
      if (typeof options === 'string') return options
      if (options && typeof options === 'object') {
        const fallback = (options as { defaultValue?: unknown }).defaultValue
        if (typeof fallback === 'string') return fallback
      }
      return key
    },
  }),
}))

const renderDialog = (
  resources: Array<{ metadata?: { name?: string; namespace?: string } }>
) =>
  render(
    <ResourceBatchActionDialog
      open
      onOpenChange={() => {}}
      resources={resources}
      title="TITLE"
      description="DESCRIPTION"
      actionLabel="ACTION"
      onExecute={async () => {}}
    />
  )

describe('ResourceBatchActionDialog', () => {
  // 只写「1 个 Deployments」看不出动的是哪一个，操作前后都难以核对。
  it('列出将要操作的资源名（带命名空间）', () => {
    renderDialog([
      { metadata: { name: 'nginx', namespace: 'default' } },
      { metadata: { name: 'api', namespace: 'prod' } },
    ])

    expect(screen.getByText('RESOURCES_LABEL')).toBeInTheDocument()
    expect(screen.getByText('default/nginx')).toBeInTheDocument()
    expect(screen.getByText('prod/api')).toBeInTheDocument()
  })

  it('集群级资源（没有命名空间）只显示名字', () => {
    renderDialog([{ metadata: { name: 'node-1' } }])

    expect(screen.getByText('node-1')).toBeInTheDocument()
  })
})
