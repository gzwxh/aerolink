import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ResourceDeleteConfirmationDialog } from './resource-delete-confirmation-dialog'

// 失败反馈口径（见 docs/dev/plans/2026-09-21-站内信收件人与失败反馈.md）：
// 请求失败不再写站内信，必须当场弹给操作者。这个组件是代表性的一处——它的 catch 里
// 还有「资源已不存在 → 回列表」的专门分支，两种路径的反馈不能互相覆盖。
const deleteResource = vi.hoisted(() => vi.fn())
const navigate = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
const toastWarning = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ deleteResource }))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  // 集群包装导航（cluster-path）会读路由参数；这些用例不关心集群段，给空即可。
  useParams: () => ({}),
  useLocation: () => ({ pathname: '/', search: '', hash: '', key: 'test' }),
}))
vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess, warning: toastWarning },
}))
// 组件只用 t(key, defaultValue)，直接回 defaultValue（与其他组件测试同一套写法）；
// 带插值参数的调用返回 key + 参数 JSON，便于断言插值内容。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: unknown) =>
      typeof defaultValue === 'string'
        ? defaultValue
        : defaultValue !== undefined
          ? `${key}:${JSON.stringify(defaultValue)}`
          : key,
  }),
}))

function renderDialog(relatedServices?: string[]) {
  return render(
    <ResourceDeleteConfirmationDialog
      open
      onOpenChange={() => undefined}
      resourceName="demo"
      resourceType="deployments"
      namespace="default"
      relatedServices={relatedServices}
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

describe('ResourceDeleteConfirmationDialog 的关联 Service 联动删除', () => {
  it('主体删除成功后逐个删除关联 Service', async () => {
    deleteResource.mockResolvedValue(undefined)
    renderDialog(['nginx-nodeport', 'nginx-clusterip'])

    await confirmDelete()

    await waitFor(() => {
      expect(deleteResource).toHaveBeenCalledWith(
        'services',
        'nginx-nodeport',
        'default'
      )
    })
    expect(deleteResource).toHaveBeenCalledWith(
      'services',
      'nginx-clusterip',
      'default'
    )
    expect(toastSuccess).toHaveBeenCalled()
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('部分 Service 删除失败时弹警告（404 视为已删除，不算失败）', async () => {
    deleteResource.mockImplementation((_type: string, name: string) =>
      name === 'nginx-nodeport'
        ? Promise.reject(new Error('services "nginx-nodeport" not found'))
        : name === 'nginx-clusterip'
          ? Promise.reject(new Error('internal error'))
          : Promise.resolve(undefined)
    )
    renderDialog(['nginx-nodeport', 'nginx-clusterip'])

    await confirmDelete()

    await waitFor(() => {
      expect(toastWarning).toHaveBeenCalledWith(
        expect.stringContaining('nginx-clusterip')
      )
    })
    // 404 的那个不算失败，不该出现在警告里。
    expect(toastWarning).toHaveBeenCalledWith(
      expect.not.stringContaining('nginx-nodeport')
    )
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('主体删除失败时不联动删 Service', async () => {
    deleteResource.mockRejectedValueOnce(new Error('boom'))
    renderDialog(['nginx-nodeport'])

    await confirmDelete()

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('boom')
    })
    expect(deleteResource).toHaveBeenCalledTimes(1)
    expect(deleteResource).not.toHaveBeenCalledWith(
      'services',
      'nginx-nodeport',
      expect.anything(),
      expect.anything()
    )
  })
})
