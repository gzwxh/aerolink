/// <reference types="@testing-library/jest-dom" />
import type { ColumnDef } from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ActionTable } from './action-table'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

interface Row {
  name: string
  description: string
}

const columns: ColumnDef<Row>[] = [
  {
    id: 'name',
    header: 'Name',
    accessorFn: (row) => row.name,
    cell: ({ row }) => <span>{row.original.name}</span>,
  },
  {
    id: 'description',
    header: 'Description',
    accessorFn: (row) => row.description,
    cell: ({ row }) => <span>{row.original.description}</span>,
  },
]

const data: Row[] = [{ name: 'local-template', description: '集群默认模板' }]

function renderTable(hasActions = false) {
  return render(
    <ActionTable<Row>
      data={data}
      columns={columns}
      actions={hasActions ? [{ label: 'edit', onClick: vi.fn() }] : []}
    />
  )
}

describe('ActionTable', () => {
  // 回归：第一列（名称）没写 size 时走 defaultColumn 的 160px，和其它列一样宽，
  // 长名称必然被截断。现在统一给第一数据列补一个更宽的默认值。
  it('gives the first data column a wider default than the other columns', () => {
    renderTable()

    const headers = screen.getAllByRole('columnheader')
    const widthOf = (index: number) =>
      Number(/[\d.]+/.exec(headers[index].style.width)?.[0])

    expect(widthOf(0)).toBeGreaterThan(widthOf(1))
  })

  // 回归：单元格原语与名称列内部普遍带 truncate（nowrap + 省略号），第一列
  // 内容会被截断；现在改回自动换行，超长名称折行而不是被截掉。
  it('lets the first data column wrap instead of truncating', () => {
    renderTable()

    const nameCell = screen.getByText('local-template').closest('td')
    expect(nameCell?.className).toContain('whitespace-normal')
    expect(nameCell?.className).toContain('break-all')
  })

  // 列宽拖拽手柄每列一个，操作列宽度固定、不提供手柄。
  it('offers a resize handle on every column except the action column', () => {
    renderTable(true)

    expect(screen.getAllByRole('separator')).toHaveLength(columns.length)
  })
})
