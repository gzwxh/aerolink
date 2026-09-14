import { useEffect, useState } from 'react'
import { IconLoader2 } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  assignRole,
  createResource,
  createRole,
  fetchKnownGroups,
  fetchUserList,
  updateRole,
  useRoleList,
} from '@/lib/api'
import { DESCRIPTION_ANNOTATION } from '@/lib/k8s'
import { resourceCatalog } from '@/lib/resource-catalog'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { MultiSelect } from '@/components/multi-select'

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

const VERB_SUGGESTIONS = [
  '*',
  'get',
  'create',
  'update',
  'delete',
  'log',
  'exec',
]

const RESOURCE_SUGGESTIONS = [
  '*',
  ...resourceCatalog
    .filter((resource) => resource.type !== 'crs')
    .map((resource) => resource.type),
]

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

function buildQuotaHard(values: QuotaFormValues): Record<string, string> {
  const hard: Record<string, string> = {}
  if (values.cpuRequests.trim())
    hard['requests.cpu'] = `${values.cpuRequests.trim()}m`
  if (values.cpuLimits.trim())
    hard['limits.cpu'] = `${values.cpuLimits.trim()}m`
  if (values.memoryRequests.trim())
    hard['requests.memory'] = `${values.memoryRequests.trim()}Mi`
  if (values.memoryLimits.trim())
    hard['limits.memory'] = `${values.memoryLimits.trim()}Mi`
  if (values.gpuLimits.trim()) {
    hard['limits.nvidia.com/gpu'] = values.gpuLimits.trim()
    hard['requests.nvidia.com/gpu'] = values.gpuLimits.trim()
  }
  return hard
}

export function CreateNamespaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentCluster } = useCluster()
  const { data: roles = [] } = useRoleList()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [quota, setQuota] = useState<QuotaFormValues>(emptyQuota)
  const [subjectType, setSubjectType] = useState<'user' | 'group'>('user')
  const [subjects, setSubjects] = useState<string[]>([])
  const [resources, setResources] = useState<string[]>(['*'])
  const [verbs, setVerbs] = useState<string[]>(['*'])
  const [userOptions, setUserOptions] = useState<string[]>([])
  const [groupOptions, setGroupOptions] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const users: string[] = []
        for (let page = 1; ; page++) {
          const res = await fetchUserList(page, 500, '')
          users.push(
            ...(res.users || [])
              .map((u) => u.username)
              .filter((n): n is string => Boolean(n))
          )
          if (users.length >= res.total || (res.users || []).length === 0) {
            break
          }
        }
        if (!cancelled) setUserOptions(users)
      } catch {
        if (!cancelled) setUserOptions([])
      }
      try {
        const groups = await fetchKnownGroups()
        if (!cancelled) setGroupOptions(groups)
      } catch {
        if (!cancelled) setGroupOptions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleCreate = async () => {
    const trimmedName = name.trim()
    if (!NAME_PATTERN.test(trimmedName)) {
      setError(
        t(
          'nsCreate.invalidName',
          'Name may only contain lowercase letters, numbers and dashes.'
        )
      )
      return
    }

    setIsCreating(true)
    setError('')
    try {
      const annotations: Record<string, string> = {}
      if (description.trim()) {
        annotations[DESCRIPTION_ANNOTATION] = description.trim()
      }

      await createResource('namespaces', undefined, {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: trimmedName, annotations },
      } as never)

      const hard = buildQuotaHard(quota)
      if (Object.keys(hard).length > 0) {
        await createResource('resourcequotas', trimmedName, {
          apiVersion: 'v1',
          kind: 'ResourceQuota',
          metadata: { name: `${trimmedName}-quota`, namespace: trimmedName },
          spec: { hard },
        } as never)
      }

      for (const subject of subjects) {
        // The role is named after the subject so it stays consistent with the
        // RBAC users / groups views.
        const roleName = subject
        const existing = roles.find((r) => r.name === roleName)
        if (existing?.isSystem) {
          throw new Error(
            t('nsPerm.systemRoleConflict', 'System roles cannot be modified.')
          )
        }

        let roleId: number
        if (!existing) {
          const resp = await createRole({
            name: roleName,
            description: t('nsPerm.autoRoleDescription', {
              namespace: trimmedName,
              defaultValue: 'Namespace grant for {{namespace}}',
            }),
            roleType: subjectType,
            clusters: currentCluster ? [currentCluster] : ['*'],
            namespaces: [trimmedName],
            resources,
            verbs,
          })
          roleId = resp.role.id
        } else {
          const namespaces = existing.namespaces.includes(trimmedName)
            ? existing.namespaces
            : [...existing.namespaces, trimmedName]
          const clusters =
            existing.clusters.includes('*') ||
            !currentCluster ||
            existing.clusters.includes(currentCluster)
              ? existing.clusters
              : [...existing.clusters, currentCluster]
          await updateRole(existing.id, {
            name: existing.name,
            description: existing.description,
            roleType: existing.roleType,
            clusters,
            namespaces,
            resources: existing.resources,
            verbs: existing.verbs,
          })
          roleId = existing.id
        }
        await assignRole(roleId, { subjectType, subject })
      }

      queryClient.invalidateQueries()
      toast.success(
        t('nsCreate.created', {
          name: trimmedName,
          defaultValue: 'Namespace {{name}} created',
        })
      )
      onClose()
    } catch (err) {
      setError(translateError(err, t))
    } finally {
      setIsCreating(false)
    }
  }

  const subjectOptions = subjectType === 'user' ? userOptions : groupOptions

  const quotaFields: Array<[keyof QuotaFormValues, string, string]> = [
    ['cpuRequests', t('nsEdit.cpuRequests', 'CPU Requests'), 'mCPU'],
    ['cpuLimits', t('nsEdit.cpuLimits', 'CPU Limits'), 'mCPU'],
    ['memoryRequests', t('nsEdit.memoryRequests', 'Memory Requests'), 'MiB'],
    ['memoryLimits', t('nsEdit.memoryLimits', 'Memory Limits'), 'MiB'],
    ['gpuLimits', t('nsEdit.gpuLimits', 'GPU Limits'), 'GPU'],
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('nsCreate.title', 'Create Namespace')}</DialogTitle>
          <DialogDescription>
            {t(
              'nsCreate.description',
              'Create a namespace with container resource limits and optional grants.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ns-create-name">
                {t('common.fields.name', 'Name')} *
              </Label>
              <Input
                id="ns-create-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t(
                  'nsCreate.namePlaceholder',
                  'Enter namespace name'
                )}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ns-create-desc">
                {t('nsCreate.descriptionLabel', 'Description')}
              </Label>
              <Textarea
                id="ns-create-desc"
                rows={1}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t(
                  'nsCreate.descPlaceholder',
                  'Enter an optional description'
                )}
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {quotaFields.map(([key, label, unit]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`ns-create-${key}`} className="text-xs">
                    {label}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`ns-create-${key}`}
                      value={quota[key]}
                      onChange={(e) =>
                        setQuota((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                      inputMode="numeric"
                      placeholder="0"
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {unit}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div>
              <div className="font-medium">
                {t('nsCreate.grantSection', 'Authorization (optional)')}
              </div>
              <p className="text-sm text-muted-foreground">
                {t(
                  'nsCreate.grantHint',
                  'Selected users/groups will be granted access to this namespace after creation.'
                )}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t('common.fields.subjectType', 'Subject Type')}</Label>
              <Select
                value={subjectType}
                onValueChange={(v) => {
                  setSubjectType(v as 'user' | 'group')
                  setSubjects([])
                }}
                disabled={isCreating}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">
                    {t('common.fields.user', 'User')}
                  </SelectItem>
                  <SelectItem value="group">
                    {t('common.fields.oidcGroup', 'LDAP / OIDC Group')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>
                {subjectType === 'user'
                  ? t('common.fields.users', 'Users')
                  : t('common.fields.oidcGroups', 'LDAP / OIDC Groups')}
              </Label>
              <MultiSelect
                key={subjectType}
                value={subjects}
                onChange={setSubjects}
                options={subjectOptions}
                selectAllMode="all"
                allowAdd={false}
                disabled={isCreating}
                placeholder={
                  subjectType === 'user'
                    ? t('common.placeholders.selectUsers', 'Select users...')
                    : t('common.placeholders.selectGroups', 'Select groups...')
                }
                emptyText={t(
                  'common.messages.noOptionsFound',
                  'No options found'
                )}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MultiSelect
                label={t('common.fields.resources', 'Resources')}
                value={resources}
                onChange={setResources}
                options={RESOURCE_SUGGESTIONS}
                placeholder={t(
                  'common.placeholders.resources',
                  'Select resources...'
                )}
                disabled={isCreating}
              />
              <MultiSelect
                label={t('common.fields.verbs', 'Verbs')}
                value={verbs}
                onChange={setVerbs}
                options={VERB_SUGGESTIONS}
                placeholder={t('common.placeholders.verbs', 'Select verbs...')}
                allowAdd={false}
                disabled={isCreating}
              />
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isCreating}>
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void handleCreate()} disabled={isCreating}>
            {isCreating && <IconLoader2 className="h-4 w-4 animate-spin" />}
            {isCreating
              ? t('common.actions.creating', 'Creating...')
              : t('common.actions.create', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default CreateNamespaceDialog
