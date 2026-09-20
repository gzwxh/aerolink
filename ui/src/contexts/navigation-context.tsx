/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'

interface NavigationEntry {
  path: string
  search: string
}

interface NavigationContextValue {
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
}

const NavigationContext = createContext<NavigationContextValue | undefined>(
  undefined
)

const STORAGE_KEY = 'kite-navigation-history'
// 只防长时间使用后无限增长：超了丢最旧的一条。
const MAX_DEPTH = 50

export function useNavigationHistory() {
  const context = useContext(NavigationContext)
  if (!context) {
    throw new Error(
      'useNavigationHistory must be used within a NavigationProvider'
    )
  }
  return context
}

/** 快捷键提示按平台显示（实际两种组合都接受，见下面的监听）。 */
export function navigationShortcuts() {
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.userAgent)
  return isMac
    ? { back: '⌘[', forward: '⌘]' }
    : { back: 'Alt+←', forward: 'Alt+→' }
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  // Monaco / xterm 自己也用这些组合键，而且它们不是原生输入框。
  return !!target.closest('.monaco-editor, .xterm')
}

function readStoredStack(): { entries: NavigationEntry[]; index: number } {
  const empty = { entries: [], index: -1 }
  // 读路径和写路径（下面的持久化 effect）一样要兜住：存储可能整个不可用
  // （禁用站点数据、沙箱 iframe 里访问会抛 SecurityError）。这里是在 useState
  // 初始化器里跑的，抛出去会让 NavigationProvider 直接挂不上，而它之上没有
  // error boundary。
  let stored: string | null
  try {
    stored = sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return empty
  }
  if (!stored) return empty
  try {
    const parsed = JSON.parse(stored) as {
      entries?: NavigationEntry[]
      index?: number
    }
    if (!Array.isArray(parsed.entries) || typeof parsed.index !== 'number') {
      return empty
    }
    return { entries: parsed.entries, index: parsed.index }
  } catch {
    // 内容坏了：清掉，免得每次进门都白解析一遍。清不掉也不影响导航。
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // 存储不可写（隐私模式 / 配额满）。
    }
    return empty
  }
}

/**
 * 应用内前进/后退。
 *
 * 这里维护自己的导航栈，而不是用 window.history.back()：项目里大量导航是
 * navigate(..., { replace: true })（创建页切命名空间、设置页切 tab 等），
 * 浏览器历史栈和「上一页」的语义对不上，退回去常常像没动一样。
 *
 * 栈存在 sessionStorage：同一标签页刷新不丢，关掉标签页即清空。顶部按钮走这条栈，
 * 浏览器自身的前进/后退按钮仍走浏览器栈，两者各自独立。
 */
export function NavigationProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()

  const [stack, setStack] = useState(readStoredStack)
  // goBack / goForward 触发的跳转不再记成新条目（指针已经先移好了）。记的是本次跳转
  // 的目标地址，而不是一个布尔标记：目标地址恰好就是当前地址时（栈里可能已经存在相邻
  // 重复条目）location 不变、下面的 effect 不会跑，布尔标记就会一直留着，把之后第一次
  // 真正的导航吞掉。
  const pendingMoveRef = useRef<string | null>(null)
  const current = useMemo(
    () => ({ path: location.pathname, search: location.search }),
    [location.pathname, location.search]
  )

  useEffect(() => {
    // 标记只对紧随其后的一次 location 变化有效：先取走再判断，避免残留。
    const movedTo = pendingMoveRef.current
    pendingMoveRef.current = null
    if (movedTo !== null && movedTo === `${current.path}${current.search}`)
      return
    setStack((prev) => {
      const { entries, index } = prev
      const isCurrent = (entry?: NavigationEntry) =>
        !!entry &&
        entry.path === current.path &&
        entry.search === current.search
      if (isCurrent(entries[index])) return prev

      // 浏览器自己的后退/前进：地址还在栈里就把指针移过去，别再记一条。
      if (navigationType === 'POP') {
        const found = entries.findIndex(isCurrent)
        if (found >= 0) return { entries, index: found }
      }
      // REPLACE：换掉当前这条（切命名空间、切 tab、重定向都走这里），指针不动。
      if (navigationType === 'REPLACE' && index >= 0) {
        const next = entries.slice()
        next[index] = current
        return { entries: next, index }
      }
      // 其余当作新条目：从当前位置往后截断，再处理深度上限。
      const kept = [...entries.slice(0, index + 1), current]
      const overflow = Math.max(0, kept.length - MAX_DEPTH)
      return {
        entries: kept.slice(overflow),
        index: kept.length - 1 - overflow,
      }
    })
  }, [current, navigationType])

  useEffect(() => {
    if (stack.index < 0) return
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stack))
    } catch {
      // 隐私模式 / 配额满时存不下：不影响导航本身。
    }
  }, [stack])

  const move = useCallback(
    (nextIndex: number) => {
      const target = stack.entries[nextIndex]
      if (!target || nextIndex === stack.index) return
      pendingMoveRef.current = `${target.path}${target.search}`
      setStack({ entries: stack.entries, index: nextIndex })
      navigate(`${target.path}${target.search}`, { replace: true })
    },
    [navigate, stack]
  )

  const goBack = useCallback(() => move(stack.index - 1), [move, stack.index])
  const goForward = useCallback(
    () => move(stack.index + 1),
    [move, stack.index]
  )
  const canGoBack = stack.index > 0
  const canGoForward =
    stack.index >= 0 && stack.index < stack.entries.length - 1

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return

      const withModifier = (key: string) =>
        event.key === key && (event.metaKey || event.ctrlKey)
      const isBack =
        withModifier('[') || (event.key === 'ArrowLeft' && event.altKey)
      const isForward =
        withModifier(']') || (event.key === 'ArrowRight' && event.altKey)
      if (!isBack && !isForward) return

      // Windows 上 Alt+←/→ 同时也是浏览器自己的后退/前进：能走应用内栈时才拦下来，
      // 免得两边各走一次；栈到头时不拦，留给浏览器原生行为。
      if (isBack) {
        if (!canGoBack) return
        event.preventDefault()
        goBack()
        return
      }
      if (!canGoForward) return
      event.preventDefault()
      goForward()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canGoBack, canGoForward, goBack, goForward])

  const value = useMemo(
    () => ({ canGoBack, canGoForward, goBack, goForward }),
    [canGoBack, canGoForward, goBack, goForward]
  )

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  )
}
