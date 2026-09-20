import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryRouter,
  RouterProvider,
  useNavigate,
} from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { NavigationProvider, useNavigationHistory } from './navigation-context'

const STORAGE_KEY = 'kite-navigation-history'

function Probe() {
  const { canGoBack, canGoForward, goBack, goForward } = useNavigationHistory()
  const navigate = useNavigate()

  return (
    <div>
      <span data-testid="state">
        {`${canGoBack ? 'back' : '-'}/${canGoForward ? 'forward' : '-'}`}
      </span>
      <input data-testid="input" />
      <button type="button" onClick={() => navigate('/two')}>
        push-two
      </button>
      <button type="button" onClick={() => navigate('/three')}>
        push-three
      </button>
      <button
        type="button"
        onClick={() => navigate('/replaced', { replace: true })}
      >
        replace
      </button>
      <button type="button" onClick={goBack}>
        go-back
      </button>
      <button type="button" onClick={goForward}>
        go-forward
      </button>
    </div>
  )
}

function renderNavigation(initialPath = '/one') {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <NavigationProvider>
            <Probe />
          </NavigationProvider>
        ),
      },
    ],
    { initialEntries: [initialPath] }
  )
  render(<RouterProvider router={router} />)
  return router
}

function readStack() {
  const stored = sessionStorage.getItem(STORAGE_KEY)
  return stored
    ? (JSON.parse(stored) as {
        entries: Array<{ path: string; search: string }>
        index: number
      })
    : null
}

const paths = (stack: ReturnType<typeof readStack>) =>
  stack?.entries.map((entry) => entry.path)

describe('NavigationProvider', () => {
  it('records pushes and can move back and forward again', async () => {
    renderNavigation()
    expect(screen.getByTestId('state')).toHaveTextContent('-/-')

    fireEvent.click(screen.getByText('push-two'))
    fireEvent.click(screen.getByText('push-three'))
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('back/-')
    )
    expect(paths(readStack())).toEqual(['/one', '/two', '/three'])
    expect(readStack()?.index).toBe(2)

    fireEvent.click(screen.getByText('go-back'))
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('back/forward')
    )
    expect(readStack()?.index).toBe(1)

    fireEvent.click(screen.getByText('go-back'))
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('-/forward')
    )

    fireEvent.click(screen.getByText('go-forward'))
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('back/forward')
    )
    expect(readStack()?.index).toBe(1)
  })

  it('replaces the current entry on a replace navigation', async () => {
    renderNavigation()
    fireEvent.click(screen.getByText('push-two'))
    await waitFor(() => expect(paths(readStack())).toEqual(['/one', '/two']))

    fireEvent.click(screen.getByText('replace'))
    await waitFor(() =>
      expect(paths(readStack())).toEqual(['/one', '/replaced'])
    )
    expect(readStack()?.index).toBe(1)
  })

  it('restores the stack from sessionStorage on mount', async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        entries: [
          { path: '/one', search: '' },
          { path: '/two', search: '' },
        ],
        index: 1,
      })
    )

    renderNavigation('/two')

    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('back/-')
    )
    expect(paths(readStack())).toEqual(['/one', '/two'])
  })

  it('handles the shortcuts on window but not while typing in an input', async () => {
    renderNavigation()
    fireEvent.click(screen.getByText('push-two'))
    await waitFor(() => expect(readStack()?.index).toBe(1))

    // 输入框里按快捷键不拦截（编辑器/终端同理）。
    fireEvent.keyDown(screen.getByTestId('input'), {
      key: 'ArrowLeft',
      altKey: true,
    })
    expect(readStack()?.index).toBe(1)

    fireEvent.keyDown(window, { key: '[', metaKey: true })
    await waitFor(() => expect(readStack()?.index).toBe(0))

    fireEvent.keyDown(window, { key: ']', ctrlKey: true })
    await waitFor(() => expect(readStack()?.index).toBe(1))
  })

  it('caps the stack depth', async () => {
    const router = renderNavigation()

    for (let i = 0; i < 60; i += 1) {
      await act(async () => {
        await router.navigate(`/page-${i}`)
      })
    }

    await waitFor(() => {
      const stack = readStack()
      expect(stack?.entries).toHaveLength(50)
      expect(stack?.entries[stack.entries.length - 1].path).toBe('/page-59')
    })
  })
})
