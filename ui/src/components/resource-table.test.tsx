/// <reference types="@testing-library/jest-dom" />
import { createColumnHelper } from '@tanstack/react-table'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ResourceTable } from './resource-table'

// --- mock ---

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'resourceTable.confirmDeletion': 'Confirm Deletion',
        'resourceTable.confirmDeletionMessage': `Delete ${opts?.count} ${opts?.resourceName}?`,
        'resourceTable.deletingProgress': `Deleting... (${opts?.done}/${opts?.total})`,
        'resourceTable.deleteSuccess': `Deleted ${opts?.name} successfully`,
        'resourceTable.deleteFailed': `Failed to delete ${opts?.name}`,
        'common.actions.cancel': 'Cancel',
        'common.actions.delete': 'Delete',
        'resourceTable.namespace': 'Namespace',
        'resourceTable.selectAllRows': 'Select all',
        'resourceTable.selectRow': 'Select row',
      }
      return map[key] ?? key
    },
    i18n: { language: 'en' },
  }),
}))

const mockDeleteResource = vi.fn()
vi.mock('@/lib/api', () => ({
  deleteResource: (...args: unknown[]) => mockDeleteResource(...args),
  useResources: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useResourcesWatch: () => ({ data: undefined, isConnected: false }),
}))

vi.mock('@/lib/resource-catalog', () => ({
  getResourceMetadata: () => null,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/current-cluster', () => ({
  getClusterScopedStorageKey: (key: string) => key,
  getCurrentCluster: () => null,
}))

vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({ currentCluster: 'test-cluster' }),
}))

// 表格用这些 hook 控制操作入口；下面的测试只覆盖
// 删除进度，因此所有权限都授予。
vi.mock('@/hooks/use-can', () => ({
  useCan: () => () => true,
  useCanAnyNamespace: () => () => true,
}))

// fakeRows 通过 vi.hoisted 定义在工厂内部，这样当 vi.mock 被提升到
// 变量声明之前时它仍然可用
const { fakeRows } = vi.hoisted(() => {
  type Row = { metadata: { name: string; namespace?: string; uid?: string } }
  return {
    fakeRows: [
      { metadata: { name: 'svc-1', namespace: 'default', uid: 'uid-1' } },
      { metadata: { name: 'svc-2', namespace: 'default', uid: 'uid-2' } },
      { metadata: { name: 'svc-3', namespace: 'default', uid: 'uid-3' } },
    ] as Row[],
  }
})

vi.mock('@/hooks/use-resource-table-data', () => ({
  useResourceTableData: () => ({
    resourceType: 'services',
    data: fakeRows,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    isConnected: false,
  }),
}))

// --- 辅助工具 ---

type Row = { metadata: { name: string; namespace?: string; uid?: string } }

const columnHelper = createColumnHelper<Row>()
const columns = [columnHelper.accessor('metadata.name', { header: 'Name' })]

function renderTable() {
  return render(
    <ResourceTable<Row>
      resourceName="services"
      columns={columns}
      clusterScope={true}
    />
  )
}

// --- 测试 ---

describe('ResourceTable batch delete progress', () => {
  it('shows Deleting... (0/N) immediately when delete starts and promises are pending', async () => {
    let resolveAll!: () => void
    const blocker = new Promise<void>((res) => {
      resolveAll = res
    })
    mockDeleteResource.mockReturnValue(blocker)

    renderTable()
    const user = userEvent.setup()

    const selectAll = screen.getByRole('checkbox', { name: /select all/i })
    await user.click(selectAll)

    const deleteBtn = await screen.findByRole('button', { name: /delete/i })
    await user.click(deleteBtn)

    const confirmBtn = await screen.findByRole('button', { name: /^delete$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /deleting\.\.\. \(0\/3\)/i })
      ).toBeInTheDocument()
    })

    resolveAll()
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('increments the done count as individual deletions complete', async () => {
    const resolvers: Array<() => void> = []
    mockDeleteResource.mockImplementation(
      () => new Promise<void>((res) => resolvers.push(res))
    )

    renderTable()
    const user = userEvent.setup()

    const selectAll = screen.getByRole('checkbox', { name: /select all/i })
    await user.click(selectAll)

    const deleteBtn = await screen.findByRole('button', { name: /delete/i })
    await user.click(deleteBtn)

    const confirmBtn = await screen.findByRole('button', { name: /^delete$/i })
    await user.click(confirmBtn)

    resolvers[0]()
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /deleting\.\.\. \(1\/3\)/i })
      ).toBeInTheDocument()
    })

    resolvers[1]()
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /deleting\.\.\. \(2\/3\)/i })
      ).toBeInTheDocument()
    })

    resolvers[2]()
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('counts failed deletions toward the progress total', async () => {
    const resolvers: Array<{
      resolve: () => void
      reject: (e: Error) => void
    }> = []
    mockDeleteResource.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) =>
          resolvers.push({ resolve, reject })
        )
    )

    renderTable()
    const user = userEvent.setup()

    const selectAll = screen.getByRole('checkbox', { name: /select all/i })
    await user.click(selectAll)

    const deleteBtn = await screen.findByRole('button', { name: /delete/i })
    await user.click(deleteBtn)

    const confirmBtn = await screen.findByRole('button', { name: /^delete$/i })
    await user.click(confirmBtn)

    resolvers[0].reject(new Error('forbidden'))
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /deleting\.\.\. \(1\/3\)/i })
      ).toBeInTheDocument()
    })

    resolvers[1].resolve()
    resolvers[2].resolve()
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })
})
