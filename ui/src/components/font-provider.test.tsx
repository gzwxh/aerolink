import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FontProvider, useFont } from './font-provider'

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

function FontConsumer() {
  const { font, setFont } = useFont()

  return (
    <div>
      <span data-testid="state">{font}</span>
      <button type="button" onClick={() => setFont('system')}>
        set system
      </button>
      <button type="button" onClick={() => setFont('jetbrains')}>
        set jetbrains
      </button>
      <button type="button" onClick={() => setFont('serif')}>
        set serif
      </button>
      <button type="button" onClick={() => setFont('kai')}>
        set kai
      </button>
    </div>
  )
}

describe('FontProvider', () => {
  it('syncs the app font variable and persists font changes', async () => {
    localStorage.clear()
    // 旧版本留下的值可能已经不在可选项里，这时要回落到默认字体。
    localStorage.setItem('font-theme-key', 'unknown-font')

    render(
      <FontProvider defaultFont="maple" storageKey="font-theme-key">
        <FontConsumer />
      </FontProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('maple')
    })
    expect(
      document.documentElement.style.getPropertyValue('--app-font-sans')
    ).toBe("'Maple Mono', var(--font-sans)")
    expect(localStorage.getItem('font-theme-key')).toBe('maple')

    fireEvent.click(screen.getByRole('button', { name: 'set system' }))

    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('system')
    })
    expect(
      document.documentElement.style.getPropertyValue('--app-font-sans')
    ).toBe('var(--font-sans)')
    expect(localStorage.getItem('font-theme-key')).toBe('system')

    fireEvent.click(screen.getByRole('button', { name: 'set jetbrains' }))

    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('jetbrains')
    })
    expect(
      document.documentElement.style.getPropertyValue('--app-font-sans')
    ).toBe("'JetBrains Mono', var(--font-sans)")
    expect(localStorage.getItem('font-theme-key')).toBe('jetbrains')

    fireEvent.click(screen.getByRole('button', { name: 'set serif' }))

    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('serif')
    })
    expect(
      document.documentElement.style.getPropertyValue('--app-font-sans')
    ).toBe(
      "'AeroLink Song SC', 'Songti SC', SimSun, 'Noto Serif CJK SC', serif"
    )

    fireEvent.click(screen.getByRole('button', { name: 'set kai' }))

    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('kai')
    })
    expect(
      document.documentElement.style.getPropertyValue('--app-font-sans')
    ).toBe("'AeroLink Kai', 'Kaiti SC', KaiTi, STKaiti, serif")
    expect(localStorage.getItem('font-theme-key')).toBe('kai')
  })
})
