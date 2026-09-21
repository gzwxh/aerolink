import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ResourceDeleteConfirmationDialog } from './resource-delete-confirmation-dialog'

// 失败反馈口径（见 docs/dev/plans/2026-09-21-notification-recipient-and-failure-feedback.md）：
// 请求失败不再写站内信，必须当场弹给操作者。这个组件是代表性的一处——它的 catch 里
// 还有「资源已不存在 → 回列表」的专门分支，两种路径的反馈不能互相覆盖。
const deleteResource = vi.hoisted(() => vi.fn())
const navigate = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ deleteResource }))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess },
}))
// 组件只用 t(key, defaultValue)，直接回 defaultValue（与其他组件测试同一套写法）。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: unknown) =>
      typeof defaultValue === 'string' ? defaultValue : key,
  }),
}))

function renderDialog() {
  return render(
    <ResourceDeleteConfirmationDialog
      open
      onOpenChange={() => undefined}
      resourceName="demo"
      resourceType="deployments"
      namespace="default"
    />
  )
}

async function confirmDelete() {
  // 该确认框要求先把资源名敲进去（"type to confirm"）。
  fireEvent.change(screen.getByLabelText(/demo/), { target: { value: 'demo' } })
  // 点击后会发起请求并在 then/finally 里改 state，包一层 act 免得测试日志里出现告警。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /删除|Delete/i }))
  })
}

describe('ResourceDeleteConfirmationDialog 的失败反馈', () => {
  it('删除失败时弹错误提示', async () => {
    deleteResource.mockRejectedValueOnce(new Error('boom'))
    renderDialog()

    await confirmDelete()

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('boom')
    })
  })

  it('资源已不存在时回列表页，不弹「删除失败」', async () => {
    deleteResource.mockRejectedValueOnce(
      new Error('deployments "demo" not found')
    )
    renderDialog()

    await confirmDelete()

    await waitFor(() => {
      expect(navigate).toHaveBeenCalled()
    })
    expect(toastError).not.toHaveBeenCalled()
  })
})
