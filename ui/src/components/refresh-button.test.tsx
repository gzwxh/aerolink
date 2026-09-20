import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RefreshButton } from './refresh-button'

const getIcon = () =>
  screen.getByRole('button', { name: 'Refresh' }).querySelector('svg')

describe('RefreshButton', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls onClick once per click', () => {
    const onClick = vi.fn()
    render(<RefreshButton onClick={onClick} />)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('keeps spinning for the minimum duration so fast refreshes stay visible', () => {
    vi.useFakeTimers()
    render(<RefreshButton onClick={() => {}} minSpinMs={1000} />)
    expect(getIcon()).not.toHaveClass('animate-spin')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(getIcon()).toHaveClass('animate-spin')

    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(getIcon()).toHaveClass('animate-spin')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(getIcon()).not.toHaveClass('animate-spin')
  })

  it('does nothing while disabled', () => {
    const onClick = vi.fn()
    render(<RefreshButton onClick={onClick} disabled />)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(onClick).not.toHaveBeenCalled()
    expect(getIcon()).not.toHaveClass('animate-spin')
  })

  it('uses the label override as the accessible name', () => {
    render(<RefreshButton onClick={() => {}} label="Reconnect and fetch" />)

    expect(
      screen.getByRole('button', { name: 'Reconnect and fetch' })
    ).toBeInTheDocument()
  })
})
