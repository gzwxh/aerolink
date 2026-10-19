/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  markLoginRedirectLoop,
  reportApiFailure,
  resetServiceStatusForTest,
  retryService,
} from '@/lib/service-status'

import { ServiceStatusOverlay } from './service-status-overlay'

// 用标记串替掉真实文案：断言不依赖语言包措辞。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      const map: Record<string, string> = {
        'serviceStatus.serverUnavailable': 'SERVER_UNAVAILABLE',
        'serviceStatus.networkUnavailable': 'NETWORK_UNAVAILABLE',
        'serviceStatus.offline': 'OFFLINE',
        'serviceStatus.retry': 'RETRY',
        'serviceStatus.relogin': 'RELOGIN',
        'serviceStatus.redirectLoopTitle': 'REDIRECT_LOOP',
        'serviceStatus.redirectLoopHint': 'REDIRECT_LOOP_HINT',
      }
      if (map[key]) return map[key]
      if (typeof options === 'string') return options
      if (options && typeof options === 'object') {
        const fallback = (options as { defaultValue?: unknown }).defaultValue
        if (typeof fallback === 'string') return fallback
      }
      return key
    },
  }),
}))

describe('ServiceStatusOverlay', () => {
  beforeEach(() => {
    resetServiceStatusForTest()
    retryService()
  })

  it('一切正常时不渲染任何东西', () => {
    const { container } = render(<ServiceStatusOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('连续失败后显示服务异常横幅与重试入口', () => {
    for (let i = 0; i < 3; i += 1) {
      reportApiFailure('server')
    }
    render(<ServiceStatusOverlay />)

    expect(screen.getByRole('status')).toHaveTextContent('SERVER_UNAVAILABLE')
    expect(screen.getByText('RETRY')).toBeInTheDocument()
  })

  it('登录跳转成环时显示阻断页（不再整页跳转）', () => {
    markLoginRedirectLoop()
    render(<ServiceStatusOverlay />)

    expect(screen.getByText('REDIRECT_LOOP')).toBeInTheDocument()
    expect(screen.getByText('REDIRECT_LOOP_HINT')).toBeInTheDocument()
    expect(screen.getByText('RELOGIN')).toBeInTheDocument()
  })

  it('阻断页的「重试」会解除阻断', () => {
    markLoginRedirectLoop()
    render(<ServiceStatusOverlay />)

    fireEvent.click(screen.getByText('RETRY'))
    expect(screen.queryByText('REDIRECT_LOOP')).not.toBeInTheDocument()
  })
})
