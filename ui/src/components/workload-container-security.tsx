import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import type { Container } from 'kubernetes-types/core/v1'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type OnUpdate = (updates: Partial<Container>) => void

const intOrUndefined = (value: string) => {
  if (!value.trim()) return undefined
  const num = Number(value)
  return Number.isNaN(num) ? undefined : num
}

const splitList = (value: string) =>
  value.split(',').map((s) => s.trim()).filter(Boolean)

/** 资源: GPU limit (nvidia.com/gpu). */
export function GpuEditor({
  gpu,
  onChange,
}: {
  gpu?: string
  onChange: (gpu: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-normal text-muted-foreground">
        {t('containerAdv.gpu', 'NVIDIA GPU 限制/预留')}
      </Label>
      <div className="flex gap-2">
        <Input
          type="number"
          min={0}
          value={gpu || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="1"
          className="h-9"
        />
        <span className="flex items-center text-xs text-muted-foreground">GPU</span>
      </div>
    </div>
  )
}

function BoolGroup({
  value,
  onChange,
  noLabel,
  yesLabel,
  disabled = false,
}: {
  value?: boolean
  onChange: (v: boolean | undefined) => void
  noLabel: string
  yesLabel: string
  disabled?: boolean
}) {
  // Each BoolGroup needs its own radio group name: deriving it from the label
  // made every group share one name, so the browser treated them as a single
  // group and the choices interfered with each other.
  const groupName = useId()
  const current = value === true ? 'yes' : 'no'
  return (
    <div className="space-y-1.5">
      {[
        { v: 'no', label: noLabel },
        { v: 'yes', label: yesLabel },
      ].map((opt) => (
        <label
          key={opt.v}
          className={cn(
            'flex items-start gap-2 text-sm',
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
          )}
        >
          <input
            type="radio"
            name={groupName}
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={current === opt.v}
            disabled={disabled}
            onChange={() => onChange(opt.v === 'yes')}
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  )
}

/** 安全性上下文: container securityContext. */
export function SecurityContextEditor({
  container,
  onUpdate,
}: {
  container: Container
  onUpdate: OnUpdate
}) {
  const { t } = useTranslation()
  const sc = container.securityContext || {}
  const capabilities = sc.capabilities
  const privileged = sc.privileged === true

  const patch = (updates: Record<string, unknown>) =>
    onUpdate({
      securityContext: { ...sc, ...updates } as Container['securityContext'],
    })

  return (
    <div className="space-y-4">
      <h4 className="text-base font-medium">
        {t('containerAdv.securityTitle', '安全性上下文')}
      </h4>
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
        <div className="min-h-[88px] space-y-1.5">
          <Label className="text-xs font-normal text-muted-foreground">Privileged</Label>
          <BoolGroup
            value={sc.privileged}
            onChange={(v) =>
              patch({
                privileged: v,
                // A privileged container already has unrestricted access, so
                // allowPrivilegeEscalation is meaningless: clear it instead of
                // emitting a conflicting security context.
                ...(v ? { allowPrivilegeEscalation: undefined } : {}),
              })
            }
            noLabel={t('containerAdv.no', '否')}
            yesLabel={t('containerAdv.privilegedYes', '是：容器可以完全访问主机')}
          />
        </div>
        <div className="min-h-[88px] space-y-1.5">
          <Label className="text-xs font-normal text-muted-foreground">
            {t('containerAdv.privilegeEscalation', '允许权限提升')}
          </Label>
          <BoolGroup
            value={privileged ? undefined : sc.allowPrivilegeEscalation}
            onChange={(v) => patch({ allowPrivilegeEscalation: v })}
            noLabel={t('containerAdv.no', '否')}
            yesLabel={t('containerAdv.escalationYes', '是：容器可以获得比其父进程更多的权限')}
            disabled={privileged}
          />
          {privileged && (
            <p className="text-xs text-muted-foreground">
              {t(
                'containerAdv.escalationDisabledByPrivileged',
                '特权容器已拥有全部权限，该配置不再生效。'
              )}
            </p>
          )}
        </div>
        <div className="min-h-[88px] space-y-1.5">
          <Label className="text-xs font-normal text-muted-foreground">
            {t('containerAdv.runAsNonRoot', '以非 Root 方式运行')}
          </Label>
          <BoolGroup
            value={sc.runAsNonRoot}
            onChange={(v) => patch({ runAsNonRoot: v })}
            noLabel={t('containerAdv.no', '否')}
            yesLabel={t('containerAdv.nonRootYes', '是：容器必须以非 Root 用户的身份运行')}
          />
        </div>
        <div className="min-h-[88px] space-y-1.5">
          <Label className="text-xs font-normal text-muted-foreground">
            {t('containerAdv.readOnlyRootFs', '只读根文件系统')}
          </Label>
          <BoolGroup
            value={sc.readOnlyRootFilesystem}
            onChange={(v) => patch({ readOnlyRootFilesystem: v })}
            noLabel={t('containerAdv.no', '否')}
            yesLabel={t('containerAdv.readOnlyYes', '是：容器只有一个只读的根文件系统')}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-normal text-muted-foreground">{t('containerAdv.runAsUser', '以用户 ID 运行')}</Label>
          <Input
            type="number"
            min={0}
            value={sc.runAsUser ?? ''}
            onChange={(e) => patch({ runAsUser: intOrUndefined(e.target.value) })}
            className="h-9"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-normal text-muted-foreground">
            {t('containerAdv.addCapabilities', '添加 Capabilities')}
          </Label>
          <Input
            value={(capabilities?.add || []).join(', ')}
            onChange={(e) =>
              patch({
                capabilities: {
                  add: splitList(e.target.value),
                  drop: capabilities?.drop || [],
                },
              })
            }
            placeholder="NET_ADMIN, SYS_TIME"
            autoComplete="off"
            spellCheck={false}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-normal text-muted-foreground">
            {t('containerAdv.dropCapabilities', '移除 Capabilities')}
          </Label>
          <Input
            value={(capabilities?.drop || []).join(', ')}
            onChange={(e) =>
              patch({
                capabilities: {
                  add: capabilities?.add || [],
                  drop: splitList(e.target.value),
                },
              })
            }
            placeholder="ALL"
            autoComplete="off"
            spellCheck={false}
            className="h-9"
          />
        </div>
      </div>
    </div>
  )
}

/** 存储: volume mounts for a container. */
export function StorageMountsEditor({
  container,
  volumes,
  onUpdate,
}: {
  container: Container
  volumes: Array<{ name: string }>
  onUpdate: OnUpdate
}) {
  const { t } = useTranslation()
  const mounts = container.volumeMounts || []

  const updateMount = (index: number, patch: Record<string, unknown>) => {
    onUpdate({
      volumeMounts: mounts.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    })
  }

  return (
    <div className="space-y-2">
      <h4 className="text-base font-medium">
        {t('containerAdv.mountsTitle', '存储挂载')}
      </h4>
      {volumes.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t('containerAdv.noVolumesHint', '请先在 Pod 页的存储中添加存储卷。')}
        </p>
      )}
      {mounts.map((mount, index) => (
        <div
          key={index}
          className="grid grid-cols-[150px_minmax(0,1fr)_120px_70px_auto] items-center gap-2"
        >
          <Select value={mount.name} onValueChange={(v) => updateMount(index, { name: v })}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder={t('workloadWizard.volumeName', '卷名称')} />
            </SelectTrigger>
            <SelectContent>
              {volumes.map((v) => (
                <SelectItem key={v.name} value={v.name}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={mount.mountPath}
            onChange={(e) => updateMount(index, { mountPath: e.target.value })}
            placeholder={t('containerAdv.mountPath', '挂载路径')}
            className="h-9"
          />
          <Input
            value={mount.subPath || ''}
            onChange={(e) => updateMount(index, { subPath: e.target.value || undefined })}
            placeholder={t('containerAdv.subPath', '子路径')}
            className="h-9"
          />
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={!!mount.readOnly}
              onChange={(e) => updateMount(index, { readOnly: e.target.checked })}
            />
            {t('containerAdv.readOnly', '只读')}
          </label>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => onUpdate({ volumeMounts: mounts.filter((_, i) => i !== index) })}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={volumes.length === 0}
        onClick={() =>
          onUpdate({
            volumeMounts: [
              ...mounts,
              { name: volumes[0]?.name || '', mountPath: '', readOnly: false },
            ],
          })
        }
      >
        {t('containerAdv.addMount', '添加挂载')}
      </Button>
    </div>
  )
}

/** 生命周期钩子: postStart / preStop. */
export function LifecycleEditor({
  container,
  onUpdate,
}: {
  container: Container
  onUpdate: OnUpdate
}) {
  const { t } = useTranslation()
  const lifecycle = container.lifecycle || {}

  const renderHook = (kind: 'postStart' | 'preStop') => {
    type HookHandler = {
      exec?: { command?: string[] }
      httpGet?: { path?: string; port?: number }
    }
    const handler = (lifecycle[kind] as HookHandler | undefined) || undefined
    const execCommand = (handler?.exec?.command || []).join(' ')
    const httpPath = handler?.httpGet?.path || ''
    const httpPort =
      typeof handler?.httpGet?.port === 'number' ? handler.httpGet.port : ''
    const type = handler?.exec ? 'exec' : handler?.httpGet ? 'http' : 'none'

    const setHandler = (next: Record<string, unknown> | undefined) =>
      onUpdate({
        lifecycle: { ...lifecycle, [kind]: next } as Container['lifecycle'],
      })

    return (
      <div key={kind} className="space-y-2">
        <h5 className="text-sm font-medium">
          {kind === 'postStart' ? 'postStart' : 'PreStop'}
        </h5>
        {(
          [
            ['none', t('containerAdv.hookNone', '无')],
            ['exec', t('containerAdv.hookExec', '添加要执行的命令')],
            ['http', t('containerAdv.hookHttp', '创建 HTTP 请求')],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="radio"
              name={`lifecycle-${kind}`}
              className="h-3.5 w-3.5 accent-primary"
              checked={type === value}
              onChange={() => {
                if (value === 'none') return setHandler(undefined)
                if (value === 'exec') return setHandler({ exec: { command: [] } })
                return setHandler({ httpGet: { path: '/', port: 80 } })
              }}
            />
            {label}
          </label>
        ))}
        {handler?.exec && (
          <Input
            value={execCommand}
            onChange={(e) =>
              setHandler({ exec: { command: e.target.value.split(' ').filter(Boolean) } })
            }
            placeholder="echo hello"
            className="h-8 max-w-md"
          />
        )}
        {handler?.httpGet && (
          <div className="grid max-w-md grid-cols-[minmax(0,1fr)_110px] gap-2">
            <Input
              value={httpPath}
              onChange={(e) =>
                setHandler({
                  httpGet: {
                    ...(handler.httpGet as Record<string, unknown>),
                    path: e.target.value,
                  },
                })
              }
              placeholder="/startup"
              className="h-9"
            />
            <Input
              type="number"
              value={httpPort}
              onChange={(e) =>
                setHandler({
                  httpGet: {
                    ...(handler.httpGet as Record<string, unknown>),
                    port: intOrUndefined(e.target.value) ?? 0,
                  },
                })
              }
              className="h-9"
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h4 className="text-base font-medium">
        {t('containerAdv.lifecycleTitle', '生命周期钩子')}
      </h4>
      <div className="grid grid-cols-1 gap-x-10 gap-y-5 lg:grid-cols-2">
        {renderHook('postStart')}
        {renderHook('preStop')}
      </div>
    </div>
  )
}
