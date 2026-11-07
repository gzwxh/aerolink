/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  requestWriteConfirm,
  resetWriteConfirmForTest,
  type WriteConfirmRequest,
} from '@/lib/write-confirm'

import { WriteConfirmDialog } from './write-confirm-dialog'

// 用标记串替掉真实文案：断言不依赖语言包措辞。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'writeConfirm.title': 'CONFIRM_TITLE',
        'writeConfirm.description': 'CONFIRM_DESCRIPTION',
        'writeConfirm.confirm': 'CONFIRM_BUTTON',
        'writeConfirm.fields.cluster': 'FIELD_CLUSTER',
        'writeConfirm.fields.operation': 'FIELD_OPERATION',
        'writeConfirm.fields.target': 'FIELD_TARGET',
        'writeConfirm.bulkHint': 'BULK_HINT',
        'writeConfirm.kinds.delete': 'KIND_DELETE',
        'common.actions.cancel': 'CANCEL_BUTTON',
      }
      return map[key] ?? fallback ?? key
    },
  }),
}))

const deleteRequest: WriteConfirmRequest = {
  cluster: 'dev',
  kind: 'delete',
  method: 'DELETE',
  target: { resource: 'deployments', namespace: 'default', name: 'nginx' },
}

describe('WriteConfirmDialog', () => {
  beforeEach(() => {
    resetWriteConfirmForTest()
  })

  it('收到确认请求时展示集群 / 操作 / 对象', async () => {
    render(<WriteConfirmDialog />)

    act(() => {
      requestWriteConfirm(deleteRequest)
    })

    expect(await screen.findByText('CONFIRM_TITLE')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.getByText('KIND_DELETE')).toBeInTheDocument()
    expect(screen.getByText('deployments/nginx · default')).toBeInTheDocument()
  })

  it('点确认 → resolve 为 true（请求照常发出）', async () => {
    render(<WriteConfirmDialog />)

    let pending!: Promise<boolean>
    act(() => {
      pending = requestWriteConfirm(deleteRequest)
    })
    await screen.findByText('CONFIRM_TITLE')
    fireEvent.click(screen.getByText('CONFIRM_BUTTON'))

    await expect(pending).resolves.toBe(true)
  })

  it('点取消 → resolve 为 false（请求不发出）', async () => {
    render(<WriteConfirmDialog />)

    let pending!: Promise<boolean>
    act(() => {
      pending = requestWriteConfirm(deleteRequest)
    })
    await screen.findByText('CONFIRM_TITLE')
    fireEvent.click(screen.getByText('CANCEL_BUTTON'))

    await expect(pending).resolves.toBe(false)
  })

  it('确认后弹窗关闭', async () => {
    render(<WriteConfirmDialog />)

    let pending!: Promise<boolean>
    act(() => {
      pending = requestWriteConfirm(deleteRequest)
    })
    await screen.findByText('CONFIRM_TITLE')
    fireEvent.click(screen.getByText('CONFIRM_BUTTON'))
    await pending

    await waitFor(() =>
      expect(screen.queryByText('CONFIRM_TITLE')).not.toBeInTheDocument()
    )
  })

  it('单个请求不提示批量', async () => {
    render(<WriteConfirmDialog />)

    act(() => {
      requestWriteConfirm(deleteRequest)
    })
    await screen.findByText('CONFIRM_TITLE')

    expect(screen.queryByText('BULK_HINT')).not.toBeInTheDocument()
  })

  it('批量同类请求只弹一次确认，确认后全部放行', async () => {
    render(<WriteConfirmDialog />)

    let waiting!: Promise<boolean>[]
    act(() => {
      waiting = ['a', 'b', 'c'].map((name) =>
        requestWriteConfirm({
          ...deleteRequest,
          target: { ...deleteRequest.target, name },
        })
      )
    })
    await screen.findByText('CONFIRM_TITLE')
    expect(screen.getByText('BULK_HINT')).toBeInTheDocument()

    fireEvent.click(screen.getByText('CONFIRM_BUTTON'))

    await expect(Promise.all(waiting)).resolves.toEqual([true, true, true])
    await waitFor(() =>
      expect(screen.queryByText('CONFIRM_TITLE')).not.toBeInTheDocument()
    )
  })
})
