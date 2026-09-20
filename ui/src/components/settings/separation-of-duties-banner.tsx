import { IconAlertTriangle } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { useRoleConflicts } from '@/lib/api'

/**
 * 职责分离（三权分立）冲突巡检提示。
 *
 * 冲突账号的管理面已被整体拒绝（`403 role_conflict`），但角色本身不会自动改正，
 * 需要安全管理员手动解绑其中一个。提示放在「权限管理」的容器上，因此「角色」与
 * 「权限绑定」两个页签都能看到——真正的解绑动作往往在权限绑定页完成。
 */
export function SeparationOfDutiesBanner() {
  const { t } = useTranslation()
  const { data: roleConflicts = [] } = useRoleConflicts()

  if (roleConflicts.length === 0) {
    return null
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      <div className="space-y-1">
        <div className="font-medium text-destructive">
          {t('rbac.roleConflictsTitle', '职责分离冲突')}
        </div>
        <ul className="space-y-0.5 text-muted-foreground">
          {roleConflicts.map((conflict) => (
            <li key={conflict.username}>
              <span className="font-mono">{conflict.username}</span>
              <span> — {conflict.roles.join(' / ')}</span>
              {!conflict.enabled && (
                <span> ({t('common.values.disabled', '已禁用')})</span>
              )}
            </li>
          ))}
        </ul>
        <div className="text-muted-foreground">
          {t(
            'rbac.roleConflictsHint',
            '这些账号同时持有互斥的管理员角色，其管理面已被整体拒绝。请解绑其中一个角色（或调整对应权限绑定组的成员角色）后再让本人重试。'
          )}
        </div>
      </div>
    </div>
  )
}
