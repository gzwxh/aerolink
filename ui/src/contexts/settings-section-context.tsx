/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from 'react'
import { useAuth } from '@/contexts/auth-context'

/**
 * 当前设置章节的读写权限。
 *
 * 等保三级三权分立下，一个管理员常常只有某些章节的**读**权限（例如审计管理员只有
 * settings.audit 的 get）。后端会对写操作返回 403，这里让界面提前把写入口收起来 /
 * 禁用，避免「点了才失败」。
 */
export interface SettingsSectionAccess {
  /** 章节名，对应后端资源 settings.<section>；没有 Provider 时为空串。 */
  section: string
  /** 只读：能看但改不了，所有写操作入口都应隐藏或禁用。 */
  readOnly: boolean
}

const SettingsSectionContext = createContext<SettingsSectionAccess>({
  section: '',
  readOnly: false,
})

export function SettingsSectionProvider({
  section,
  children,
}: {
  section: string
  children: ReactNode
}) {
  const { user } = useAuth()
  const readOnly = !(user?.canManageSettingsSection(section) ?? false)

  return (
    <SettingsSectionContext.Provider value={{ section, readOnly }}>
      {children}
    </SettingsSectionContext.Provider>
  )
}

/** 读取当前设置章节的读写权限（见 SettingsSectionAccess）。 */
export function useSettingsSectionAccess(): SettingsSectionAccess {
  return useContext(SettingsSectionContext)
}
