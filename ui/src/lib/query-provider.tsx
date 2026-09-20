/* eslint-disable react-refresh/only-export-components */
// 查询 Provider（React Query）
import { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// 创建 client
// 导出它是为了让非 hook 模块（例如操作失败上报器）在写入站内消息后
// 使通知查询失效。
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry(failureCount, error) {
        return failureCount < 3 && (error as unknown as Response).status > 500
      },
    },
  },
})

interface QueryProviderProps {
  children: ReactNode
}

export const QueryProvider = ({ children }: QueryProviderProps) => {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}
