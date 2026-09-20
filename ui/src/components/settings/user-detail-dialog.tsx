import { useCallback, useState, type ReactNode } from 'react'
import { useAuth } from '@/contexts/auth-context'
import {
  IconEdit,
  IconLock,
  IconLockOpen,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { UserItem } from '@/types/api'
import {
  fetchKnownGroupDetails,
  fetchLDAPSyncStatus,
  updateUser,
  useOAuthProviderList,
} from '@/lib/api'
import { isDeletableUser, isNativeUser } from '@/lib/user-kind'
import { formatDate } from '@/lib/utils'
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard'
import { normalizeAvatarUrl } from '@/lib/avatar-url'
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
import { MultiSelect } from '@/components/multi-select'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

function DetailSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <div className="text-sm font-medium">{title}</div>
      {children}
    </div>
  )
}

/** 只读的「标签 · 值」行，成对排进两列网格里以压缩高度。 */
function DetailRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  )
}

function MetaGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">{children}</div>
}

function GroupBadges({
  groups,
  sources,
}: {
  groups: string[]
  sources: Record<string, string>
}) {
  const { t } = useTranslation()
  if (groups.length === 0) {
    return <span className="text-muted-foreground">-</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {groups.map((group) => {
        const source = sources[group] ?? 'local'
        return (
          <Badge
            key={group}
            variant={source === 'local' ? 'outline' : 'secondary'}
            className="text-xs"
            title={
              source === 'local'
                ? t('userManagement.detail.groups.sourceLocalHint', {
                    defaultValue:
                      '「本地」表示由管理员在控制台追加的附加组，不受目录同步影响。',
                  })
                : source.toUpperCase()
            }
          >
            {group}
          </Badge>
        )
      })}
    </div>
  )
}

interface UserDetailDialogProps {
  user: UserItem
  onOpenChange: (open: boolean) => void
  /**
   * 当前章节可写（settings.users 的 update 权限）。为 false 时整个弹窗是纯查看：
   * 资料字段变成文本、不渲染操作区。
   */
  editable: boolean
  /** 资料保存成功后的回调（父层用它同步弹窗里的用户对象）。 */
  onSaved?: (user: UserItem) => void
  onResetPassword?: (user: UserItem) => void
  onResetMFA?: (user: UserItem) => void
  onToggleEnabled?: (user: UserItem) => void
  onDelete?: (user: UserItem) => void
}

/**
 * 用户详情：点用户名 / 头像打开，把原来的「编辑」弹窗与行内管理操作合并到这里，
 * 管理员在一个地方就能看完信息并完成操作。
 *
 * 可编辑范围与后端 PUT /admin/users/:id 一致：本地账号可改昵称、头像、邮箱、手机、
 * 备注与用户组；目录账号（LDAP / OIDC）只允许改头像，其余字段由源系统维护，后端会
 * 静默忽略。密码不在这里改，走「重置密码」（本地账号专属）。
 */
export function UserDetailDialog({
  user,
  onOpenChange,
  editable,
  onSaved,
  onResetPassword,
  onResetMFA,
  onToggleEnabled,
  onDelete,
}: UserDetailDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { user: currentUser } = useAuth()
  const { data: oauthProviders = [] } = useOAuthProviderList()
  const { data: knownGroupDetails } = useQuery({
    queryKey: ['known-group-details'],
    queryFn: fetchKnownGroupDetails,
    staleTime: 60000,
  })

  const native = isNativeUser(user)
  const isLDAP = user.provider === 'ldap'
  const oauthProvider = oauthProviders.find(
    (provider) => provider.name === user.provider
  )
  const isDirectoryUser = isLDAP || Boolean(oauthProvider)
  // LDAP 同步状态属于「认证源」章节，只有能读该章节的管理员才请求：否则接口会 403，
  // 用户列表的管理员（settings.users）本来并不一定有认证源的权限。
  const canReadAuthentication =
    currentUser?.canViewSettingsSection('authentication') ?? false
  const { data: ldapStatus } = useQuery({
    queryKey: ['ldap-sync-status'],
    queryFn: fetchLDAPSyncStatus,
    enabled: isLDAP && canReadAuthentication,
    staleTime: 30000,
  })

  const [name, setName] = useState(user.name ?? '')
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url ?? '')
  const [email, setEmail] = useState(user.email ?? '')
  const [phone, setPhone] = useState(user.phone ?? '')
  const [remark, setRemark] = useState(user.remark ?? '')
  const [groups, setGroups] = useState<string[]>(user.oidc_groups ?? [])
  // 「是否改动过」的比较基准：保存成功后就地收敛，否则清空过的字段会因为服务端用
  // omitempty 不回传空值而被一直当成「已改动」。
  const [baseline, setBaseline] = useState(user)

  // 后端只处理请求里出现的字段，所以逐字段比较：只有真的改过的才提交。
  // 显式提交空串等于清空该字段（昵称、头像、联系方式都是这个语义）。
  const payload: Partial<UserItem> & { groups?: string[] } = {}
  if (avatarUrl.trim() !== (baseline.avatar_url ?? '')) {
    payload.avatar_url = normalizeAvatarUrl(avatarUrl)
  }
  if (native) {
    if (name.trim() !== (baseline.name ?? '')) payload.name = name.trim()
    if (email.trim() !== (baseline.email ?? '')) payload.email = email.trim()
    if (phone.trim() !== (baseline.phone ?? '')) payload.phone = phone.trim()
    if (remark.trim() !== (baseline.remark ?? ''))
      payload.remark = remark.trim()
    const currentGroups = baseline.oidc_groups ?? []
    if (
      groups.length !== currentGroups.length ||
      groups.some((group) => !currentGroups.includes(group))
    ) {
      payload.groups = groups
    }
  }
  const dirty = Object.keys(payload).length > 0
  // 上面的 dirty 就是「有改动会被丢弃」的判定；保存成功后 baseline 收敛，dirty 自动
  // 回到 false。关闭路径（遮罩 / Esc / X / 关闭按钮）统一交给 guard 拦一次。
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty, onClose: close })

  const saveMutation = useMutation({
    mutationFn: (data: Partial<UserItem> & { groups?: string[] }) =>
      updateUser(user.id, data),
    onSuccess: (updated, data) => {
      setBaseline((previous) => ({ ...previous, ...updated, ...data }))
      queryClient.invalidateQueries({ queryKey: ['user-list'] })
      onSaved?.(updated)
      toast.success(
        t('common.messages.updated', {
          resource: t('common.fields.user', 'User'),
          defaultValue: '用户已更新',
        })
      )
    },
    onError: () => {
      // 失败原因（邮箱格式、长度超限等）已由 API 客户端写明，弹窗保留以便修改后重试。
    },
  })

  const providerLabel =
    !user.provider || user.provider === 'password'
      ? t('userManagement.detail.provider.password', 'Local password')
      : isLDAP
        ? t('userManagement.detail.provider.ldap', 'LDAP directory')
        : user.provider
  const mfaLabel = user.mfa_enabled
    ? t('userManagement.detail.fields.mfaBound', '已绑定')
    : user.mfaDisabled
      ? t(
          'userManagement.detail.fields.mfaDisabledLevel',
          '该账号已关闭 MFA 强制'
        )
      : t('userManagement.messages.mfaNotBound', '未绑定 MFA')
  const groupSources = Object.fromEntries(
    Object.entries(knownGroupDetails ?? {}).map(([group, detail]) => [
      group,
      detail.source,
    ])
  )
  const groupOptions = Object.keys(knownGroupDetails ?? {}).sort((a, b) =>
    a.localeCompare(b)
  )
  const lastResult = ldapStatus?.lastResult

  const canResetPassword = editable && user.provider === 'password'
  const canResetMFA = editable && user.mfa_enabled === true
  const canDelete = editable && isDeletableUser(user)
  const hasActions =
    editable &&
    (canResetPassword || canResetMFA || canDelete || Boolean(onToggleEnabled))

  // 本地账号：昵称 / 头像 / 邮箱 / 手机 / 备注 / 用户组都可改；
  // 目录账号：只有头像（其余由目录同步，后端也会忽略）。
  const canEditProfile = editable && native
  const canEditAvatar = editable

  return (
    <>
      <Dialog open onOpenChange={guard.handleOpenChange}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span>{user.username}</span>
              {user.enabled ? (
                <Badge variant="default">
                  {t('status.enabled', 'Enabled')}
                </Badge>
              ) : (
                <Badge variant="secondary">
                  {t('status.disabled', 'Disabled')}
                </Badge>
              )}
              {user.pendingDeletion && (
                <Badge variant="destructive">
                  {t('userManagement.status.pendingDeletion', '待删除')}
                </Badge>
              )}
              {user.isSuperAdmin && (
                <Badge variant="outline">
                  {t('userManagement.detail.superAdmin', '超级管理员')}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {t('userManagement.detail.title', '用户详情')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-3">
              <DetailSection title={t('createUser.sections.account', '账户')}>
                <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  <DetailRow
                    label={t('userManagement.detail.fields.userId', '用户 ID')}
                  >
                    {user.id}
                  </DetailRow>
                  <DetailRow label={t('common.fields.username', '用户名')}>
                    {user.username}
                  </DetailRow>
                </div>
                {canEditProfile ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="user-detail-name">
                        {t('common.fields.name', '名称')}
                      </Label>
                      <Input
                        id="user-detail-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="user-detail-avatar">
                        {t(
                          'userManagement.detail.fields.avatarUrl',
                          '头像 URL'
                        )}
                      </Label>
                      <Input
                        id="user-detail-avatar"
                        value={avatarUrl}
                        onChange={(event) => setAvatarUrl(event.target.value)}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <DetailRow label={t('common.fields.name', '名称')}>
                      {user.name || '-'}
                    </DetailRow>
                    {canEditAvatar ? (
                      <div className="space-y-1.5 pt-1">
                        <Label htmlFor="user-detail-avatar">
                          {t(
                            'userManagement.detail.fields.avatarUrl',
                            '头像 URL'
                          )}
                        </Label>
                        <Input
                          id="user-detail-avatar"
                          value={avatarUrl}
                          onChange={(event) => setAvatarUrl(event.target.value)}
                        />
                      </div>
                    ) : (
                      user.avatar_url && (
                        <DetailRow
                          label={t(
                            'userManagement.detail.fields.avatarUrl',
                            '头像 URL'
                          )}
                        >
                          {user.avatar_url}
                        </DetailRow>
                      )
                    )}
                  </div>
                )}
                <MetaGrid>
                  <DetailRow label={t('common.fields.createdAt', '创建时间')}>
                    {formatDate(user.createdAt)}
                  </DetailRow>
                  <DetailRow
                    label={t(
                      'userManagement.detail.fields.updatedAt',
                      '资料更新时间'
                    )}
                  >
                    {user.updatedAt ? formatDate(user.updatedAt) : '-'}
                  </DetailRow>
                  <DetailRow label={t('common.fields.lastLoginAt', '最后登录')}>
                    {user.lastLoginAt ? formatDate(user.lastLoginAt) : '-'}
                  </DetailRow>
                  <DetailRow
                    label={t(
                      'userManagement.detail.fields.expiresAt',
                      '账号有效期'
                    )}
                  >
                    {user.expiresAt
                      ? formatDate(user.expiresAt)
                      : t(
                          'userManagement.detail.fields.neverExpires',
                          '永不过期'
                        )}
                  </DetailRow>
                  {user.password_updated_at && (
                    <DetailRow
                      label={t(
                        'userManagement.detail.fields.passwordUpdatedAt',
                        '密码更新时间'
                      )}
                    >
                      {formatDate(user.password_updated_at)}
                    </DetailRow>
                  )}
                  {!user.enabled && user.disabledAt && (
                    <DetailRow
                      label={t(
                        'userManagement.detail.fields.disabledAt',
                        '停用时间'
                      )}
                    >
                      {user.disabledReason === 'inactive'
                        ? t(
                            'userManagement.detail.fields.disabledReasonInactive',
                            '{{time}}（长期未登录，由「不活跃用户自动禁用」任务停用）',
                            { time: formatDate(user.disabledAt) }
                          )
                        : user.disabledReason === 'expired'
                          ? t(
                              'userManagement.detail.fields.disabledReasonExpired',
                              '{{time}}（账号已过期，由每日检查自动停用）',
                              { time: formatDate(user.disabledAt) }
                            )
                          : formatDate(user.disabledAt)}
                    </DetailRow>
                  )}
                </MetaGrid>
              </DetailSection>

              <DetailSection
                title={t('userManagement.detail.contact', '联系方式')}
              >
                {canEditProfile ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="user-detail-email">
                          {t('userManagement.detail.fields.email', 'Email')}
                        </Label>
                        <Input
                          id="user-detail-email"
                          type="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="user-detail-phone">
                          {t('userManagement.detail.fields.phone', 'Phone')}
                        </Label>
                        <Input
                          id="user-detail-phone"
                          value={phone}
                          onChange={(event) => setPhone(event.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="user-detail-remark">
                        {t('userManagement.detail.fields.remark', 'Remark')}
                      </Label>
                      <Input
                        id="user-detail-remark"
                        value={remark}
                        onChange={(event) => setRemark(event.target.value)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'userManagement.detail.contactHintLocal',
                        '邮箱用于接收通知，会做格式校验；三项留空即清空。'
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <MetaGrid>
                      <DetailRow
                        label={t('userManagement.detail.fields.email', 'Email')}
                      >
                        {user.email || '-'}
                      </DetailRow>
                      <DetailRow
                        label={t('userManagement.detail.fields.phone', 'Phone')}
                      >
                        {user.phone || '-'}
                      </DetailRow>
                    </MetaGrid>
                    <DetailRow
                      label={t('userManagement.detail.fields.remark', 'Remark')}
                    >
                      {user.remark || '-'}
                    </DetailRow>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'userManagement.detail.contactHintDirectory',
                        '该账号由目录同步维护，控制台只能修改头像。'
                      )}
                    </p>
                  </>
                )}
              </DetailSection>
            </div>

            <div className="space-y-3">
              <DetailSection
                title={t('createUser.sections.authentication', '认证')}
              >
                <MetaGrid>
                  <DetailRow label={t('common.fields.provider', '认证方式')}>
                    {providerLabel}
                  </DetailRow>
                  <DetailRow
                    label={t('userManagement.detail.fields.mfa', 'MFA')}
                  >
                    {mfaLabel}
                  </DetailRow>
                </MetaGrid>
              </DetailSection>

              {isDirectoryUser ? (
                <DetailSection
                  title={t('userManagement.detail.directory', '目录同步')}
                >
                  <p className="text-xs text-muted-foreground">
                    {isLDAP
                      ? t(
                          'userManagement.detail.ldap.managedHint',
                          '该账号由 LDAP 目录同步创建与维护：昵称、邮箱、手机与用户组以目录为准（账号的「资料更新时间」即最近一次刷新），控制台只能修改头像。'
                        )
                      : t(
                          'userManagement.detail.oidc.managedHint',
                          '该账号由 OIDC 提供商 {{provider}} 在登录时创建与更新：昵称、邮箱与用户组来自身份源声明，控制台只能修改头像。',
                          { provider: user.provider }
                        )}
                  </p>
                  {isLDAP && canReadAuthentication && (
                    <MetaGrid>
                      <DetailRow
                        label={t(
                          'userManagement.detail.ldap.lastSync',
                          'LDAP 最近同步'
                        )}
                      >
                        {ldapStatus?.lastSyncAt
                          ? formatDate(ldapStatus.lastSyncAt)
                          : t(
                              'userManagement.detail.ldap.neverSynced',
                              '尚未同步过'
                            )}
                      </DetailRow>
                      {ldapStatus?.autoSync && (
                        <DetailRow
                          label={t(
                            'userManagement.detail.ldap.autoSync',
                            '自动同步'
                          )}
                        >
                          {t(
                            'userManagement.detail.ldap.autoSyncInterval',
                            '每 {{minutes}} 分钟',
                            { minutes: ldapStatus.syncIntervalMinutes }
                          )}
                        </DetailRow>
                      )}
                      {lastResult && (
                        <DetailRow
                          label={t(
                            'userManagement.detail.ldap.lastResult',
                            '上次同步结果'
                          )}
                        >
                          {t(
                            'userManagement.detail.ldap.lastResultSummary',
                            '共 {{total}} 个账号，新增 {{created}}、更新 {{updated}}、失败 {{failed}}、清理 {{purged}}',
                            {
                              total: lastResult.totalUsers,
                              created: lastResult.created,
                              updated: lastResult.updated,
                              failed: lastResult.failed,
                              purged: lastResult.purged,
                            }
                          )}
                        </DetailRow>
                      )}
                    </MetaGrid>
                  )}
                  <div className="space-y-1.5">
                    <Label>
                      {t('userManagement.detail.fields.groups', 'Groups')}
                    </Label>
                    <GroupBadges
                      groups={user.oidc_groups ?? []}
                      sources={groupSources}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'userManagement.detail.groups.directoryHint',
                        '目录账号的用户组由目录同步维护；需要追加本地附加组时，请到「用户组」页签添加成员。'
                      )}
                    </p>
                  </div>
                </DetailSection>
              ) : (
                <DetailSection
                  title={t('userManagement.detail.fields.groups', 'Groups')}
                >
                  {canEditProfile ? (
                    <MultiSelect
                      value={groups}
                      onChange={setGroups}
                      options={groupOptions}
                      selectAllMode="all"
                      allowAdd={false}
                      placeholder={t(
                        'createUser.selectGroups',
                        '选择用户组（可多选）'
                      )}
                      emptyText={t(
                        'common.messages.noOptionsFound',
                        'No options found'
                      )}
                      hint={t(
                        'userManagement.detail.groups.editableHint',
                        '用户会继承这些用户组在 RBAC 中获得的角色；清空表示不属于任何用户组。'
                      )}
                    />
                  ) : (
                    <GroupBadges
                      groups={user.oidc_groups ?? []}
                      sources={groupSources}
                    />
                  )}
                </DetailSection>
              )}

              <DetailSection title={t('common.fields.roles', '角色')}>
                {(user.roles?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('userManagement.noGrantedRoles', '暂无授权角色')}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {user.roles?.map((role) => (
                      <Badge
                        key={role.name}
                        variant="outline"
                        className="text-xs"
                      >
                        {role.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </DetailSection>

              {hasActions && (
                <DetailSection title={t('common.fields.actions', '操作')}>
                  <div className="flex flex-wrap gap-2">
                    {onToggleEnabled && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onToggleEnabled(user)}
                      >
                        {user.enabled ? (
                          <>
                            <IconLock className="h-4 w-4" />
                            {t('common.actions.disable', '停用')}
                          </>
                        ) : (
                          <>
                            <IconLockOpen className="h-4 w-4" />
                            {t('common.actions.enable', '启用')}
                          </>
                        )}
                      </Button>
                    )}
                    {canResetPassword && onResetPassword && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onResetPassword(user)}
                      >
                        <IconEdit className="h-4 w-4" />
                        {t('common.actions.resetPassword', '重置密码')}
                      </Button>
                    )}
                    {canResetMFA && onResetMFA && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onResetMFA(user)}
                      >
                        <IconShieldLock className="h-4 w-4" />
                        {t('userManagement.actions.resetMFA', '重置 MFA')}
                      </Button>
                    )}
                    {canDelete && onDelete && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        onClick={() => onDelete(user)}
                      >
                        <IconTrash className="h-4 w-4" />
                        {t('common.actions.delete', 'Delete')}
                      </Button>
                    )}
                  </div>
                  {/* 原行内菜单里被禁用的项会带提示；改成按条件渲染后，
                    把唯一「找不到入口」的困惑（超管为何不能删）补在说明里。 */}
                  {user.isSuperAdmin && (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'userManagement.messages.superAdminNotDeletable',
                        '超级管理员账号不支持删除，请改用停用（停用前需要另有启用账号持有系统管理员角色）。'
                      )}
                    </p>
                  )}
                </DetailSection>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => guard.handleOpenChange(false)}
            >
              {t('common.actions.close', '关闭')}
            </Button>
            {editable && (
              <Button
                onClick={() => saveMutation.mutate(payload)}
                disabled={!dirty || saveMutation.isPending}
              >
                {saveMutation.isPending
                  ? t('common.actions.saving', '保存中...')
                  : t('common.actions.save', '保存')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

export default UserDetailDialog
