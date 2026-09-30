/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'

interface PageRefreshValue {
  /** 递增的刷新代数：订阅者比较它就知道「用户又点了一次刷新」。 */
  epoch: number
  /** 请求刷新当前页面。 */
  refresh: () => void
}

/**
 * 没有 Provider 时的缺省值：退化为「没有刷新信号」，不抛错。
 *
 * 订阅方（`useResourcesWatch`）在很多地方被单独渲染（单测、外壳之外的组件），
 * 缺省抛错会把它们一并打断，而这里缺信号的后果只是「不会被刷新按钮带上」。
 */
const NOOP: PageRefreshValue = { epoch: 0, refresh: () => {} }

const PageRefreshContext = createContext<PageRefreshValue>(NOOP)

/**
 * 页面级刷新信号。
 *
 * 「刷新」按钮的语义是「重新取这一页展示的全部数据」，而这一页的数据不都归 react-query 管：
 * 走 SSE 的列表（见 `useResourcesWatch`）数据在组件本地 state 里，外壳的 `refetchQueries`
 * 碰不到它。与其让每个页面各自记得去重连那条连接，这里做成一个信号：外壳点刷新时 bump，
 * 所有数据源订阅它。
 *
 * 挂在应用根部而不是页面外壳内部：页面组件自己在 shell 之外调用
 * `useResourcesWatch`，外壳内部的 Provider 覆盖不到它。
 */
export function PageRefreshProvider({ children }: { children: ReactNode }) {
  const [epoch, setEpoch] = useState(0)
  const refresh = useCallback(() => setEpoch((prev) => prev + 1), [])
  const value = useMemo(() => ({ epoch, refresh }), [epoch, refresh])

  return (
    <PageRefreshContext.Provider value={value}>
      {children}
    </PageRefreshContext.Provider>
  )
}

/** 当前页面的刷新代数；没有 Provider 时恒为 0。 */
export function usePageRefreshEpoch(): number {
  return useContext(PageRefreshContext).epoch
}

/** 请求刷新当前页面；只有带刷新按钮的页面外壳需要它。 */
export function useRequestPageRefresh(): () => void {
  return useContext(PageRefreshContext).refresh
}
