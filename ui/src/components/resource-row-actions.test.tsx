/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ResourceRowActions,
  type RowActionResourceType,
} from './resource-row-actions'

const { navigate, can } = vi.hoisted(() => ({
  navigate: vi.fn(),
  can: vi.fn(),
}))

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('@/hooks/use-can', () => ({ useCan: () => can }))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({
  deleteResource: vi.fn(),
  patchResource: vi.fn(),
  restartWorkload: vi.fn(),
  updateResource: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// 这几个子组件与本次改动无关，且 YamlEditor 会拉起 Monaco（jsdom 里跑不起来）。
vi.mock('@/components/yaml-editor', () => ({ YamlEditor: () => null }))
vi.mock('@/components/kv-editor', () => ({ KVEditor: () => null }))
vi.mock('@/components/delete-confirmation-dialog', () => ({
  DeleteConfirmationDialog: () => null,
}))
vi.mock('@/components/workload-revisions-table', () => ({
  WorkloadRevisionsTable: () => null,
}))
vi.mock('@/components/unsaved-changes-confirm-dialog', () => ({
  UnsavedChangesConfirmDialog: () => null,
}))

// 用标记串替掉真实文案：断言不依赖语言包的具体措辞。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'common.fields.actions': 'ACTIONS',
        'common.actions.edit': 'EDIT',
        'common.actions.delete': 'DELETE',
        'common.tabs.terminal': 'TERMINAL',
        'resourceActions.viewYaml': 'VIEW_YAML',
        'resourceActions.editImage': 'EDIT_IMAGE',
        'resourceActions.pause': 'PAUSE',
        'resourceActions.resume': 'RESUME',
        'resourceActions.rollingRestart': 'RESTART',
        'resourceActions.manageLabels': 'LABELS',
        'resourceActions.manageAnnotations': 'ANNOTATIONS',
        'workloads.actions.rollback': 'ROLLBACK',
      }
      return map[key] ?? fallback ?? key
    },
  }),
}))

const workload = { metadata: { namespace: 'default', name: 'web' } }

async function openMenu(resourceType: RowActionResourceType) {
  render(
    <ResourceRowActions
      resourceType={resourceType}
      // 各类型的真实对象结构不同，菜单只读 metadata 与 spec 里的少量字段。
      resource={workload as never}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'ACTIONS' }))
}

beforeEach(() => {
  navigate.mockReset()
  can.mockReset()
  // 默认给全权限，单个用例再按需收窄。
  can.mockReturnValue(true)
})

describe('资源行操作菜单', () => {
  const allTypes: RowActionResourceType[] = [
    'deployments',
    'statefulsets',
    'daemonsets',
    'jobs',
    'cronjobs',
    'pods',
    'services',
  ]

  // 编辑入口是核心诉求：这些类型的详情页都有编辑路由，
  // 列表里的菜单必须能直达，而不是只能点进详情页再找。
  it.each(allTypes)(
    '%s 的菜单里有「编辑」并跳到编辑页',
    async (resourceType) => {
      await openMenu(resourceType)

      const edit = await screen.findByRole('menuitem', { name: 'EDIT' })
      expect(edit).toBeInTheDocument()

      const user = userEvent.setup()
      await user.click(edit)
      expect(navigate).toHaveBeenCalledWith(`/${resourceType}/default/web/edit`)
    }
  )

  it('Deployment 保留暂停、滚动重启与回滚', async () => {
    await openMenu('deployments')

    for (const label of [
      'PAUSE',
      'RESTART',
      'ROLLBACK',
      'EDIT_IMAGE',
      'TERMINAL',
    ]) {
      expect(
        await screen.findByRole('menuitem', { name: label })
      ).toBeInTheDocument()
    }
  })

  // Job 的 spec.template 创建后不可变，也不能滚动重启或回滚到历史版本。
  it('Job 不提供改镜像、滚动重启与回滚', async () => {
    await openMenu('jobs')

    expect(
      await screen.findByRole('menuitem', { name: 'EDIT' })
    ).toBeInTheDocument()
    for (const label of ['EDIT_IMAGE', 'RESTART', 'ROLLBACK', 'PAUSE']) {
      expect(screen.queryByRole('menuitem', { name: label })).toBeNull()
    }
    // Job 自己的 Pod 可以进终端。
    expect(
      screen.getByRole('menuitem', { name: 'TERMINAL' })
    ).toBeInTheDocument()
  })

  // CronJob 不直接拥有 Pod，容器在 jobTemplate 里，因此没有终端。
  it('CronJob 没有终端，但可以改镜像', async () => {
    await openMenu('cronjobs')

    expect(
      await screen.findByRole('menuitem', { name: 'EDIT_IMAGE' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'TERMINAL' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'RESTART' })).toBeNull()
  })

  it('Pod 可以改镜像但没有滚动重启', async () => {
    await openMenu('pods')

    expect(
      await screen.findByRole('menuitem', { name: 'EDIT_IMAGE' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'RESTART' })).toBeNull()
  })

  // Service 没有容器/历史版本：只有元数据与编辑，不能把工作负载那几项显示出来。
  it('Service 只保留编辑、YAML、标签注解与删除', async () => {
    await openMenu('services')

    for (const label of [
      'EDIT',
      'VIEW_YAML',
      'LABELS',
      'ANNOTATIONS',
      'DELETE',
    ]) {
      expect(
        await screen.findByRole('menuitem', { name: label })
      ).toBeInTheDocument()
    }
    for (const label of [
      'TERMINAL',
      'EDIT_IMAGE',
      'RESTART',
      'ROLLBACK',
      'PAUSE',
    ]) {
      expect(screen.queryByRole('menuitem', { name: label })).toBeNull()
    }
  })

  it('没有 update 权限时不显示「编辑」与标签/注解', async () => {
    can.mockImplementation((_resource: string, verb: string) => verb === 'get')

    await openMenu('deployments')

    expect(
      await screen.findByRole('menuitem', { name: 'VIEW_YAML' })
    ).toBeInTheDocument()
    for (const label of ['EDIT', 'LABELS', 'ANNOTATIONS', 'RESTART']) {
      expect(screen.queryByRole('menuitem', { name: label })).toBeNull()
    }
  })

  it('没有任何相关权限时整列不渲染', () => {
    can.mockReturnValue(false)

    const { container } = render(
      <ResourceRowActions
        resourceType="deployments"
        resource={workload as never}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
