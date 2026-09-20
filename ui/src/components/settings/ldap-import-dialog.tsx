import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconSearch, IconUserPlus } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  fetchLDAPImportCandidates,
  importLDAPUsers,
  LDAPImportCandidate,
} from '@/lib/api'
import { translateError } from '@/lib/utils'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Switch } from '@/components/ui/switch'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface LDAPImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LDAPImportDialog({
  open,
  onOpenChange,
}: LDAPImportDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [users, setUsers] = useState<LDAPImportCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [enableImported, setEnableImported] = useState(false)
  const [importing, setImporting] = useState(false)

  // 草稿就是「勾了哪些账号」：搜索词只是筛选条件，开关是跨次保留的偏好，
  // 关掉弹窗都不会丢，所以都不计入；有改动时由 useUnsavedChangesGuard
  // 拦截遮罩点击 / Esc / 右上角 X。Set 不能直接 JSON 比较，排序后按数组比。
  const isDraftDirty = useDraftDirty([...selected].sort(), [])
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setSelected(new Set())
    setSearch('')
    fetchLDAPImportCandidates()
      .then((candidates) => {
        if (!cancelled) setUsers(candidates)
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(translateError(err, t))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, t])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        (u.displayName || '').toLowerCase().includes(q)
    )
  }, [users, search])

  const selectableCount = useMemo(
    () => filtered.filter((u) => !u.imported && !u.conflict).length,
    [filtered]
  )

  const toggle = (u: LDAPImportCandidate) => {
    if (u.imported || u.conflict) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(u.username)) {
        next.delete(u.username)
      } else {
        next.add(u.username)
      }
      return next
    })
  }

  const selectAllSelectable = () => {
    setSelected(
      new Set(
        filtered
          .filter((u) => !u.imported && !u.conflict)
          .map((u) => u.username)
      )
    )
  }

  const clearSelection = () => setSelected(new Set())

  const handleImport = async () => {
    if (selected.size === 0) {
      toast.warning(
        t('authenticationManagement.ldap.import.noSelection', {
          defaultValue: 'Select at least one user to import.',
        })
      )
      return
    }
    setImporting(true)
    try {
      const result = await importLDAPUsers(Array.from(selected), enableImported)
      const refreshed = await fetchLDAPImportCandidates()
      setUsers(refreshed)
      setSelected(new Set())
      toast.success(
        t('authenticationManagement.ldap.import.summary', {
          created: result.created,
          updated: result.updated,
          conflicted: result.conflicted,
          notFound: result.notFound,
          failed: result.failed,
          defaultValue:
            '{{created}} created, {{updated}} updated, {{conflicted}} skipped (conflict), {{notFound}} not found, {{failed}} failed',
        })
      )
      queryClient.invalidateQueries({ queryKey: ['user-list'] })
      queryClient.invalidateQueries({ queryKey: ['ldap-setting'] })
    } catch {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <IconUserPlus className="h-5 w-5" />
              <DialogTitle>
                {t(
                  'authenticationManagement.ldap.import.title',
                  'Import LDAP Users'
                )}
              </DialogTitle>
            </div>
            <DialogDescription>
              {t(
                'authenticationManagement.ldap.import.description',
                'Select directory users to provision. Imported users are created locally and kept in sync afterwards by the periodic sync.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t(
                    'authenticationManagement.ldap.import.searchPlaceholder',
                    'Search username or name...'
                  )}
                  className="pl-9"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={selectAllSelectable}
                disabled={selectableCount === 0}
              >
                {t('authenticationManagement.ldap.import.selectAll', {
                  defaultValue: 'Select all ({{count}})',
                  count: selectableCount,
                })}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearSelection}
                disabled={selected.size === 0}
              >
                {t('authenticationManagement.ldap.import.clear', {
                  defaultValue: 'Clear',
                })}
              </Button>
            </div>

            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <Label className="text-sm">
                  {t('authenticationManagement.ldap.import.enableImported', {
                    defaultValue: 'Enable imported users',
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'authenticationManagement.ldap.import.enableImportedHint',
                    {
                      defaultValue: 'New users are disabled by default.',
                    }
                  )}
                </p>
              </div>
              <Switch
                checked={enableImported}
                onCheckedChange={setEnableImported}
              />
            </div>

            {loading && (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {t('common.messages.loading', 'Loading...')}
              </div>
            )}
            {!loading && loadError && (
              <div className="text-center py-8 text-sm text-destructive">
                {loadError}
              </div>
            )}
            {!loading && !loadError && filtered.length === 0 && (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {t('authenticationManagement.ldap.import.noCandidates', {
                  defaultValue: 'No directory users found.',
                })}
              </div>
            )}

            {!loading && !loadError && filtered.length > 0 && (
              <div className="max-h-80 overflow-auto rounded-md border divide-y">
                {filtered.map((u) => {
                  const disabled = u.imported || u.conflict
                  const checked = selected.has(u.username)
                  return (
                    <label
                      key={u.username}
                      className={`flex items-center gap-3 px-3 py-2 ${
                        disabled
                          ? 'opacity-60 cursor-not-allowed'
                          : 'cursor-pointer'
                      }`}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => toggle(u)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {u.username}
                        </p>
                        {u.displayName && (
                          <p className="truncate text-xs text-muted-foreground">
                            {u.displayName}
                          </p>
                        )}
                      </div>
                      {u.imported && (
                        <Badge variant="secondary">
                          {t('authenticationManagement.ldap.import.imported', {
                            defaultValue: 'Imported',
                          })}
                        </Badge>
                      )}
                      {u.conflict && (
                        <Badge variant="outline">
                          {t('authenticationManagement.ldap.import.conflict', {
                            defaultValue: 'Username taken by another source',
                          })}
                        </Badge>
                      )}
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          <DialogFooter className="items-center">
            <span className="mr-auto text-xs text-muted-foreground">
              {t('authenticationManagement.ldap.import.selectedCount', {
                count: selected.size,
                defaultValue: '{{count}} selected',
              })}
            </span>
            <Button
              variant="outline"
              onClick={() => guard.handleOpenChange(false)}
              disabled={importing}
            >
              {t('common.actions.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={handleImport}
              disabled={importing || selected.size === 0}
            >
              {importing
                ? t('authenticationManagement.ldap.import.importing', {
                    defaultValue: 'Importing...',
                  })
                : t('authenticationManagement.ldap.import.import', {
                    defaultValue: 'Import',
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}
