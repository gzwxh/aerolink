import { useMemo, useState, type FormEvent } from 'react'
import { IconShieldCheck } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Role } from '@/types/api'
import { createRole, updateRole, useRoleList } from '@/lib/api'
import { ApiError } from '@/lib/api-client'
import { isClusterScopedOnly } from '@/lib/node-permissions'
import { isSettingsResource } from '@/lib/rbac-permissions'
import {
  CANDIDATE_RESOURCES,
  privilegeOf,
  privilegeResourceItems,
  SCOPE_LABEL_KEYS,
  type Privilege,
  type TranslateFn,
} from '@/lib/rbac-privileges'
import {
  isProtectedRole,
  systemRoleDefaultLabel,
  systemRoleDescription,
} from '@/lib/system-roles'
import { cn } from '@/lib/utils'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  TransferBox,
  TransferList,
  type TransferItem,
} from '@/components/transfer-box'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface RBACRoleFormDialogProps {
  /** null 表示新建角色。 */
  role: Role | null
  onClose: () => void
  onSaved: (role: Role) => void
}

interface RoleFormState {
  name: string
  /** 界面展示名（可自定义）；空字符串 = 未自定义，界面回落到默认名。 */
  displayName: string
  description: string
  /** 资源 → 该资源上允许的操作；每个资源一套，互不影响。 */
  grants: Record<string, string[]>
}

// 存量角色存的是「资源 × 操作」的笛卡尔积，读回来时展开成每个资源一份相同操作；
// 保存时写成按资源的授权，语义不变。
const grantsFromRole = (role?: Role | null): Record<string, string[]> => {
  if (!role) return {}
  const grants: Record<string, string[]> = {}
  if (role.grants && role.grants.length > 0) {
    for (const grant of role.grants) {
      grants[grant.resource] = [...(grant.verbs ?? [])]
    }
    return grants
  }
  for (const resource of role.resources ?? []) {
    grants[resource] = [...(role.verbs ?? [])]
  }
  return grants
}

const roleToForm = (role?: Role | null): RoleFormState => ({
  name: role?.name ?? '',
  displayName: role?.displayName ?? '',
  description: role?.description ?? '',
  grants: grantsFromRole(role),
})

export function RBACRoleFormDialog({
  role,
  onClose,
  onSaved,
}: RBACRoleFormDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const isEdit = !!role
  const isSystem = !!role?.isSystem
  // 受保护的内置角色（三员 + 只读管理员）只读：规则由代码维护，后端也会拒绝写入。
  const isProtected = !!role && isProtectedRole(role)

  const buildFormState = (): RoleFormState => roleToForm(role)
  const [form, setForm] = useState<RoleFormState>(buildFormState)
  // 表单草稿随本组件一起挂载（父级按 open 条件渲染），关闭即丢弃；
  // 有改动时由 useUnsavedChangesGuard 拦截遮罩点击 / Esc / 右上角 X。
  const isDirty = useDraftDirty(form)
  const guard = useUnsavedChangesGuard({ dirty: isDirty, onClose })
  // 已授权的资源（grants 的键）；* 排在最前，其余按权限清单里的顺序。
  const grantedResources = useMemo(() => {
    const order = (resource: string) => {
      const index = CANDIDATE_RESOURCES.indexOf(resource)
      return index === -1 ? Number.MAX_SAFE_INTEGER : index
    }
    return Object.keys(form.grants).sort((a, b) => {
      if (a === b) return 0
      if (a === '*') return -1
      if (b === '*') return 1
      const diff = order(a) - order(b)
      return diff !== 0 ? diff : a.localeCompare(b)
    })
  }, [form.grants])
  // 角色不带集群属性：一律全局（clusters = ["*"]），页面也不再提供集群选择器。
  const clusterScopedOnly = isClusterScopedOnly(grantedResources)

  // 「权限」穿梭框的过滤词，以及两侧选中后等待搬运的条目。
  const [privilegeSearch, setPrivilegeSearch] = useState('')
  const [selectedPrivilege, setSelectedPrivilege] = useState<string>()
  const [selectedGrantedPrivilege, setSelectedGrantedPrivilege] =
    useState<string>()
  const translate: TranslateFn = useMemo(
    () => (key: string, defaultValue: string) => t(key, { defaultValue }),
    [t]
  )

  // ----- 权限清单与搬运操作 -----

  // 条目与「权限一览」页同源（权限 ID / 名称 / 来源 / 范围徽标一致）。设置族
  // （settings / settings.<章节>，即 aerolink:settings*）不进「可用」：这些权限由内置角色
  // 承担（三员完整管理，只读管理员只有 get），弹窗里只把角色已有的设置授权列在
  // 「已赋予」里，可以查看与移除。
  const privileges = useMemo<Privilege[]>(() => {
    const resources = [
      ...CANDIDATE_RESOURCES.filter((name) => !isSettingsResource(name)),
      ...grantedResources.filter(isSettingsResource),
    ]
    return resources.flatMap((resource) => {
      const verbs = form.grants[resource] ?? []
      // 「全部操作（*）」已覆盖该资源的其余操作，只留它一行（对应截图里的 nx-all）。
      return verbs.includes('*')
        ? [privilegeOf(resource, '*', translate)]
        : privilegeResourceItems(resource, translate)
    })
  }, [form.grants, grantedResources, translate])

  const privilegesById = useMemo(
    () => new Map(privileges.map((privilege) => [privilege.id, privilege])),
    [privileges]
  )

  // 可用 = 还没搬过来的权限；已赋予 = 角色已经有的权限（含存量角色里的设置授权）。
  const privilegeTransfer = useMemo(() => {
    const available: TransferItem[] = []
    const included: TransferItem[] = []
    for (const privilege of privileges) {
      const verbs = form.grants[privilege.resource] ?? []
      const item: TransferItem = {
        id: privilege.id,
        label: privilege.name,
        // 行尾徽标与「权限一览」页的「类型」列同源。
        badge: t(SCOPE_LABEL_KEYS[privilege.scope], {
          defaultValue: privilege.scope,
        }),
        note: privilege.id,
      }
      if (verbs.includes('*') || verbs.includes(privilege.verb)) {
        included.push(item)
      } else if (!isSettingsResource(privilege.resource)) {
        available.push(item)
      }
    }
    return { available, included }
  }, [privileges, form.grants, t])

  const grantPrivileges = (ids: string[]) =>
    setForm((prev) => {
      const grants = { ...prev.grants }
      for (const id of ids) {
        const privilege = privilegesById.get(id)
        if (!privilege) continue
        const verbs = grants[privilege.resource] ?? []
        // 该资源的「全部操作（*）」已经覆盖了这个操作，无需重复展开。
        if (verbs.includes('*') || verbs.includes(privilege.verb)) continue
        // 搬入「全部操作（*）」= 收敛成通配，不与显式操作并存。
        grants[privilege.resource] =
          privilege.verb === '*' ? ['*'] : [...verbs, privilege.verb]
      }
      return { ...prev, grants }
    })

  const revokePrivileges = (ids: string[]) =>
    setForm((prev) => {
      const grants = { ...prev.grants }
      for (const id of ids) {
        const privilege = privilegesById.get(id)
        if (!privilege) continue
        const remaining = (grants[privilege.resource] ?? []).filter(
          (verb) => verb !== privilege.verb
        )
        // 最后一个操作被搬走时整条授权一起删掉（空操作集合提交时也会被丢弃）。
        if (remaining.length === 0) delete grants[privilege.resource]
        else grants[privilege.resource] = remaining
      }
      return { ...prev, grants }
    })

  // 角色名在后端是**全局唯一**，角色列表也是全局的（不再按当前集群过滤），
  // 所以同名角色一定能在页面上找到。
  const { data: allRoles = [] } = useRoleList()
  const conflictingRole = useMemo(() => {
    if (isSystem) return undefined
    const name = form.name.trim()
    if (!name) return undefined
    return allRoles.find(
      (existing) => existing.name.trim() === name && existing.id !== role?.id
    )
  }, [allRoles, form.name, isSystem, role?.id])

  const roleNameConflictMessage = t(
    'rbac.roleNameConflict',
    'A role with this name already exists. Role names are unique across the whole console.'
  )

  // 「名称」留空时的回落值（也是输入框的占位提示）：内置角色是当前语言下的内置名，
  // 自定义角色就是角色 ID——新建时直接跟随角色 ID 输入框。
  const fallbackDisplayName =
    isSystem && role ? systemRoleDefaultLabel(t, role) : form.name.trim()

  // 受保护角色的描述按当前语言展示（后端存的是英文默认描述），并且不可编辑。
  const descriptionText =
    isProtected && role ? systemRoleDescription(t, role) : form.description

  const duplicateName = !!conflictingRole

  // Pod 终端要跟「查看 Pod」一起授予（见 pkg/rbac/rbac.go 的 execRequiresGet）：
  // 只勾终端不勾查看时后端会拒绝连接，这里提前把缺的那条权限点出来。
  const podVerbs = form.grants.pods ?? []
  const podExecWithoutView =
    !isProtected && podVerbs.includes('exec') && !podVerbs.includes('get')

  // ----- 角色 mutation -----

  const createMutation = useMutation({
    mutationFn: (data: Partial<Role>) => createRole(data),
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ['role-list'] })
      toast.success(
        t('common.messages.created', {
          resource: t('common.fields.role', 'Role'),
          defaultValue: 'Role created',
        })
      )
      onSaved(resp.role)
    },
    onError: (err: Error) => {
      if (
        err instanceof ApiError &&
        (err.code === 'role_name_conflict' || err.status === 409)
      ) {
        return
      }
      toast.error(err.message)
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Role>) => updateRole(role!.id, data),
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ['role-list'] })
      toast.success(
        t('common.messages.updated', {
          resource: t('common.fields.role', 'Role'),
          defaultValue: 'Role updated',
        })
      )
      onSaved(resp.role)
    },
    onError: (err: Error) => {
      if (
        err instanceof ApiError &&
        (err.code === 'role_name_conflict' || err.status === 409)
      ) {
        return
      }
      toast.error(err.message)
    },
  })

  // ----- 表单提交 -----

  // 提交用的按资源授权：空操作集合的资源不下发。
  const grantsPayload = useMemo(() => {
    const grants: { resource: string; verbs: string[] }[] = []
    for (const resource of grantedResources) {
      const verbs = (form.grants[resource] ?? []).filter((verb) => verb !== '')
      if (verbs.length > 0) grants.push({ resource, verbs })
    }
    return {
      grants,
      resources: grants.map((grant) => grant.resource),
      verbs: Array.from(new Set(grants.flatMap((grant) => grant.verbs))),
    }
  }, [grantedResources, form.grants])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    // 受保护的内置角色只读（界面也不给保存入口），后端同样会拒绝写入。
    if (isProtected) return
    // 非受保护的系统角色与自定义角色一样可编辑：仅名称固定。
    if (duplicateName) {
      toast.error(roleNameConflictMessage)
      return
    }
    if (grantsPayload.grants.length === 0) {
      toast.error(t('rbac.grantsRequired', '请至少选择一条权限。'))
      return
    }
    const data: Partial<Role> = {
      name: form.name.trim(),
      // 空字符串 = 未自定义，后端存空值，界面继续按默认名显示。
      displayName: form.displayName.trim(),
      description: form.description,
      // 角色是全局的：不区分集群，固定写通配（生效范围由权限绑定决定）。
      clusters: ['*'],
      ...grantsPayload,
    }
    if (isEdit) {
      updateMutation.mutate(data)
    } else {
      createMutation.mutate(data)
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending

  const moveLabels = {
    grantAll: t('rbac.grantAll', 'Grant all'),
    grantSelected: t('rbac.grantSelected', 'Grant selected'),
    revokeSelected: t('rbac.revokeSelected', 'Revoke selected'),
    revokeAll: t('rbac.revokeAll', 'Revoke all'),
  }

  // 「权限」穿梭框：条目与「权限一览」页同源，一条权限 = 一个资源上的一个操作。
  const permissionsPanel = (
    <TransferBox
      title={t('rbac.privilegesTitle', 'Privileges')}
      hint={t(
        'rbac.privilegeHint',
        '权限来自「权限一览」页：一个资源上的一个操作就是一条权限。设置族（settings.*）由内置角色承担（系统管理员 / 安全管理员 / 审计管理员完整管理，只读管理员只有 get），不在这里提供。'
      )}
      availableLabel={t('rbac.available', '可用')}
      includedLabel={t('rbac.assigned', '已赋予')}
      available={privilegeTransfer.available}
      included={privilegeTransfer.included}
      filterValue={privilegeSearch}
      onFilterChange={setPrivilegeSearch}
      filterPlaceholder={t(
        'rbac.privilegeFilterPlaceholder',
        '过滤（例如 pods）'
      )}
      availableEmptyText={t('rbac.noAvailablePermissions', '没有可用的权限。')}
      includedEmptyText={t('rbac.noGrantedPermissions', '尚未赋予任何权限。')}
      selectedAvailableId={selectedPrivilege}
      selectedIncludedId={selectedGrantedPrivilege}
      onSelect={(side, id) =>
        side === 'available'
          ? setSelectedPrivilege(id)
          : setSelectedGrantedPrivilege(id)
      }
      onGrant={(id) => grantPrivileges([id])}
      onRevoke={(id) => revokePrivileges([id])}
      onGrantAll={(ids) => grantPrivileges(ids)}
      onRevokeAll={() =>
        revokePrivileges(privilegeTransfer.included.map((item) => item.id))
      }
      moveLabels={moveLabels}
    />
  )

  // 受保护角色只读：把已赋予的权限原样列出来，不提供搬运入口。
  const readonlyPermissionsPanel = (
    <div className="space-y-2">
      <div className="font-medium">
        {t('rbac.privilegesTitle', 'Privileges')}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'rbac.protectedRolePrivilegesHint',
          '内置权限由代码维护，只能查看，不能调整。'
        )}
      </p>
      <TransferList
        items={privilegeTransfer.included}
        emptyText={t('rbac.noGrantedPermissions', '尚未赋予任何权限。')}
        onSelect={() => {}}
        onActivate={() => {}}
      />
    </div>
  )

  return (
    <>
      <Dialog open onOpenChange={guard.handleOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <IconShieldCheck className="h-5 w-5" />
              {isEdit
                ? isProtected
                  ? t('rbac.viewRoleTitle', { name: role!.name })
                  : t('rbac.editRoleTitle', { name: role!.name })
                : t('rbac.newRole', 'New Role')}
              {isSystem && (
                <Badge variant={isProtected ? 'default' : 'secondary'}>
                  {isProtected
                    ? t('rbac.protectedRoleBadge', '受保护')
                    : t('rbac.builtinRoleBadge', '内置')}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {isProtected
                ? t(
                    'rbac.protectedRoleReadonlyHint',
                    '受保护的内置角色：规则由代码维护，只能查看，不能修改或删除。'
                  )
                : isSystem
                  ? t(
                      'rbac.systemRoleHint',
                      'System role: the name is fixed, its permissions can be adjusted.'
                    )
                  : t(
                      'rbac.roleFormHint',
                      '角色只定义集群、资源与操作；命名空间范围由「权限绑定」决定。'
                    )}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="role-name">
                  {t('rbac.roleId', '角色 ID')} *
                </Label>
                <Input
                  id="role-name"
                  value={form.name}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  disabled={isEdit}
                  aria-invalid={duplicateName}
                  className={cn(
                    'font-mono',
                    duplicateName && 'border-destructive'
                  )}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role-display-name">
                  {t('common.fields.name', 'Name')}
                </Label>
                <Input
                  id="role-display-name"
                  value={form.displayName}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      displayName: e.target.value,
                    }))
                  }
                  placeholder={
                    fallbackDisplayName ||
                    t(
                      'rbac.roleDisplayNamePlaceholder',
                      'Defaults to the role ID'
                    )
                  }
                  disabled={isProtected}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role-desc">
                  {t('common.fields.description', 'Description')}
                </Label>
                <Textarea
                  id="role-desc"
                  value={descriptionText}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  rows={1}
                  className="min-h-9 resize-y py-1.5"
                  disabled={isProtected}
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {t(
                'rbac.roleIdReadonlyHint',
                '角色 ID 是权限判定的依据，创建后不可修改。'
              )}{' '}
              {t(
                'rbac.roleNameHint',
                '「名称」只用于界面展示，可自定义；留空时内置角色显示内置名称，自定义角色与角色 ID 相同。'
              )}
            </p>
            {duplicateName && (
              <p className="text-xs text-destructive">
                {roleNameConflictMessage}
              </p>
            )}

            <p className="text-sm text-muted-foreground">
              {clusterScopedOnly
                ? t(
                    'rbac.clusterOnlyPermissionsHint',
                    'Pick the resources and verbs. This role only manages cluster-scoped resources.'
                  )
                : t(
                    'rbac.permissionsHint',
                    'Pick the resources and verbs. Roles are global — where they apply (cluster and namespaces) is defined by permission binding groups.'
                  )}
            </p>

            {podExecWithoutView && (
              <p className="text-xs text-destructive">
                {t(
                  'rbac.podExecRequiresView',
                  '"Pod terminal" is selected without "View pods": also select "View pods", otherwise the terminal cannot connect.'
                )}
              </p>
            )}

            {isProtected ? readonlyPermissionsPanel : permissionsPanel}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => guard.handleOpenChange(false)}
                disabled={isSaving}
              >
                {isProtected
                  ? t('common.actions.close', '关闭')
                  : t('common.actions.cancel', 'Cancel')}
              </Button>
              {!isProtected && (
                <Button type="submit" disabled={isSaving || duplicateName}>
                  {isSaving
                    ? t('common.actions.saving', 'Saving...')
                    : t('rbac.saveRole', '保存角色')}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

export default RBACRoleFormDialog
