import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import {
  IconCopy,
  IconDeviceFloppy,
  IconDownload,
  IconLoader2,
  IconPencil,
  IconShieldCheck,
  IconTrash,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  createResource,
  deleteResource,
  fetchResources,
  fetchRoleList,
  updateResource,
  updateRole,
} from '@/lib/api'
import { translateError } from '@/lib/utils'
import { useCluster } from '@/hooks/use-cluster'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CloneResourceDialog } from '@/components/clone-resource-dialog'
import { NamespacePermissionDialog } from '@/components/namespace-permission-dialog'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'

type MutableResource = Record<string, unknown> & {
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

// Resource kinds counted when confirming a namespace deletion.
const DELETE_WORKLOAD_TYPES = [
  'deployments',
  'statefulsets',
  'daemonsets',
  'cronjobs',
  'jobs',
  'pods',
  'services',
] as const

// ----- ResourceQuota helpers (container resource limits) -----

const QUOTA_KEYS = {
  cpuRequests: 'requests.cpu',
  cpuLimits: 'limits.cpu',
  memoryRequests: 'requests.memory',
  memoryLimits: 'limits.memory',
  gpuLimits: 'limits.nvidia.com/gpu',
  gpuRequests: 'requests.nvidia.com/gpu',
} as const

interface QuotaFormValues {
  cpuRequests: string
  cpuLimits: string
  memoryRequests: string
  memoryLimits: string
  gpuLimits: string
}

const emptyQuota: QuotaFormValues = {
  cpuRequests: '',
  cpuLimits: '',
  memoryRequests: '',
  memoryLimits: '',
  gpuLimits: '',
}

// "1000m" -> "1000", "1" -> "1000"
function parseCpu(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  if (value.endsWith('m')) return value.slice(0, -1)
  const cores = parseFloat(value)
  return Number.isNaN(cores) ? '' : String(Math.round(cores * 1000))
}

// "128Mi" -> "128", "1Gi" -> "1024"
function parseMemory(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const units: Array<[string, number]> = [
    ['Ki', 1 / 1024],
    ['Mi', 1],
    ['Gi', 1024],
  ]
  for (const [suffix, factor] of units) {
    if (value.endsWith(suffix)) {
      const n = parseFloat(value.slice(0, -suffix.length))
      return Number.isNaN(n) ? '' : String(Math.round(n * factor))
    }
  }
  const bytes = parseFloat(value)
  return Number.isNaN(bytes) ? '' : String(Math.round(bytes / (1024 * 1024)))
}

function quotaToForm(
  hard: Record<string, unknown> | undefined
): QuotaFormValues {
  if (!hard) return { ...emptyQuota }
  return {
    cpuRequests: parseCpu(hard[QUOTA_KEYS.cpuRequests]),
    cpuLimits: parseCpu(hard[QUOTA_KEYS.cpuLimits]),
    memoryRequests: parseMemory(hard[QUOTA_KEYS.memoryRequests]),
    memoryLimits: parseMemory(hard[QUOTA_KEYS.memoryLimits]),
    gpuLimits:
      typeof hard[QUOTA_KEYS.gpuLimits] === 'string'
        ? (hard[QUOTA_KEYS.gpuLimits] as string)
        : '',
  }
}

function buildQuotaHard(values: QuotaFormValues): Record<string, string> {
  const hard: Record<string, string> = {}
  const { cpuRequests, cpuLimits, memoryRequests, memoryLimits, gpuLimits } =
    values
  if (cpuRequests.trim())
    hard[QUOTA_KEYS.cpuRequests] = `${cpuRequests.trim()}m`
  if (cpuLimits.trim()) hard[QUOTA_KEYS.cpuLimits] = `${cpuLimits.trim()}m`
  if (memoryRequests.trim())
    hard[QUOTA_KEYS.memoryRequests] = `${memoryRequests.trim()}Mi`
  if (memoryLimits.trim())
    hard[QUOTA_KEYS.memoryLimits] = `${memoryLimits.trim()}Mi`
  if (gpuLimits.trim()) {
    hard[QUOTA_KEYS.gpuLimits] = gpuLimits.trim()
    hard[QUOTA_KEYS.gpuRequests] = gpuLimits.trim()
  }
  return hard
}

function pairsToText(record: Record<string, unknown> | undefined): string {
  if (!record) return ''
  return Object.entries(record)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n')
}

function textToPairs(text: string): Record<string, string> | null {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) return null
    result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return result
}

// After cloning a namespace, carry over role grants that reference the source
// namespace so the clone keeps the same permissions.
async function syncRoleNamespaces(source: string, target: string) {
  const roles = await fetchRoleList()
  const affected = (roles || []).filter((r) => r.namespaces?.includes(source))
  for (const role of affected) {
    await updateRole(role.id, {
      namespaces: [...(role.namespaces || []), target],
    })
  }
  return affected.length
}

function downloadNamespaceYaml(resource: unknown, name: string) {
  const content = yaml.dump(resource, { indent: 2, noRefs: true })
  const blob = new Blob([content], { type: 'application/x-yaml' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}-namespace.yaml`
  link.click()
  URL.revokeObjectURL(url)
}

export function NamespaceRowActions({
  name,
  resource,
}: {
  name: string
  resource: unknown
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [showEdit, setShowEdit] = useState(false)
  const [showYaml, setShowYaml] = useState(false)
  const [showClone, setShowClone] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showPermissions, setShowPermissions] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { currentCluster } = useCluster()
  const { user } = useAuth()
  const isAdmin = user?.isAdmin() ?? false

  const handleClone = async (targetName: string) => {
    const synced = await syncRoleNamespaces(name, targetName)
    if (synced > 0) {
      toast.success(
        t('nsActions.permissionsCloned', {
          count: synced,
          defaultValue: 'Cloned permissions from {{count}} role(s)',
        })
      )
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteResource('namespaces', name, undefined)
      toast.success(
        t('nsActions.deleted', {
          name,
          defaultValue: 'Namespace {{name}} deleted',
        })
      )
      setShowDelete(false)
      queryClient.invalidateQueries()
    } catch (err) {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {isAdmin && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
          title={t('nsActions.permissions', 'Manage permissions')}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setShowPermissions(true)
          }}
        >
          <IconShieldCheck className="h-3.5 w-3.5" />
          {t('nsActions.permissions', 'Permissions')}
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 px-0 text-muted-foreground hover:text-primary"
            aria-label={t('nsActions.moreActions', 'More actions')}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-lg leading-none tracking-tighter">⋮</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => setShowEdit(true)}>
            <IconPencil className="mr-2 h-4 w-4" />
            {t('nsActions.editConfig', 'Edit Configuration')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setShowYaml(true)}>
            <IconDeviceFloppy className="mr-2 h-4 w-4" />
            {t('nsActions.editYaml', 'Edit YAML')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setShowClone(true)}>
            <IconCopy className="mr-2 h-4 w-4" />
            {t('nsActions.clone', 'Clone')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => downloadNamespaceYaml(resource, name)}
          >
            <IconDownload className="mr-2 h-4 w-4" />
            {t('nsActions.downloadYaml', 'Download YAML')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setShowDelete(true)}
          >
            <IconTrash className="mr-2 h-4 w-4" />
            {t('common.actions.delete', 'Delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {showPermissions && (
        <NamespacePermissionDialog
          name={name}
          cluster={currentCluster ?? undefined}
          onClose={() => setShowPermissions(false)}
        />
      )}

      {showEdit && (
        <EditNamespaceDialog
          name={name}
          resource={resource as MutableResource}
          onClose={() => setShowEdit(false)}
        />
      )}

      {showYaml && (
        <EditNamespaceYamlDialog
          name={name}
          resource={resource as MutableResource}
          onClose={() => setShowYaml(false)}
        />
      )}

      {showClone && (
        <CloneResourceDialog
          open={showClone}
          onOpenChange={setShowClone}
          resourceType="namespaces"
          resourceLabel={t('common.fields.namespace', 'Namespace')}
          sourceName={name}
          resource={resource}
          onCloned={handleClone}
        />
      )}

      {showDelete && (
        <DeleteNamespaceDialog
          name={name}
          deleting={deleting}
          onConfirm={() => void handleDelete()}
          onClose={() => setShowDelete(false)}
        />
      )}
    </div>
  )
}

// ----- Edit configuration: metadata + container resource limits -----

export function EditNamespaceDialog({
  name,
  resource,
  onClose,
}: {
  name: string
  resource: MutableResource
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [labels, setLabels] = useState(() =>
    pairsToText(resource.metadata?.labels as Record<string, unknown>)
  )
  const [annotations, setAnnotations] = useState(() =>
    pairsToText(resource.metadata?.annotations as Record<string, unknown>)
  )
  const [quota, setQuota] = useState<QuotaFormValues>(emptyQuota)
  const [quotaName, setQuotaName] = useState<string | null>(null)
  const [quotaBase, setQuotaBase] = useState<MutableResource | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [loadingQuota, setLoadingQuota] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetchResources<{ items: MutableResource[] }>(
          'resourcequotas',
          name,
          { limit: 10 }
        )
        if (cancelled) return
        const existing = (res.items || [])[0]
        if (existing) {
          setQuotaName(String(existing.metadata?.name || ''))
          setQuotaBase(existing)
          setQuota(quotaToForm(existing.spec?.hard as Record<string, unknown>))
        }
      } catch {
        // No quota is fine; treat as empty.
      } finally {
        if (!cancelled) setLoadingQuota(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [name])

  const handleSave = async () => {
    setError('')

    const parsedLabels = textToPairs(labels)
    const parsedAnnotations = textToPairs(annotations)
    if (parsedLabels === null) {
      setError(t('nsEdit.invalidPairs', 'Labels must be key=value per line'))
      return
    }
    if (parsedAnnotations === null) {
      setError(
        t('nsEdit.invalidPairs', 'Annotations must be key=value per line')
      )
      return
    }

    setIsSaving(true)
    try {
      const updated: MutableResource = structuredClone(resource)
      const metadata = updated.metadata || {}
      const hadLabels = Object.keys(
        (metadata.labels as Record<string, unknown>) || {}
      ).length
      const hadAnnotations = Object.keys(
        (metadata.annotations as Record<string, unknown>) || {}
      ).length
      if (Object.keys(parsedLabels).length === 0 && hadLabels)
        delete metadata.labels
      else if (Object.keys(parsedLabels).length > 0)
        metadata.labels = parsedLabels
      if (Object.keys(parsedAnnotations).length === 0 && hadAnnotations)
        delete metadata.annotations
      else if (Object.keys(parsedAnnotations).length > 0)
        metadata.annotations = parsedAnnotations
      updated.metadata = metadata

      await updateResource('namespaces', name, undefined, updated)

      const hard = buildQuotaHard(quota)
      if (quotaBase) {
        const next: MutableResource = structuredClone(quotaBase)
        next.spec = { ...(next.spec || {}), hard }
        await updateResource('resourcequotas', quotaName!, name, next)
      } else if (Object.keys(hard).length > 0) {
        await createResource('resourcequotas', name, {
          apiVersion: 'v1',
          kind: 'ResourceQuota',
          metadata: { name: `${name}-quota`, namespace: name },
          spec: { hard },
        } as unknown as MutableResource)
      }

      toast.success(t('nsEdit.saved', 'Namespace updated'))
      onClose()
    } catch (err) {
      setError(translateError(err, t))
    } finally {
      setIsSaving(false)
    }
  }

  const quotaFields: Array<{
    key: keyof QuotaFormValues
    label: string
    unit: string
  }> = [
    {
      key: 'cpuRequests',
      label: t('nsEdit.cpuRequests', 'CPU Requests'),
      unit: 'mCPU',
    },
    {
      key: 'cpuLimits',
      label: t('nsEdit.cpuLimits', 'CPU Limits'),
      unit: 'mCPU',
    },
    {
      key: 'memoryRequests',
      label: t('nsEdit.memoryRequests', 'Memory Requests'),
      unit: 'MiB',
    },
    {
      key: 'memoryLimits',
      label: t('nsEdit.memoryLimits', 'Memory Limits'),
      unit: 'MiB',
    },
    {
      key: 'gpuLimits',
      label: t('nsEdit.gpuLimits', 'GPU Limits'),
      unit: 'GPU',
    },
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('nsEdit.title', { name, defaultValue: 'Edit {{name}}' })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'nsEdit.description',
              'Update namespace metadata and container resource limits.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('nsEdit.labels', 'Labels')}</Label>
              <Textarea
                rows={4}
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder={'app=my-app\nteam=devops'}
              />
              <p className="text-xs text-muted-foreground">
                {t('nsEdit.pairsHint', 'One key=value pair per line')}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t('nsEdit.annotations', 'Annotations')}</Label>
              <Textarea
                rows={4}
                value={annotations}
                onChange={(e) => setAnnotations(e.target.value)}
                placeholder={'owner=devops@example.com'}
              />
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div>
              <div className="font-medium">
                {t('nsEdit.quotaTitle', 'Container Resource Limits')}
              </div>
              <p className="text-sm text-muted-foreground">
                {t(
                  'nsEdit.quotaDescription',
                  'Configure the default resource quota for workloads in this namespace.'
                )}
              </p>
            </div>
            {loadingQuota ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <IconLoader2 className="h-4 w-4 animate-spin" />
                {t('common.messages.loading', 'Loading...')}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {quotaFields.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`quota-${field.key}`} className="text-xs">
                      {field.label}
                    </Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`quota-${field.key}`}
                        value={quota[field.key]}
                        onChange={(e) =>
                          setQuota((prev) => ({
                            ...prev,
                            [field.key]: e.target.value,
                          }))
                        }
                        inputMode="numeric"
                        placeholder="0"
                      />
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {field.unit}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving && <IconLoader2 className="h-4 w-4 animate-spin" />}
            {isSaving
              ? t('common.actions.saving', 'Saving...')
              : t('common.actions.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----- Edit YAML -----

function EditNamespaceYamlDialog({
  name,
  resource,
  onClose,
}: {
  name: string
  resource: MutableResource
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [yamlContent, setYamlContent] = useState(() =>
    yaml.dump(resource, { indent: 2, noRefs: true })
  )
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    setError('')
    let parsed: MutableResource
    try {
      const loaded = yaml.load(yamlContent)
      if (!loaded || typeof loaded !== 'object') {
        setError(t('cloneResource.invalidYaml', 'Invalid YAML'))
        return
      }
      parsed = loaded as MutableResource
    } catch {
      setError(t('cloneResource.invalidYaml', 'Invalid YAML'))
      return
    }

    setIsSaving(true)
    try {
      await updateResource('namespaces', name, undefined, parsed)
      toast.success(t('nsEdit.saved', 'Namespace updated'))
      onClose()
    } catch (err) {
      setError(translateError(err, t))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {t('nsActions.editYamlTitle', {
              name,
              defaultValue: 'Edit YAML - {{name}}',
            })}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SimpleYamlEditor
            value={yamlContent}
            onChange={(value) => {
              setYamlContent(value || '')
              setError('')
            }}
            height="400px"
          />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving && <IconLoader2 className="h-4 w-4 animate-spin" />}
            {isSaving
              ? t('common.actions.saving', 'Saving...')
              : t('common.actions.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----- Delete with workload summary -----

export function DeleteNamespaceDialog({
  name,
  deleting,
  onConfirm,
  onClose,
}: {
  name: string
  deleting: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const results = await Promise.allSettled(
        DELETE_WORKLOAD_TYPES.map((type) =>
          fetchResources<{ items: unknown[] }>(type, name, { limit: 500 })
        )
      )
      if (cancelled) return
      const next: Record<string, number> = {}
      DELETE_WORKLOAD_TYPES.forEach((type, i) => {
        const result = results[i]
        next[type] =
          result.status === 'fulfilled' ? (result.value.items || []).length : -1
      })
      setCounts(next)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [name])

  const total = counts
    ? Object.values(counts).reduce((sum, n) => sum + Math.max(n, 0), 0)
    : 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('nsDelete.title', {
              name,
              defaultValue: 'Delete namespace {{name}}?',
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'nsDelete.description',
              'Deleting a namespace permanently removes all resources inside it.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border">
            <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
              {t('nsDelete.workloadTitle', 'Resources that will be deleted')}
            </div>
            {loading ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                {t('common.messages.loading', 'Loading...')}
              </div>
            ) : (
              <div className="divide-y">
                {DELETE_WORKLOAD_TYPES.map((type) => (
                  <div
                    key={type}
                    className="flex items-center justify-between px-3 py-1.5 text-sm"
                  >
                    <span className="capitalize">{type}</span>
                    <span className="text-muted-foreground">
                      {counts && counts[type] >= 0 ? counts[type] : '-'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {!loading && total > 0 && (
            <p className="text-sm font-medium text-destructive">
              {t('nsDelete.totalWarning', {
                count: total,
                defaultValue:
                  '{{count}} resource(s) will be permanently deleted!',
              })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            {deleting
              ? t('common.actions.deleting', 'Deleting...')
              : t('common.actions.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
