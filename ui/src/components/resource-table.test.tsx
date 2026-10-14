/// <reference types="@testing-library/jest-dom" />
import { createColumnHelper } from '@tanstack/react-table'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
        'resourceTable.selectGroupRows': 'Select group rows',
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
const { fakeRows, tableData } = vi.hoisted(() => {
  type Row = { metadata: { name: string; namespace?: string; uid?: string } }
  const fakeRows: Row[] = [
    { metadata: { name: 'svc-1', namespace: 'default', uid: 'uid-1' } },
    { metadata: { name: 'svc-2', namespace: 'default', uid: 'uid-2' } },
    { metadata: { name: 'svc-3', namespace: 'default', uid: 'uid-3' } },
  ]
  return {
  fakeRows,
  // 可变的数据源：分组测试会替换成自己的行
  tableData: { rows: fakeRows as Row[] },
  }
})

vi.mock('@/hooks/use-resource-table-data', () => ({
  useResourceTableData: () => {
    return {
      resourceType: 'services',
      data: tableData.rows,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isConnected: false,
    }
  },
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

describe('ResourceTable grouping', () => {
  const groupedRows = [
    { metadata: { name: 'ns-apisix', uid: 'g-1' } },
    { metadata: { name: 'ns-loki', uid: 'g-2' } },
    { metadata: { name: 'kube-system', uid: 'g-3' } },
  ]

  const groupingColumns = [
    columnHelper.accessor('metadata.name', { header: 'Name' }),
    columnHelper.accessor(
      (row: Row) => (row.metadata.name === 'kube-system' ? '' : 'press'),
      { id: 'bindingGroup', header: 'Binding Group' }
    ),
  ]

  beforeEach(() => {
    tableData.rows = groupedRows
  })

  afterEach(() => {
    tableData.rows = fakeRows
  })

  function renderGroupedTable() {
    return render(
      <ResourceTable<Row>
        resourceName="services"
        columns={groupingColumns}
        clusterScope={true}
        grouping={{
          columnId: 'bindingGroup',
          renderGroupHeader: (value, count) =>
            `${value || 'Unbound'} (${count})`,
        }}
      />
    )
  }

  it('renders a full-width group header row before each group', () => {
    renderGroupedTable()

    // 组标题行：绑定值相同的资源归入同一组，未绑定（空值）单独一组
    expect(screen.getByText('press (2)')).toBeInTheDocument()
    expect(screen.getByText('Unbound (1)')).toBeInTheDocument()
    // 组内资源行正常渲染
    expect(screen.getByText('ns-apisix')).toBeInTheDocument()
    expect(screen.getByText('ns-loki')).toBeInTheDocument()
    expect(screen.getByText('kube-system')).toBeInTheDocument()
  })

  it('re-groups when the grouping accessor resolves different values', () => {
    // 模拟 /namespaces 页：绑定组映射是异步加载的，accessor 用闭包捕获它。
    // 映射到位后 data 引用不变、只有 columns 引用变化，若分组 row model 不
    // 随之重算，组标题会停留在「全部未绑定」的旧值上。
    const bindingOf = new Map<string, string>()
    const makeColumns = () => [
      columnHelper.accessor('metadata.name', { header: 'Name' }),
      columnHelper.accessor(
        (row) => bindingOf.get(row.metadata.name) ?? '',
        { id: 'bindingGroup', header: 'Binding Group' }
      ),
    ]
    const view = render(
      <ResourceTable<Row>
        resourceName="services"
        columns={makeColumns()}
        clusterScope={true}
        grouping={{
          columnId: 'bindingGroup',
          renderGroupHeader: (value, count) => `${value || 'Unbound'} (${count})`,
        }}
      />
    )

    // 映射尚未加载完成：所有资源都归入「未绑定」
    expect(screen.getByText('Unbound (3)')).toBeInTheDocument()

    // 映射加载完成，columns 引用随闭包一起重建
    bindingOf.set('ns-apisix', 'press')
    bindingOf.set('ns-loki', 'press')
    view.rerender(
      <ResourceTable<Row>
        resourceName="services"
        columns={makeColumns()}
        clusterScope={true}
        grouping={{
          columnId: 'bindingGroup',
          renderGroupHeader: (value, count) => `${value || 'Unbound'} (${count})`,
        }}
      />
    )

    expect(screen.getByText('press (2)')).toBeInTheDocument()
    expect(screen.getByText('Unbound (1)')).toBeInTheDocument()
  })

  // 回归：分组列的 accessor 闭包捕获异步数据（如 /namespaces 的权限绑定
  // 映射）时，映射到位只会让 columns 引用变化、data 引用不变，TanStack
  // 的分组 row model 不感知列定义变化、不会重算，分组会停留在旧值。
  // data 必须随 columns 一起失效，强制用新取值函数重新分组。
  it('regroups when the grouping column accessor starts returning values', () => {
    const columnsBefore = [
      columnHelper.accessor('metadata.name', { header: 'Name' }),
      // 绑定映射尚未加载：所有行都是「未绑定」
      columnHelper.accessor(() => '', {
        id: 'bindingGroup',
        header: 'Binding Group',
      }),
    ]
    const columnsAfter = [
      columnHelper.accessor('metadata.name', { header: 'Name' }),
      // 映射到达：只有 ns-apisix 归入 grp
      columnHelper.accessor((row: Row) =>
        row.metadata.name === 'ns-apisix' ? 'grp' : ''
      , {
        id: 'bindingGroup',
        header: 'Binding Group',
      }),
    ]
    const grouping = {
      columnId: 'bindingGroup',
      renderGroupHeader: (value: string, count: number) =>
        `${value || 'Unbound'} (${count})`,
    }

    const { rerender } = render(
      <ResourceTable<Row>
        resourceName="services"
        columns={columnsBefore}
        clusterScope={true}
        grouping={grouping}
      />
    )
    expect(screen.getByText('Unbound (3)')).toBeInTheDocument()

    rerender(
      <ResourceTable<Row>
        resourceName="services"
        columns={columnsAfter}
        clusterScope={true}
        grouping={grouping}
      />
    )
    expect(screen.getByText('grp (1)')).toBeInTheDocument()
    expect(screen.getByText('Unbound (2)')).toBeInTheDocument()
  })

  it('select-all only counts resource rows, not group header rows', async () => {
    renderGroupedTable()
    const user = userEvent.setup()

    await user.click(screen.getByRole('checkbox', { name: /select all/i }))
    await user.click(screen.getByRole('button', { name: /delete/i }))

    // 3 个资源行被选中，组标题行不参与勾选（否则会数出 5 行）
    expect(
      await screen.findByText('Delete 3 services?')
    ).toBeInTheDocument()
  })

  // 回归：v8 会把分组列强制排到列首，勾选列被挤到第二位。分组模式下
  // 勾选列必须钉在最前，表头与数据行的第一个单元格都是复选框。
  it('keeps the select column first in grouped mode', () => {
    renderGroupedTable()

    const headers = screen.getAllByRole('columnheader')
    expect(
      within(headers[0]).getByRole('checkbox', { name: /select all/i })
    ).toBeInTheDocument()
  })

  it('group header checkbox selects only the rows of that group', async () => {
    renderGroupedTable()
    const user = userEvent.setup()

    // 第一组是 press（ns-apisix、ns-loki），勾选组标题行只选中组内两行
    const groupCheckbox = screen.getAllByRole('checkbox', {
      name: /select group rows/i,
    })[0]
    await user.click(groupCheckbox)
    await user.click(screen.getByRole('button', { name: /delete/i }))

    expect(await screen.findByText('Delete 2 services?')).toBeInTheDocument()
  })
})
