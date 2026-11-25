import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SidebarConfigProvider,
  useSidebarConfig,
} from './sidebar-config-context'

const { mockUseAuth } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
}))

vi.mock('./auth-context', () => ({
  useAuth: mockUseAuth,
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const workloadsGroupId = 'sidebar-groups-workloads'
const applicationGroupId = 'sidebar-groups-application'
const trafficGroupId = 'sidebar-groups-traffic'
const workloadsPodsItemId = 'sidebar-groups-workloads--pods'
const otherGroupId = 'sidebar-groups-other'
const customGroupId = 'custom-my-group'
const customGroupItemId = 'custom-my-group--custom-resource:widgets.example.com'

function SidebarConfigConsumer() {
  const {
    config,
    isLoading,
    toggleItemVisibility,
    toggleItemPin,
    toggleGroupVisibility,
    toggleGroupCollapse,
    createCustomGroup,
    addCRDToGroup,
    removeItemFromGroup,
    removeCustomGroup,
    moveGroup,
    movePinnedItem,
  } = useSidebarConfig()

  if (isLoading || !config) {
    return <div data-testid="loading">loading</div>
  }

  const sortedGroups = [...config.groups].sort((a, b) => a.order - b.order)
  const workloadsGroup = config.groups.find(
    (group) => group.id === workloadsGroupId
  )
  const customGroup = config.groups.find((group) => group.id === customGroupId)
  const otherGroup = config.groups.find((group) => group.id === otherGroupId)

  return (
    <div>
      <div data-testid="group-order">
        {sortedGroups.map((group) => group.id).join(',')}
      </div>
      <div data-testid="hidden-items">{config.hiddenItems.join(',')}</div>
      <div data-testid="pinned-items">{config.pinnedItems.join(',')}</div>
      <div data-testid="workloads-visible">
        {String(workloadsGroup?.visible)}
      </div>
      <div data-testid="workloads-collapsed">
        {String(workloadsGroup?.collapsed)}
      </div>
      <div data-testid="custom-groups">
        {config.groups
          .filter((group) => group.isCustom)
          .map((group) => group.id)
          .join(',')}
      </div>
      <div data-testid="custom-items">
        {customGroup?.items.map((item) => item.id).join(',') ?? ''}
      </div>
      <div data-testid="other-items">
        {otherGroup?.items.map((item) => item.id).join(',') ?? ''}
      </div>

      <button type="button" onClick={() => toggleItemPin(workloadsPodsItemId)}>
        toggle default pin
      </button>
      <button
        type="button"
        onClick={() => toggleItemVisibility(workloadsPodsItemId)}
      >
        toggle default visibility
      </button>
      <button
        type="button"
        onClick={() => toggleGroupVisibility(workloadsGroupId)}
      >
        toggle workloads visibility
      </button>
      <button
        type="button"
        onClick={() => toggleGroupCollapse(workloadsGroupId)}
      >
        toggle workloads collapse
      </button>
      <button type="button" onClick={() => moveGroup(workloadsGroupId, 'up')}>
        move workloads up
      </button>
      <button type="button" onClick={() => moveGroup(workloadsGroupId, 'down')}>
        move workloads down
      </button>
      <button type="button" onClick={() => moveGroup(trafficGroupId, 'up')}>
        move traffic up
      </button>
      <button type="button" onClick={() => createCustomGroup('My Group')}>
        create custom group
      </button>
      <button
        type="button"
        onClick={() =>
          addCRDToGroup(customGroupId, 'widgets.example.com', 'Widget')
        }
      >
        add custom item
      </button>
      <button type="button" onClick={() => toggleItemPin(customGroupItemId)}>
        toggle custom pin
      </button>
      <button
        type="button"
        onClick={() => toggleItemVisibility(customGroupItemId)}
      >
        toggle custom visibility
      </button>
      <button
        type="button"
        onClick={() => removeItemFromGroup(customGroupId, customGroupItemId)}
      >
        remove custom item
      </button>
      <button type="button" onClick={() => removeCustomGroup(customGroupId)}>
        remove custom group
      </button>
      <button
        type="button"
        onClick={() => movePinnedItem(customGroupItemId, 0)}
      >
        move custom pin to top
      </button>
    </div>
  )
}

async function renderProvider() {
  render(
    <SidebarConfigProvider>
      <SidebarConfigConsumer />
    </SidebarConfigProvider>
  )

  await waitFor(() =>
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument()
  )
}

describe('SidebarConfigProvider', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: null })
  })

  it('toggles default item pinning and visibility', async () => {
    await renderProvider()

    fireEvent.click(screen.getByRole('button', { name: 'toggle default pin' }))
    await waitFor(() =>
      expect(screen.getByTestId('pinned-items')).toHaveTextContent(
        workloadsPodsItemId
      )
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'toggle default visibility' })
    )
    await waitFor(() =>
      expect(screen.getByTestId('hidden-items')).toHaveTextContent(
        workloadsPodsItemId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'toggle default pin' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'toggle default visibility' })
    )

    await waitFor(() => {
      expect(screen.getByTestId('pinned-items')).toBeEmptyDOMElement()
      expect(screen.getByTestId('hidden-items')).not.toHaveTextContent(
        workloadsPodsItemId
      )
    })
  })

  it('toggles group visibility and collapsed state', async () => {
    await renderProvider()

    fireEvent.click(
      screen.getByRole('button', { name: 'toggle workloads visibility' })
    )
    await waitFor(() =>
      expect(screen.getByTestId('workloads-visible')).toHaveTextContent('false')
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'toggle workloads collapse' })
    )
    await waitFor(() =>
      expect(screen.getByTestId('workloads-collapsed')).toHaveTextContent(
        'true'
      )
    )
  })

  it('reorders groups and ignores invalid boundary moves', async () => {
    await renderProvider()

    expect(screen.getByTestId('group-order')).toHaveTextContent(
      [
        'sidebar-groups-cluster',
        workloadsGroupId,
        trafficGroupId,
        'sidebar-groups-storage',
        'sidebar-groups-config',
        'sidebar-groups-infrastructure',
        'sidebar-groups-security',
        'sidebar-groups-certmanager',
        'sidebar-groups-other',
        applicationGroupId,
      ].join(',')
    )

    fireEvent.click(screen.getByRole('button', { name: 'move workloads up' }))
    await waitFor(() =>
      expect(screen.getByTestId('group-order')).toHaveTextContent(
        [
          workloadsGroupId,
          'sidebar-groups-cluster',
          trafficGroupId,
          'sidebar-groups-storage',
          'sidebar-groups-config',
          'sidebar-groups-infrastructure',
          'sidebar-groups-security',
          'sidebar-groups-certmanager',
          'sidebar-groups-other',
          applicationGroupId,
        ].join(',')
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'move workloads down' }))
    await waitFor(() =>
      expect(screen.getByTestId('group-order')).toHaveTextContent(
        [
          'sidebar-groups-cluster',
          workloadsGroupId,
          trafficGroupId,
          'sidebar-groups-storage',
          'sidebar-groups-config',
          'sidebar-groups-infrastructure',
          'sidebar-groups-security',
          'sidebar-groups-certmanager',
          'sidebar-groups-other',
          applicationGroupId,
        ].join(',')
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'move traffic up' }))
    await waitFor(() =>
      expect(screen.getByTestId('group-order')).toHaveTextContent(
        [
          'sidebar-groups-cluster',
          trafficGroupId,
          workloadsGroupId,
          'sidebar-groups-storage',
          'sidebar-groups-config',
          'sidebar-groups-infrastructure',
          'sidebar-groups-security',
          'sidebar-groups-certmanager',
          'sidebar-groups-other',
          applicationGroupId,
        ].join(',')
      )
    )
  })

  it('creates a custom group and manages CRD items inside it', async () => {
    await renderProvider()

    fireEvent.click(screen.getByRole('button', { name: 'create custom group' }))
    await waitFor(() =>
      expect(screen.getByTestId('custom-groups')).toHaveTextContent(
        customGroupId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'add custom item' }))
    await waitFor(() =>
      expect(screen.getByTestId('custom-items')).toHaveTextContent(
        customGroupItemId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'toggle custom pin' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'toggle custom visibility' })
    )

    await waitFor(() => {
      expect(screen.getByTestId('pinned-items')).toHaveTextContent(
        customGroupItemId
      )
      expect(screen.getByTestId('hidden-items')).toHaveTextContent(
        customGroupItemId
      )
    })

    fireEvent.click(screen.getByRole('button', { name: 'remove custom item' }))
    await waitFor(() => {
      expect(screen.getByTestId('custom-items')).toBeEmptyDOMElement()
      expect(screen.getByTestId('pinned-items')).not.toHaveTextContent(
        customGroupItemId
      )
      expect(screen.getByTestId('hidden-items')).not.toHaveTextContent(
        customGroupItemId
      )
    })
  })

  it('moves a pinned item to the requested index', async () => {
    await renderProvider()

    fireEvent.click(screen.getByRole('button', { name: 'toggle default pin' }))
    fireEvent.click(screen.getByRole('button', { name: 'create custom group' }))
    fireEvent.click(screen.getByRole('button', { name: 'add custom item' }))
    await waitFor(() =>
      expect(screen.getByTestId('custom-items')).toHaveTextContent(
        customGroupItemId
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'toggle custom pin' }))

    await waitFor(() =>
      expect(screen.getByTestId('pinned-items')).toHaveTextContent(
        customGroupItemId
      )
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'move custom pin to top' })
    )

    await waitFor(() =>
      expect(
        screen.getByTestId('pinned-items').textContent?.split(',')
      ).toEqual([customGroupItemId, workloadsPodsItemId])
    )
  })

  it('removes a custom group and returns its items to other', async () => {
    await renderProvider()

    fireEvent.click(screen.getByRole('button', { name: 'create custom group' }))
    fireEvent.click(screen.getByRole('button', { name: 'add custom item' }))

    await waitFor(() =>
      expect(screen.getByTestId('custom-items')).toHaveTextContent(
        customGroupItemId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'toggle custom pin' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'toggle custom visibility' })
    )

    await waitFor(() =>
      expect(screen.getByTestId('pinned-items')).toHaveTextContent(
        customGroupItemId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'remove custom group' }))

    await waitFor(() => {
      expect(screen.getByTestId('custom-groups')).toBeEmptyDOMElement()
      expect(screen.getByTestId('custom-items')).toBeEmptyDOMElement()
      expect(screen.getByTestId('other-items')).toHaveTextContent(
        customGroupItemId
      )
      expect(screen.getByTestId('pinned-items')).toHaveTextContent(
        customGroupItemId
      )
      expect(screen.getByTestId('hidden-items')).toHaveTextContent(
        customGroupItemId
      )
    })
  })
})

// 改动先落本地状态（乐观）再串行写回：否则连续两次操作都会基于同一份旧状态
// 计算，前一次改动会被后一次覆盖掉。
describe('SidebarConfigProvider 写回服务端', () => {
  const signedInUser = { username: 'alice', sidebar_preference: '' }

  it('连续两次改动都会写回，后一次不会覆盖前一次', async () => {
    mockUseAuth.mockReturnValue({ user: signedInUser })
    const payloads: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(String(JSON.parse(String(init?.body)).sidebar_preference))
        return { ok: true, status: 200 } as Response
      })
    )

    await renderProvider()

    fireEvent.click(screen.getByRole('button', { name: 'toggle default pin' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'toggle default visibility' })
    )

    await waitFor(() => expect(payloads.length).toBeGreaterThanOrEqual(2))
    const lastSaved = JSON.parse(payloads[payloads.length - 1])
    expect(lastSaved.pinnedItems).toContain(workloadsPodsItemId)
    expect(lastSaved.hiddenItems).toContain(workloadsPodsItemId)
  })

  it('写回失败时提示用户，而不是只写 console', async () => {
    mockUseAuth.mockReturnValue({ user: signedInUser })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as Response)
    )

    await renderProvider()
    fireEvent.click(screen.getByRole('button', { name: 'toggle default pin' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })
})
