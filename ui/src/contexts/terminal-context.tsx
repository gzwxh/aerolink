import { createContext, ReactNode, useContext, useState } from 'react'

interface TerminalContextType {
  isOpen: boolean
  isMinimized: boolean
  openTerminal: () => void
  closeTerminal: () => void
  minimizeTerminal: () => void
  toggleTerminal: () => void
}

const TerminalContext = createContext<TerminalContextType | undefined>(
  undefined
)

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)

  // 打开（或取消最小化）终端
  const openTerminal = () => {
    setIsOpen(true)
    setIsMinimized(false)
  }

  // 完全关闭并销毁会话
  const closeTerminal = () => {
    setIsOpen(false)
    setIsMinimized(false)
  }

  // 隐藏面板但保持会话存活
  const minimizeTerminal = () => {
    setIsMinimized(true)
  }

  // 在打开 / 最小化之间切换
  const toggleTerminal = () => {
    if (!isOpen) {
      openTerminal()
    } else if (isMinimized) {
      setIsMinimized(false)
    } else {
      minimizeTerminal()
    }
  }

  return (
    <TerminalContext.Provider
      value={{
        isOpen,
        isMinimized,
        openTerminal,
        closeTerminal,
        minimizeTerminal,
        toggleTerminal,
      }}
    >
      {children}
    </TerminalContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTerminal() {
  const context = useContext(TerminalContext)
  if (context === undefined) {
    throw new Error('useTerminal must be used within a TerminalProvider')
  }
  return context
}
