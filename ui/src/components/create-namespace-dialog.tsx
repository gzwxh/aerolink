import { useCallback, useState } from 'react'
import { IconLoader2 } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { createResource, type NamespaceBindingOutcome } from '@/lib/api'
import { DESCRIPTION_ANNOTATION } from '@/lib/k8s'
import { translateError } from '@/lib/utils'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
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
import { Textarea } from '@/components/ui/textarea'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

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

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [quota, setQuota] = useState<QuotaFormValues>(emptyQuota)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')

  // 表单本身就是草稿：弹窗随 open 条件挂载，首帧的空表单即基线；
  // 关闭统一走 guard，避免点遮罩 / 按 Esc / 点 X 直接丢掉已填内容。
  const isDirty = useDraftDirty({ name, description, quota })
  const close = useCallback(() => onClose(), [onClose])
  const guard = useUnsavedChangesGuard({ dirty: isDirty, onClose: close })

  // 自动归属结论 → 提示。管理员创建的命名空间本就不自动归属，不额外提示（表单里的
  // 说明已交待过），避免每次建命名空间都弹一条无用信息。
  const notifyNamespaceBinding = (binding?: NamespaceBindingOutcome) => {
    if (!binding || binding.reason === 'administrator') {
      return
    }
    if (binding.bound && binding.method === 'binding_group') {
      toast.success(
        t('nsCreate.boundToBinding', {
          name: binding.bindingName || '',
          defaultValue: '已自动归属到权限绑定「{{name}}」',
        })
      )
      return
    }
    if (binding.bound && binding.method === 'role_namespaces') {
      toast.success(
        t('nsCreate.boundToRoles', {
          roles: (binding.roles || []).join('、'),
          defaultValue: '已把该命名空间加入角色「{{roles}}」的命名空间范围',
        })
      )
      return
    }
    toast.info(t('nsCreate.notBound', '未自动归属，请联系管理员分配'))
  }

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

      const created = await createResource('namespaces', undefined, {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: trimmedName, annotations },
      } as never)

      // 服务端返回的自动归属结论。命名空间的创建已收归管理员，而管理员创建的命名空间
      // 不参与自动归属，因此这条提示当前不会触发。
      notifyNamespaceBinding(created?.namespaceBinding)

      const hard = buildQuotaHard(quota)
      if (Object.keys(hard).length > 0) {
        await createResource('resourcequotas', trimmedName, {
          apiVersion: 'v1',
          kind: 'ResourceQuota',
          metadata: { name: `${trimmedName}-quota`, namespace: trimmedName },
          spec: { hard },
        } as never)
      }

      queryClient.invalidateQueries()
      toast.success(
        t('nsCreate.created', {
          name: trimmedName,
          defaultValue: 'Namespace {{name}} created',
        })
      )
      close()
    } catch (err) {
      setError(translateError(err, t))
    } finally {
      setIsCreating(false)
    }
  }

  const quotaFields: Array<[keyof QuotaFormValues, string, string]> = [
    ['cpuRequests', t('nsEdit.cpuRequests', 'CPU Requests'), 'mCPU'],
    ['cpuLimits', t('nsEdit.cpuLimits', 'CPU Limits'), 'mCPU'],
    ['memoryRequests', t('nsEdit.memoryRequests', 'Memory Requests'), 'MiB'],
    ['memoryLimits', t('nsEdit.memoryLimits', 'Memory Limits'), 'MiB'],
    ['gpuLimits', t('nsEdit.gpuLimits', 'GPU Limits'), 'GPU'],
  ]

  return (
    <>
      <Dialog open onOpenChange={guard.handleOpenChange}>
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

            <div className="space-y-1 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <p>
                {t(
                  'nsCreate.grantMovedHint',
                  '授权统一在「权限管理 → 权限绑定」中配置：把该命名空间归属到某个权限绑定，并把用户或用户组作为成员绑定角色。'
                )}
              </p>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => guard.handleOpenChange(false)}
              disabled={isCreating}
            >
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

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

export default CreateNamespaceDialog
