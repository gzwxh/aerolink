import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TerminalProvider, useTerminal } from './terminal-context'

function createStorage() {
  let store: Record<string, string> = {}

  return {
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key)
        ? store[key]
        : null
    },
    setItem(key: string, value: string) {
      store[key] = value
    },
    removeItem(key: string) {
      delete store[key]
    },
    clear() {
      store = {}
    },
  }
}

vi.stubGlobal('localStorage', createStorage())
vi.stubGlobal('sessionStorage', createStorage())

function TerminalConsumer() {
  const {
    isOpen,
    isMinimized,
    openTerminal,
    closeTerminal,
    minimizeTerminal,
    toggleTerminal,
  } = useTerminal()

  return (
    <div>
      <span data-testid="state">
        {isOpen ? 'open' : 'closed'}/{isMinimized ? 'minimized' : 'expanded'}
      </span>
      <button type="button" onClick={openTerminal}>
        open
      </button>
      <button type="button" onClick={closeTerminal}>
        close
      </button>
      <button type="button" onClick={minimizeTerminal}>
        minimize
      </button>
      <button type="button" onClick={toggleTerminal}>
        toggle
      </button>
    </div>
  )
}

function WorkspaceConsumer() {
  const {
    sessions,
    activeSessionId,
    activeSession,
    openSession,
    activateSession,
    closeSession,
  } = useTerminal()

  return (
    <div>
      <span data-testid="sessions">
        {sessions.map((session) => session.title).join('|')}
      </span>
      <span data-testid="active">{activeSessionId ?? 'none'}</span>
      <span data-testid="active-title">{activeSession?.title ?? 'none'}</span>
      <span data-testid="active-cluster">
        {activeSession?.clusterName ?? 'none'}
      </span>
      <button
        type="button"
        onClick={() =>
          openSession({
            type: 'pod',
            source: 'pod',
            namespace: 'default',
            podName: 'web-0',
            containerName: 'app',
          })
        }
      >
        open-pod
      </button>
      <button
        type="button"
        onClick={() =>
          openSession({
            type: 'logs',
            source: 'pod',
            namespace: 'default',
            podName: 'web-0',
          })
        }
      >
        open-logs
      </button>
      <button
        type="button"
        onClick={() => activateSession(sessions[0]?.id ?? '')}
      >
        activate-first
      </button>
      <button
        type="button"
        onClick={() => activeSessionId && closeSession(activeSessionId)}
      >
        close-active
      </button>
    </div>
  )
}

describe('TerminalProvider 工作区会话', () => {
  it('同时保留多个会话、同一目标去重、关闭后回落到剩余会话', async () => {
    render(
      <TerminalProvider>
        <WorkspaceConsumer />
      </TerminalProvider>
    )

    expect(screen.getByTestId('sessions')).toBeEmptyDOMElement()
    expect(screen.getByTestId('active')).toHaveTextContent('none')

    fireEvent.click(screen.getByRole('button', { name: 'open-pod' }))
    await waitFor(() => {
      expect(screen.getByTestId('sessions')).toHaveTextContent('web-0 · app')
    })

    // 同一目标重复打开只激活已有会话，不新建。
    fireEvent.click(screen.getByRole('button', { name: 'open-pod' }))
    await waitFor(() => {
      expect(
        screen.getByTestId('sessions').textContent?.split('|')
      ).toHaveLength(1)
    })

    // 不同种类（日志）可以并存。
    fireEvent.click(screen.getByRole('button', { name: 'open-logs' }))
    await waitFor(() => {
      expect(
        screen.getByTestId('sessions').textContent?.split('|')
      ).toHaveLength(2)
    })
    expect(screen.getByTestId('active-title')).toHaveTextContent('web-0')

    // 切回第一个会话。
    fireEvent.click(screen.getByRole('button', { name: 'activate-first' }))
    await waitFor(() => {
      expect(screen.getByTestId('active-title')).toHaveTextContent(
        'web-0 · app'
      )
    })

    // 关掉当前会话后自动落到剩余会话上。
    fireEvent.click(screen.getByRole('button', { name: 'close-active' }))
    await waitFor(() => {
      expect(
        screen.getByTestId('sessions').textContent?.split('|')
      ).toHaveLength(1)
    })
    expect(screen.getByTestId('active')).not.toHaveTextContent('none')
  })
})

describe('TerminalProvider', () => {
  it('drives the terminal state through its public actions', async () => {
    render(
      <TerminalProvider>
        <TerminalConsumer />
      </TerminalProvider>
    )

    expect(screen.getByTestId('state')).toHaveTextContent('closed/expanded')

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('open/expanded')
    })

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('open/minimized')
    })

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('open/expanded')
    })

    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('closed/expanded')
    })
  })
})
