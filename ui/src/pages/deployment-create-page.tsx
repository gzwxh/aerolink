import { useEffect, useMemo, useRef, useState } from 'react'
import { IconAlertCircle } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as YAML from 'js-yaml'
import { ArrowLeft, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import {
  applyResource,
  deleteResource,
  useResource,
  useResources,
} from '@/lib/api'
import { prepareCloneResource } from '@/lib/clone-manifest'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { cn, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { usePageTitle } from '@/hooks/use-page-title'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsTrigger } from '@/components/ui/tabs'
import {
  applyEditedManifest,
  buildServiceDocuments,
  createDefaultContainer,
  defaultNetwork,
  generateWorkloadYaml,
  hasInvalidPorts,
  hostPathTypeOptions,
  initialFormData,
  parseYamlToFormData,
  StrategyForm,
  validateStep,
  VolumeForm,
  workloadWithServiceDocs,
  type DeploymentFormData,
  type VolumeSourceType,
  type WorkloadResourceType,
} from '@/components/editors/deployment-form'
import { EnvironmentEditor } from '@/components/editors/environment-editor'
import { ImageEditor } from '@/components/editors/image-editor'
import { LabelSelectorEditor } from '@/components/label-selector-editor'
import {
  NodeSchedulingBasic,
  PriorityEditor,
  TolerationsEditor,
} from '@/components/node-scheduling-parts'
import { NamespaceSelector } from '@/components/selector/namespace-selector'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'
import { StatefulServiceSelector } from '@/components/stateful-service-selector'
import { TabStrip } from '@/components/tab-strip'
import {
  CommandEditor,
  PortsEditor,
  ProbesEditor,
} from '@/components/workload-container-sections'
import {
  GpuEditor,
  LifecycleEditor,
  SecurityContextEditor,
  StorageMountsEditor,
} from '@/components/workload-container-security'

type MainTab = 'deployment' | 'pod' | 'yaml'
type DeploySection = 'labels' | 'strategy'
type PodSection =
  | 'labels'
  | 'scheduling'
  | 'network'
  | 'podScheduling'
  | 'resources'
  | 'grace'
  | 'security'
  | 'storage'

interface KVPair {
  key: string
  value: string
}

const KVEditor = ({
  title,
  hint,
  pairs,
  addLabel,
  onChange,
}: {
  title: string
  hint?: string
  pairs: KVPair[]
  addLabel: string
  onChange: (next: KVPair[]) => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="space-y-2">
        {pairs.map((pair, index) => (
          <div key={index} className="flex items-center gap-3">
            <Input
              value={pair.key}
              onChange={(e) =>
                onChange(
                  pairs.map((p, i) =>
                    i === index ? { ...p, key: e.target.value } : p
                  )
                )
              }
              placeholder={t('workloadWizard.labelKeyPlaceholder', '例如: foo')}
              className="h-9 min-w-0 flex-1"
            />
            <Input
              value={pair.value}
              onChange={(e) =>
                onChange(
                  pairs.map((p, i) =>
                    i === index ? { ...p, value: e.target.value } : p
                  )
                )
              }
              placeholder={t(
                'workloadWizard.labelValuePlaceholder',
                '例如: bar'
              )}
              className="h-9 min-w-0 flex-1"
            />
            <button
              type="button"
              className="shrink-0 text-sm text-primary transition-colors hover:underline"
              onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            >
              {t('workloadWizard.remove', '移除')}
            </button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
      >
        {addLabel}
      </Button>
    </div>
  )
}

const SectionMenu = ({
  items,
  value,
  onChange,
}: {
  items: Array<{ key: string; label: string }>
  value: string
  onChange: (key: string) => void
}) => (
  <nav className="w-40 shrink-0 space-y-0.5 rounded-md border bg-muted/20 p-1.5">
    {items.map((item) => (
      <button
        key={item.key}
        type="button"
        onClick={() => onChange(item.key)}
        className={`block w-full rounded px-2.5 py-1.5 text-left text-sm transition-colors ${
          value === item.key
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        }`}
      >
        {item.label}
      </button>
    ))}
  </nav>
)

/**
 * 独立的腾讯云风格工作负载创建页（取代了 Deployment 的
 * 向导对话框）：顶部是常驻的基本信息，下方是
 * Deployment / Pod / 容器 / YAML 配置的标签页。
 */
const KIND_LABELS: Partial<Record<WorkloadResourceType, string>> = {
  deployments: 'Deployment',
  pods: 'Pod',
  daemonsets: 'DaemonSet',
  statefulsets: 'StatefulSet',
  jobs: 'Job',
  cronjobs: 'CronJob',
}

interface DeploymentCreatePageProps {
  resourceType?: WorkloadResourceType
  /** 克隆路由（`…/:namespace/:name/clone`）设置：以源对象反显创建表单。 */
  clone?: boolean
}

/**
 * 工作负载表单页的入口：创建路由渲染它时没有
 * `:name` 参数，而编辑路由（`…/:namespace/:name/edit`）会提供一个，
 * 从而让页面切换为编辑已有对象；克隆路由（`…/clone`）则切换为
 * 以源对象反显的创建表单。
 */
export function DeploymentCreatePage({
  resourceType = 'deployments',
  clone = false,
}: DeploymentCreatePageProps = {}) {
  const { namespace, name } = useParams()
  if (name) {
    return clone ? (
      <DeploymentClonePage
        resourceType={resourceType}
        name={name}
        namespace={namespace || 'default'}
      />
    ) : (
      <DeploymentEditPage
        resourceType={resourceType}
        name={name}
        namespace={namespace || 'default'}
      />
    )
  }
  return <DeploymentFormPage resourceType={resourceType} />
}

/**
 * 编辑保存后需要删除的 Service：表单只会自动创建「负载名」「负载名-nodeport」
 * 「负载名-loadbalancer」三种名字（见 buildServiceDocuments）。把端口行从
 * NodePort 改成 ClusterIP 之类之后，apply 只更新 YAML 里仍在的文档，不再生成
 * 的旧 Service 会残留在集群里，还挂着同样的 selector——下一次进编辑页又把它
 * 反显回端口行，看起来就像「改了不生效」。这里只清理自动命名的 Service，
 * 手写的 Service 一律不动。
 */
function staleManagedServiceNames(
  formData: DeploymentFormData,
  originalManifest: Record<string, unknown> | undefined,
  liveServices: Array<Record<string, unknown>>
): string[] {
  const spec = (originalManifest?.spec || {}) as {
    selector?: { matchLabels?: Record<string, string> }
    template?: { metadata?: { labels?: Record<string, string> } }
  }
  // 与反显同一基准：Service selector 指向 Pod 标签（可能带 Rancher 等注入的
  // 额外键），合并 Pod 模板标签与工作负载 selector 判定。metadata.labels 也
  // 并进来：历史版本克隆生成的 Service selector 用的是源负载的 metadata 标签
  // （app: 源名），只有按它才能认领这些坏残留。
  const metadataLabels = ((originalManifest?.metadata || {}) as {
    labels?: Record<string, string>
  }).labels
  const matchLabels = {
    ...(metadataLabels || {}),
    ...(spec.template?.metadata?.labels || {}),
    ...(spec.selector?.matchLabels || {}),
  }
  if (Object.keys(matchLabels).length === 0) return []
  const generated = new Set(
    buildServiceDocuments(formData).map(
      (d) => String((d.metadata as Record<string, unknown>).name)
    )
  )
  const autoNames = new Set([
    formData.name,
    `${formData.name}-nodeport`,
    `${formData.name}-loadbalancer`,
  ])
  const stale: string[] = []
  for (const svc of liveServices) {
    const s = svc as {
      metadata?: { name?: unknown }
      spec?: { selector?: Record<string, string> }
    }
    const sel = s.spec?.selector || {}
    if (Object.keys(sel).length === 0) continue
    if (!Object.entries(sel).every(([k, v]) => matchLabels[k] === v)) continue
    const name = String(s.metadata?.name || '')
    if (autoNames.has(name) && !generated.has(name)) stale.push(name)
  }
  return stale
}

interface DeploymentFormPageProps {
  resourceType: WorkloadResourceType
  /** 编辑时设置：身份字段被锁定，保存即更新。 */
  editName?: string
  /** 克隆时设置：页面标题与返回目标指向源对象，其余行为与创建一致。 */
  cloneSourceName?: string
  /** 编辑/克隆模式下预填的表单状态。 */
  initialData?: DeploymentFormData
  /** 正在编辑（或克隆）的对象，用于保存时保留未建模的字段。 */
  originalManifest?: Record<string, unknown>
}

function DeploymentFormPage({
  resourceType,
  editName,
  cloneSourceName,
  initialData,
  originalManifest,
}: DeploymentFormPageProps) {
  const isEdit = !!editName
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const { namespace: namespaceParam } = useParams()
  const can = useCan()
  const [formData, setFormData] = useState<DeploymentFormData>(
    () =>
      initialData ?? {
        ...initialFormData,
        namespace: namespaceParam || searchParams.get('namespace') || 'default',
        ...(resourceType === 'cronjobs' ? { schedule: '*/5 * * * *' } : {}),
      }
  )
  // 编辑模式下取同命名空间的 Service 列表：保存成功后用于清理
  // 改型/删端口后不再生成的自动命名 Service（见 staleManagedServiceNames）。
  const editNamespace =
    ((originalManifest?.metadata as Record<string, unknown> | undefined)
      ?.namespace as string | undefined) || formData.namespace
  const { data: liveServices } = useResources('services', editNamespace, {
    disable: !isEdit,
  })
  const [activeTab, setActiveTab] = useState<MainTab | number>(() => {
    const tabParam = searchParams.get('tab')
    if (tabParam === 'pod') return 'pod'
    if (tabParam === 'yaml') return 'yaml'
    const match = tabParam?.match(/^container-(\d+)$/)
    if (match) {
      const index = Number(match[1])
      if (index >= 0 && index < formData.containers.length) return index
    }
    // Pod 没有 Deployment 标签页，因此显式的 `?tab=deployment` 不能让
    // 页面停留在没有对应触发器的分区上。
    return resourceType === 'pods' ? 'pod' : 'deployment'
  })
  const [deploySection, setDeploySection] = useState<DeploySection>('labels')
  const [podSection, setPodSection] = useState<PodSection>('labels')
  const [containerSection, setContainerSection] = useState(
    'general' as 'general' | 'health' | 'resources' | 'security' | 'storage'
  )
  const [editedYaml, setEditedYaml] = useState('')
  // 表单或 YAML 草稿只要离开过初始快照就算「未保存」：切换集群前据此弹确认
  // （登记处见 lib/unsaved-edits）。
  const [formSnapshot] = useState(() =>
    JSON.stringify({ formData, editedYaml })
  )
  useUnsavedEdits(JSON.stringify({ formData, editedYaml }) !== formSnapshot)
  const yamlSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 待执行的反向同步不能在页面销毁后仍被触发。
  useEffect(
    () => () => {
      if (yamlSyncTimer.current) clearTimeout(yamlSyncTimer.current)
    },
    []
  )
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const kindLabel = KIND_LABELS[resourceType] || resourceType
  const pageTitle = isEdit
    ? t('workloadWizard.editPageTitle', {
        kind: kindLabel,
        defaultValue: `${kindLabel}: 编辑`,
      })
    : cloneSourceName
      ? t('workloadWizard.clonePageTitle', {
          kind: kindLabel,
          name: cloneSourceName,
          defaultValue: `${kindLabel}: 从 ${cloneSourceName} 克隆`,
        })
      : t('workloadWizard.pageTitle', {
          kind: kindLabel,
          defaultValue: `${kindLabel}: 创建`,
        })
  usePageTitle(pageTitle)

  const update = (updates: Partial<DeploymentFormData>) =>
    setFormData((prev) => ({ ...prev, ...updates }))

  const currentYaml = useMemo(
    () => generateWorkloadYaml(formData, resourceType),
    [formData, resourceType]
  )
  // 手写的 YAML 会原样应用；由表单重新生成的 manifest
  // 会叠加到线上对象上，使表单未建模的字段得以保留。
  const finalYaml = useMemo(() => {
    if (editedYaml) return editedYaml
    if (!originalManifest) return currentYaml
    try {
      return applyEditedManifest(currentYaml, originalManifest)
    } catch {
      return currentYaml
    }
  }, [editedYaml, currentYaml, originalManifest])

  // 把标签保留在 URL 中，刷新后能重新打开同一分区。
  const setTab = (tab: MainTab | number) => {
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams)
    params.set('tab', typeof tab === 'number' ? `container-${tab}` : tab)
    setSearchParams(params, { replace: true })
  }

  // 当用户手工编辑过 YAML 后，它就成为事实来源：
  // 跳过表单校验（真正被应用的是那份 YAML 文档）。
  const yamlOverrides = editedYaml.trim().length > 0
  const isValid = useMemo(() => {
    if (yamlOverrides) {
      try {
        const docs = YAML.loadAll(finalYaml)
        return docs.length > 0 && docs[0] && typeof docs[0] === 'object'
      } catch {
        return false
      }
    }
    if (!formData.name || !formData.namespace) return false
    // 已经缩容到 0 副本的工作负载是可以编辑的合法状态。
    if (!isEdit && formData.replicas <= 0) return false
    if (!formData.labels.every((l) => l.key && l.value)) return false
    if (!formData.containers.every((c) => c.image && c.name)) return false
    // 卷的来源字段（主机路径、NFS 服务器/路径、CSI 驱动…）缺一不可：留空会生成
    // 一个 API 直接拒绝的空来源，不如在这里拦住并指出是哪一项。
    if (!validateStep(formData, 2)) return false
    // 端口行里的容器端口 / 静态 IP 写错时，生成的 Service 会少掉这个端口或直接被拒。
    if (hasInvalidPorts(formData)) return false
    if (resourceType === 'statefulsets' && !formData.serviceName?.trim())
      return false
    if (resourceType === 'cronjobs' && !formData.schedule?.trim()) return false
    return true
  }, [yamlOverrides, finalYaml, formData, resourceType, isEdit])

  // 把选中的命名空间保留在 URL 中，刷新后仍指向同一
  // 目标，而不会回退到 `default`。
  const namespaceCreatePath = (namespace: string) => {
    const tabValue =
      typeof activeTab === 'number' ? `container-${activeTab}` : activeTab
    return `/${resourceType}/${encodeURIComponent(namespace)}/create?tab=${tabValue}`
  }

  // 表单里的命名空间会覆盖手工编辑 manifest 中的命名空间
  // （apply_handler.go 会依据请求设置 obj.Namespace），因此它也是
  // 权限校验必须跟随的命名空间。
  const targetNamespace = formData.namespace
  const canSubmit = can(resourceType, isEdit ? 'update' : 'create', {
    namespace: targetNamespace,
  })

  const handleSubmit = async () => {
    if (!isValid) {
      // 明确指出缺失的字段，让提示条可操作，
      // 而不是笼统地"请补全表单"。
      const missing: string[] = []
      if (!formData.name.trim()) {
        missing.push(t('workloadWizard.fieldName', '名称'))
      }
      if (!formData.namespace.trim()) {
        missing.push(t('workloadWizard.namespace', '命名空间'))
      }
      if (!isEdit && formData.replicas <= 0) {
        missing.push(t('workloadWizard.replicas', '副本数量'))
      }
      if (resourceType === 'statefulsets' && !formData.serviceName?.trim()) {
        missing.push(t('workloadWizard.serviceName', '服务名称'))
      }
      if (resourceType === 'cronjobs' && !formData.schedule?.trim()) {
        missing.push(t('workloadWizard.schedule', '调度周期 (Cron)'))
      }
      if (!formData.containers.every((c) => c.image && c.name)) {
        missing.push(t('workloadWizard.imageLabel', '容器镜像'))
      }
      if (!formData.labels.every((l) => l.key && l.value)) {
        missing.push(t('workloadWizard.labelSection', '标签'))
      }
      if (!validateStep(formData, 2)) {
        missing.push(t('workloadWizard.volumeSection', '存储卷'))
      }
      if (hasInvalidPorts(formData)) {
        missing.push(t('workloadWizard.networkSection', '网络'))
      }
      const message = missing.length
        ? t('workloadWizard.requiredFields', {
            fields: missing.join('、'),
            defaultValue: `「${missing.join('、')}」是必填项。`,
          })
        : t('workloadWizard.invalidForm', '请完善必填信息后再创建')
      setCreateError(message)
      toast.error(message)
      return
    }
    setIsCreating(true)
    setCreateError(null)
    try {
      await applyResource(finalYaml, formData.namespace)
      // apply 只创建/更新 YAML 里仍在的文档：把端口行从 NodePort 改成
      // ClusterIP 后，旧的 name-nodeport 不会自己消失。这里显式删掉
      // 不再生成的自动命名 Service，避免残留对象把下一次反显拉回旧状态。
      if (isEdit && originalManifest) {
        const stale = staleManagedServiceNames(
          formData,
          originalManifest,
          (liveServices || []) as Array<Record<string, unknown>>
        )
        const results = await Promise.allSettled(
          stale.map((svcName) =>
            deleteResource('services', svcName, formData.namespace)
          )
        )
        if (results.some((r) => r.status === 'rejected')) {
          toast.warning(
            t(
              'workloadWizard.staleServiceCleanupFailed',
              '部分不再使用的 Service 清理失败，可在 Service 列表中手动删除'
            )
          )
        }
      }
      queryClient.invalidateQueries()
      toast.success(t('common.messages.applied', 'Applied successfully'))
      // 返回到（刚创建或刚编辑过的）对象详情页。
      navigate(
        `/${resourceType}/${formData.namespace}/${isEdit ? editName : formData.name}`
      )
    } catch (err) {
      const msg = translateError(err, t)
      setCreateError(msg)
    } finally {
      setIsCreating(false)
    }
  }

  const addContainer = () => {
    const nextIndex = formData.containers.length
    setFormData((prev) => ({
      ...prev,
      containers: [
        ...prev.containers,
        createDefaultContainer(prev.containers.length),
      ],
    }))
    setTab(nextIndex)
  }

  // 让选中的标签保持在仍然存在的容器上：删除之后
  // 落到相邻容器（最后一个被删掉时则落到 Pod 标签页），
  // 而不是一个会渲染空白面板的失效索引。
  const removeContainer = (index: number) => {
    const nextCount = formData.containers.length - 1
    setFormData((prev) => ({
      ...prev,
      containers: prev.containers.filter((_, i) => i !== index),
    }))
    if (nextCount <= 0) {
      setTab('pod')
      return
    }
    setTab(Math.min(index, nextCount - 1))
  }

  const updateContainer = (
    index: number,
    updates: Partial<DeploymentFormData['containers'][number]>
  ) => {
    setFormData((prev) => ({
      ...prev,
      containers: prev.containers.map((c, i) =>
        i === index ? { ...c, ...updates } : c
      ),
    }))
  }

  // 由选中的标签推导当前容器，使两者不会
  // 出现偏差——索引过期会渲染错误的容器，
  // 或在容器被删除后什么都不渲染。
  const activeTabValue =
    typeof activeTab === 'number' ? `container-${activeTab}` : activeTab
  const activeContainer =
    typeof activeTab === 'number' &&
    activeTab >= 0 &&
    activeTab < formData.containers.length
      ? activeTab
      : 0
  const container = formData.containers[activeContainer]

  const containerTabs = formData.containers.map((c, i) => ({
    key: `container-${i}`,
    label: c.name || `container-${i}`,
    index: i,
  }))

  const selectTab = (value: string) => {
    const match = value.match(/^container-(\d+)$/)
    setTab(match ? Number(match[1]) : (value as MainTab))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t('common.actions.backToList', '返回列表')}
          title={t('common.actions.backToList', '返回列表')}
          onClick={() =>
            isEdit || cloneSourceName
              ? navigate(
                  `/${resourceType}/${targetNamespace}/${cloneSourceName || editName}`
                )
              : navigate(`/${resourceType}`)
          }
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{pageTitle}</h1>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {/* Basic info: namespace / name / description on one row, then replicas */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr]">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('workloadWizard.namespace')} *</Label>
            <NamespaceSelector
              selectedNamespace={formData.namespace}
              handleNamespaceChange={(ns) => {
                const next = ns || 'default'
                update({ namespace: next })
                navigate(namespaceCreatePath(next), { replace: true })
              }}
              triggerClassName="w-full sm:w-full sm:max-w-none"
              disabled={isEdit}
              modal
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('workloadWizard.name', { kind: '' })} *
            </Label>
            <div className="relative">
              <Input
                value={formData.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder={t('workloadWizard.namePlaceholder', 'unique-name')}
                className={cn('h-9', !formData.name && 'border-destructive')}
                disabled={isEdit}
              />
              {!formData.name && (
                <IconAlertCircle className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-destructive" />
              )}
            </div>
          </div>
          {(resourceType === 'deployments' ||
            resourceType === 'statefulsets') && (
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('workloadWizard.replicas', '副本数量')} *
              </Label>
              <Input
                type="number"
                min={0}
                value={formData.replicas}
                onChange={(e) =>
                  update({ replicas: Number(e.target.value) || 0 })
                }
                className="h-9"
              />
            </div>
          )}
          {resourceType === 'statefulsets' && (
            <StatefulServiceSelector
              namespace={formData.namespace}
              value={formData.serviceName || ''}
              onChange={(serviceName) => update({ serviceName })}
            />
          )}
          {resourceType === 'cronjobs' && (
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('workloadWizard.schedule', '调度周期 (Cron)')} *
              </Label>
              <Input
                value={formData.schedule || ''}
                onChange={(e) => update({ schedule: e.target.value })}
                placeholder="*/5 * * * *"
                className="h-9"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('workloadWizard.description', '描述')}
            </Label>
            <Input
              value={formData.description}
              onChange={(e) => update({ description: e.target.value })}
              placeholder={t(
                'workloadWizard.descriptionPlaceholder',
                '输入可以描述该资源的文本'
              )}
              className="h-9"
            />
          </div>
        </div>

        {/* Main tabs */}
        <Tabs value={activeTabValue} onValueChange={selectTab}>
          <TabStrip>
            {resourceType !== 'pods' && (
              <TabsTrigger value="deployment">
                {KIND_LABELS[resourceType] || 'Workload'}
              </TabsTrigger>
            )}
            <TabsTrigger value="pod">Pod</TabsTrigger>
            {containerTabs.map((tab) => (
              <div key={tab.key} className="flex h-11 items-center">
                <TabsTrigger value={tab.key} className="pr-1">
                  {tab.label}
                </TabsTrigger>
                {formData.containers.length > 1 && (
                  <button
                    type="button"
                    aria-label={t('workloadWizard.removeContainer', {
                      index: tab.index + 1,
                    })}
                    title={t('workloadWizard.removeContainer', {
                      index: tab.index + 1,
                    })}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    onClick={() => removeContainer(tab.index)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={addContainer}
              className="flex h-11 shrink-0 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('workloadWizard.addContainer', '添加容器')}
            </button>
            <TabsTrigger value="yaml">
              {t('workloadWizard.stepYaml', 'YAML')}
            </TabsTrigger>
          </TabStrip>
        </Tabs>

        {/* Tab content */}
        <div className="pb-4">
          {/* ---------- Deployment tab ---------- */}
          {activeTab === 'deployment' && (
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              <SectionMenu
                items={[
                  {
                    key: 'labels',
                    label: t('workloadWizard.labelsAnnotations', '标签 & 注释'),
                  },
                  {
                    key: 'strategy',
                    label: t('workloadWizard.strategyMenu', '扩缩容和升级策略'),
                  },
                ]}
                value={deploySection}
                onChange={(key) => setDeploySection(key as DeploySection)}
              />
              <div className="min-w-0 flex-1 rounded-md border p-4">
                {deploySection === 'labels' && (
                  <div className="space-y-6">
                    <h3 className="text-base font-medium">
                      {t('workloadWizard.labelsAnnotations', '标签 & 注释')}
                    </h3>
                    <LabelSelectorEditor
                      title={t('workloadWizard.labelSection', '标签')}
                      hint={t(
                        'workloadWizard.labelsHint',
                        '键值对，是附加到指定标识属性的对象。'
                      )}
                      pairs={formData.labels}
                      addLabel={t('workloadWizard.addLabel', '添加标签')}
                      namespace={formData.namespace}
                      onChange={(labels) => update({ labels })}
                    />
                    <KVEditor
                      title={t('workloadWizard.annotationSection', '注释')}
                      pairs={formData.annotations}
                      addLabel={t('workloadWizard.addAnnotation', '添加注释')}
                      onChange={(annotations) => update({ annotations })}
                    />
                  </div>
                )}
                {deploySection === 'strategy' &&
                  (resourceType === 'deployments' ||
                  resourceType === 'statefulsets' ? (
                    <StrategyFormView
                      strategy={formData.strategy}
                      variant={
                        resourceType === 'statefulsets'
                          ? 'statefulset'
                          : 'deployment'
                      }
                      onChange={(strategy) => update({ strategy })}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t(
                        'workloadWizard.strategyNotAvailable',
                        '该资源类型不支持升级策略配置。'
                      )}
                    </p>
                  ))}
              </div>
            </div>
          )}

          {/* ---------- Pod tab ---------- */}
          {activeTab === 'pod' && (
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              <SectionMenu
                items={[
                  {
                    key: 'labels',
                    label: t('workloadWizard.labelsAnnotations', '标签 & 注释'),
                  },
                  {
                    key: 'network',
                    label: t('workloadWizard.networkMenu', '网络'),
                  },
                  {
                    key: 'scheduling',
                    label: t('workloadWizard.nodeSchedulingMenu', '节点调度'),
                  },
                  {
                    key: 'podScheduling',
                    label: t('workloadWizard.podSchedulingMenu', 'Pod 调度'),
                  },
                  {
                    key: 'resources',
                    label: t('workloadWizard.resourcesMenu', '资源'),
                  },
                  {
                    key: 'grace',
                    label: t('workloadWizard.strategyMenu', '扩缩容和升级策略'),
                  },
                  {
                    key: 'security',
                    label: t('workloadWizard.securityMenu', '安全性上下文'),
                  },
                  {
                    key: 'storage',
                    label: t('workloadWizard.storageMenu', '存储'),
                  },
                ]}
                value={podSection}
                onChange={(key) => setPodSection(key as PodSection)}
              />
              <div className="min-w-0 flex-1 rounded-md border p-4">
                {podSection === 'labels' && (
                  <div className="space-y-6">
                    <LabelSelectorEditor
                      title={t('workloadWizard.podLabels', 'Pod 标签')}
                      hint={t(
                        'workloadWizard.podLabelsHint',
                        'Pod 标签会应用到新建的 Pod，并与选择器一起决定匹配关系。'
                      )}
                      pairs={formData.podLabels}
                      addLabel={t('workloadWizard.addLabel', '添加标签')}
                      namespace={formData.namespace}
                      onChange={(podLabels) => update({ podLabels })}
                    />
                    <KVEditor
                      title={t('workloadWizard.podAnnotations', 'Pod 注释')}
                      pairs={formData.podAnnotations}
                      addLabel={t('workloadWizard.addAnnotation', '添加注释')}
                      onChange={(podAnnotations) => update({ podAnnotations })}
                    />
                  </div>
                )}
                {podSection === 'scheduling' && (
                  <NodeSchedulingBasic
                    value={formData.podSpec.scheduling}
                    onChange={(scheduling) =>
                      setFormData((prev) => ({
                        ...prev,
                        podSpec: { ...prev.podSpec, scheduling },
                      }))
                    }
                  />
                )}
                {podSection === 'podScheduling' && (
                  <div className="space-y-3">
                    <h4 className="text-base font-medium">
                      {t('workloadWizard.podSchedulingTitle', 'Pod 调度')}
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'workloadWizard.podSchedulingHint',
                        '通过 nodeSelector 将 Pod 调度到带有匹配标签的节点。'
                      )}
                    </p>
                    {(formData.podSpec.nodeSelectorPairs || []).map(
                      (pair, i) => (
                        <div
                          key={i}
                          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3"
                        >
                          <div className="space-y-1.5">
                            <Label className="text-xs font-normal text-muted-foreground">
                              {t('workloadWizard.selectorKey', '键')}
                            </Label>
                            <Input
                              value={pair.key}
                              onChange={(e) =>
                                setFormData((prev) => ({
                                  ...prev,
                                  podSpec: {
                                    ...prev.podSpec,
                                    nodeSelectorPairs:
                                      prev.podSpec.nodeSelectorPairs.map(
                                        (p, j) =>
                                          j === i
                                            ? { ...p, key: e.target.value }
                                            : p
                                      ),
                                  },
                                }))
                              }
                              placeholder={t(
                                'workloadWizard.selectorKeyPlaceholder',
                                '例如: disktype'
                              )}
                              className="h-9"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-normal text-muted-foreground">
                              {t('workloadWizard.selectorValue', '值')}
                            </Label>
                            <Input
                              value={pair.value}
                              onChange={(e) =>
                                setFormData((prev) => ({
                                  ...prev,
                                  podSpec: {
                                    ...prev.podSpec,
                                    nodeSelectorPairs:
                                      prev.podSpec.nodeSelectorPairs.map(
                                        (p, j) =>
                                          j === i
                                            ? { ...p, value: e.target.value }
                                            : p
                                      ),
                                  },
                                }))
                              }
                              placeholder={t(
                                'workloadWizard.selectorValuePlaceholder',
                                '例如: ssd'
                              )}
                              className="h-9"
                            />
                          </div>
                          <button
                            type="button"
                            className="flex h-9 shrink-0 items-center text-sm text-primary transition-colors hover:underline"
                            onClick={() =>
                              setFormData((prev) => ({
                                ...prev,
                                podSpec: {
                                  ...prev.podSpec,
                                  nodeSelectorPairs:
                                    prev.podSpec.nodeSelectorPairs.filter(
                                      (_, j) => j !== i
                                    ),
                                },
                              }))
                            }
                          >
                            {t('workloadWizard.remove', '移除')}
                          </button>
                        </div>
                      )
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
                      onClick={() =>
                        setFormData((prev) => ({
                          ...prev,
                          podSpec: {
                            ...prev.podSpec,
                            nodeSelectorPairs: [
                              ...(prev.podSpec.nodeSelectorPairs || []),
                              { key: '', value: '' },
                            ],
                          },
                        }))
                      }
                    >
                      {t('workloadWizard.addPodSelector', '添加 Pod 选择器')}
                    </Button>
                  </div>
                )}
                {podSection === 'resources' && (
                  <div className="space-y-6">
                    <TolerationsEditor
                      value={formData.podSpec.scheduling}
                      onChange={(scheduling) =>
                        setFormData((prev) => ({
                          ...prev,
                          podSpec: { ...prev.podSpec, scheduling },
                        }))
                      }
                    />
                    <div className="border-t pt-4">
                      <PriorityEditor
                        value={formData.podSpec.scheduling}
                        onChange={(scheduling) =>
                          setFormData((prev) => ({
                            ...prev,
                            podSpec: { ...prev.podSpec, scheduling },
                          }))
                        }
                      />
                    </div>
                  </div>
                )}
                {podSection === 'grace' && (
                  <div className="space-y-3">
                    <h4 className="text-base font-medium">
                      {t('workloadWizard.podGraceTitle', '扩缩容和升级策略')}
                    </h4>
                    <div className="max-w-xs space-y-1.5">
                      <Label className="text-xs">
                        {t('workloadWizard.terminationGrace', '终止宽限期(秒)')}
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        value={formData.podSpec.terminationGracePeriodSeconds}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            podSpec: {
                              ...prev.podSpec,
                              terminationGracePeriodSeconds: e.target.value,
                            },
                          }))
                        }
                        className="h-9"
                      />
                    </div>
                  </div>
                )}
                {podSection === 'security' && (
                  <div className="space-y-3">
                    <h4 className="text-base font-medium">
                      {t('workloadWizard.securityTitle', '安全性上下文')}
                    </h4>
                    <div className="max-w-xs space-y-1.5">
                      <Label className="text-xs">
                        {t('workloadWizard.fsGroup', 'Pod 文件系统组')}
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        value={formData.podSpec.fsGroup}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            podSpec: {
                              ...prev.podSpec,
                              fsGroup: e.target.value,
                            },
                          }))
                        }
                        placeholder={t(
                          'workloadWizard.fsGroupPlaceholder',
                          '文件系统组'
                        )}
                        className="h-9"
                      />
                    </div>
                  </div>
                )}
                {podSection === 'network' && (
                  <NetworkFormView
                    network={formData.podSpec.network}
                    onChange={(network) =>
                      setFormData((prev) => ({
                        ...prev,
                        podSpec: { ...prev.podSpec, network },
                      }))
                    }
                  />
                )}
                {podSection === 'storage' && (
                  <StorageFormView
                    formData={formData}
                    setFormData={setFormData}
                  />
                )}
              </div>
            </div>
          )}

          {/* ---------- Container tabs ---------- */}
          {typeof activeTab === 'number' && container && (
            <div
              key={activeContainer}
              className="flex flex-col gap-4 lg:flex-row lg:items-start"
            >
              <SectionMenu
                items={[
                  {
                    key: 'general',
                    label: t('workloadWizard.generalMenu', '通用'),
                  },
                  {
                    key: 'health',
                    label: t('workloadWizard.healthMenu', '健康检查'),
                  },
                  {
                    key: 'resources',
                    label: t('workloadWizard.resourcesMenu', '资源'),
                  },
                  {
                    key: 'security',
                    label: t('workloadWizard.securityMenu', '安全性上下文'),
                  },
                  {
                    key: 'storage',
                    label: t('workloadWizard.storageMenu', '存储'),
                  },
                ]}
                value={containerSection}
                onChange={(key) =>
                  setContainerSection(
                    key as
                      | 'general'
                      | 'health'
                      | 'resources'
                      | 'security'
                      | 'storage'
                  )
                }
              />
              <div className="min-w-0 flex-1 rounded-md border p-4">
                {containerSection === 'general' && (
                  <div className="space-y-6">
                    {/* 通用 */}
                    <div className="space-y-3">
                      <h4 className="text-base font-medium">
                        {t('workloadWizard.generalMenu', '通用')}
                      </h4>
                      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs">
                            {t('workloadWizard.containerName', '容器名称')}
                          </Label>
                          <Input
                            value={container.name}
                            onChange={(e) =>
                              updateContainer(activeContainer, {
                                name: e.target.value,
                                container: {
                                  ...container.container,
                                  name: e.target.value,
                                },
                              })
                            }
                            className="h-9"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">
                            {t('workloadWizard.containerKind', '容器类型')}
                          </Label>
                          <div className="flex h-9 items-center gap-6">
                            <label className="flex cursor-pointer items-center gap-2 text-sm">
                              <input
                                type="radio"
                                name="container-kind"
                                className="h-4 w-4 accent-primary"
                                checked={!!container.isInit}
                                onChange={() =>
                                  updateContainer(activeContainer, {
                                    isInit: true,
                                  })
                                }
                              />
                              {t('workloadWizard.initContainer', '初始化容器')}
                            </label>
                            <label className="flex cursor-pointer items-center gap-2 text-sm">
                              <input
                                type="radio"
                                name="container-kind"
                                className="h-4 w-4 accent-primary"
                                checked={!container.isInit}
                                onChange={() =>
                                  updateContainer(activeContainer, {
                                    isInit: false,
                                  })
                                }
                              />
                              {t('workloadWizard.appContainer', '标准容器')}
                            </label>
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'workloadWizard.initContainerHint',
                          '初始化容器在应用容器之前依次运行。'
                        )}
                      </p>
                    </div>

                    {/* 镜像 */}
                    <div className="space-y-3">
                      <h4 className="text-base font-medium">
                        {t('workloadWizard.imageSection', '镜像')}
                      </h4>
                      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
                        <ImageEditor
                          container={container.container}
                          onUpdate={(updates) =>
                            updateContainer(activeContainer, {
                              image: updates.image,
                              container: { ...container.container, ...updates },
                            })
                          }
                        />
                        <div className="space-y-2">
                          <Label>
                            {t('workloadWizard.pullPolicy', '镜像拉取策略')}
                          </Label>
                          <div className="flex h-9 items-center gap-3">
                            <Select
                              value={container.pullPolicy}
                              onValueChange={(v) =>
                                updateContainer(activeContainer, {
                                  pullPolicy: v as typeof container.pullPolicy,
                                })
                              }
                            >
                              <SelectTrigger className="h-9 w-40 shrink-0">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Always">Always</SelectItem>
                                <SelectItem value="IfNotPresent">
                                  IfNotPresent
                                </SelectItem>
                                <SelectItem value="Never">Never</SelectItem>
                              </SelectContent>
                            </Select>
                            <p className="min-w-0 text-xs text-muted-foreground">
                              {container.pullPolicy === 'Never'
                                ? t(
                                    'workloadWizard.neverDesc',
                                    'Never：从不拉取，仅使用本地镜像'
                                  )
                                : container.pullPolicy === 'IfNotPresent'
                                  ? t(
                                      'workloadWizard.ifNotPresentDesc',
                                      'IfNotPresent：仅本地不存在时拉取镜像'
                                    )
                                  : t(
                                      'workloadWizard.alwaysDesc',
                                      'Always：始终拉取最新镜像'
                                    )}
                            </p>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>
                            {t('workloadWizard.pullSecret', '拉取凭据')}
                          </Label>
                          <PullSecretSelector
                            namespace={formData.namespace}
                            value={formData.podSpec.imagePullSecrets?.[0] || ''}
                            onChange={(name) =>
                              setFormData((prev) => ({
                                ...prev,
                                podSpec: {
                                  ...prev.podSpec,
                                  imagePullSecrets: name ? [name] : [],
                                },
                              }))
                            }
                          />
                        </div>
                      </div>
                    </div>

                    <div className="border-t pt-4">
                      <PortsEditor
                        ports={container.ports}
                        workloadName={formData.name}
                        onUpdate={(ports) =>
                          updateContainer(activeContainer, { ports })
                        }
                      />
                    </div>

                    <div className="border-t pt-4">
                      <CommandEditor
                        container={container.container}
                        onUpdate={(updates) =>
                          updateContainer(activeContainer, {
                            container: { ...container.container, ...updates },
                          })
                        }
                      />
                    </div>

                    <div className="border-t pt-4">
                      <EnvironmentEditor
                        container={container.container}
                        namespace={formData.namespace}
                        onUpdate={(updates) =>
                          updateContainer(activeContainer, {
                            container: { ...container.container, ...updates },
                          })
                        }
                      />
                    </div>

                    <div className="border-t pt-4">
                      <LifecycleEditor
                        container={container.container}
                        onUpdate={(updates) =>
                          updateContainer(activeContainer, {
                            container: { ...container.container, ...updates },
                          })
                        }
                      />
                    </div>
                  </div>
                )}

                {containerSection === 'health' && (
                  <ProbesEditor
                    container={container.container}
                    onUpdate={(updates) =>
                      updateContainer(activeContainer, {
                        container: { ...container.container, ...updates },
                      })
                    }
                  />
                )}

                {containerSection === 'resources' && (
                  <div className="space-y-4">
                    <h4 className="text-base font-medium">
                      {t('workloadWizard.resourcesTitle', '资源配额')}
                    </h4>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {(
                        [
                          [
                            'requests.cpu',
                            t('workloadWizard.cpuRequest', 'CPU 预留'),
                          ],
                          [
                            'requests.memory',
                            t('workloadWizard.memRequest', '内存预留'),
                          ],
                          [
                            'limits.cpu',
                            t('workloadWizard.cpuLimit', 'CPU 限制'),
                          ],
                          [
                            'limits.memory',
                            t('workloadWizard.memLimit', '内存限制'),
                          ],
                        ] as Array<[string, string]>
                      ).map(([path, label]) => {
                        const [scope, field] = path.split('.') as [
                          'requests' | 'limits',
                          'cpu' | 'memory',
                        ]
                        return (
                          <div key={path} className="space-y-1.5">
                            <Label className="text-xs">{label}</Label>
                            <Input
                              value={container.resources[scope][field]}
                              onChange={(e) =>
                                updateContainer(activeContainer, {
                                  resources: {
                                    ...container.resources,
                                    [scope]: {
                                      ...container.resources[scope],
                                      [field]: e.target.value,
                                    },
                                  },
                                })
                              }
                              placeholder={field === 'cpu' ? '100m' : '128Mi'}
                              className="h-9"
                            />
                          </div>
                        )
                      })}
                    </div>
                    <div className="max-w-xs border-t pt-4">
                      <GpuEditor
                        gpu={container.gpu}
                        onChange={(gpu) =>
                          updateContainer(activeContainer, { gpu })
                        }
                      />
                    </div>
                  </div>
                )}

                {containerSection === 'security' && (
                  <SecurityContextEditor
                    container={container.container}
                    onUpdate={(updates) =>
                      updateContainer(activeContainer, {
                        container: { ...container.container, ...updates },
                      })
                    }
                  />
                )}

                {containerSection === 'storage' && (
                  <StorageMountsEditor
                    container={container.container}
                    volumes={(formData.podSpec.volumes || []).map((v) => ({
                      name: v.name,
                    }))}
                    onUpdate={(updates) =>
                      updateContainer(activeContainer, {
                        container: { ...container.container, ...updates },
                      })
                    }
                  />
                )}
              </div>
            </div>
          )}

          {/* ---------- YAML tab ---------- */}
          {activeTab === 'yaml' && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {t(
                  'workloadWizard.yamlTabHint',
                  '这是由上方配置生成的 YAML，可直接编辑。手动编辑后将以该 YAML 为准创建；返回修改表单会重新生成。'
                )}
              </p>
              <div className="min-h-[400px] rounded-md border">
                <SimpleYamlEditor
                  value={finalYaml}
                  onChange={(value) => {
                    const next = value || ''
                    // 表单重新生成 YAML 时 Monaco 会通过
                    // onChange 把受控的 value 回传；忽略
                    // 这些回传可以让表单保持权威。
                    if (next === finalYaml) return
                    // 立即保留输入的文字；对反向同步做防抖
                    // 让输入更顺畅。同步完成后该覆盖值会被
                    // 清除，之后表单的修改会重新生成 YAML。
                    setEditedYaml(next)
                    if (yamlSyncTimer.current)
                      clearTimeout(yamlSyncTimer.current)
                    yamlSyncTimer.current = setTimeout(() => {
                      if (value) {
                        setFormData((prev) =>
                          parseYamlToFormData(value, resourceType, prev)
                        )
                        setEditedYaml('')
                      }
                    }, 800)
                  }}
                  height="500px"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {createError && (
        <div className="rounded-md border border-destructive/40 border-l-4 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {createError}
        </div>
      )}

      {!canSubmit && (
        <div className="rounded-md border border-destructive/40 border-l-4 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {isEdit
            ? t('workloadWizard.noUpdatePermission', {
                kind: kindLabel,
                namespace: targetNamespace,
                defaultValue: `你没有权限在命名空间 {{namespace}} 中更新 {{kind}}。`,
              })
            : t('workloadWizard.noCreatePermission', {
                kind: kindLabel,
                namespace: targetNamespace,
                defaultValue: `你没有权限在命名空间 {{namespace}} 中创建 {{kind}}。`,
              })}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          onClick={() =>
            isEdit || cloneSourceName
              ? navigate(
                  `/${resourceType}/${targetNamespace}/${cloneSourceName || editName}`
                )
              : navigate(`/${resourceType}`)
          }
        >
          {t('common.actions.cancel', '取消')}
        </Button>
        {/* Kept clickable while invalid so the banner can name the missing fields. */}
        <Button onClick={handleSubmit} disabled={isCreating || !canSubmit}>
          {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit
            ? t('common.actions.save', '保存')
            : t('workloadWizard.createKind', {
                kind: kindLabel,
                defaultValue: `创建 ${kindLabel}`,
              })}
        </Button>
      </div>
    </div>
  )
}

/**
 * 加载正在编辑的对象，并把解析出的表单状态交给共享的
 * 表单页。表单用 initialData 初始化 useState，因此
 * 只在对象就绪后才挂载。
 */
function DeploymentEditPage({
  resourceType,
  name,
  namespace,
}: {
  resourceType: WorkloadResourceType
  name: string
  namespace: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, isError, error } = useResource(resourceType, name, namespace)
  // 创建时随工作负载一并落地的 Service 是独立对象：编辑时把它们查回来，
  // 与工作负载拼成多文档 YAML 一起反解析，否则「网络」区块永远显示「不创建服务」。
  const { data: services, error: servicesError } = useResources(
    'services',
    namespace,
    { disable: !data }
  )

  const initialData = useMemo(() => {
    if (!data) return null
    const docs = workloadWithServiceDocs(
      data as Record<string, unknown>,
      (services || []) as Array<Record<string, unknown>>
    )
    return parseYamlToFormData(
      docs.map((doc) => YAML.dump(doc)).join('---\n'),
      resourceType,
      {
        ...initialFormData,
        name,
        namespace,
      }
    )
  }, [data, services, resourceType, name, namespace])

  if (isError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{translateError(error, t)}</p>
        <Button
          variant="outline"
          onClick={() => navigate(`/${resourceType}/${namespace}/${name}`)}
        >
          {t('common.actions.cancel', '取消')}
        </Button>
      </div>
    )
  }

  // initialData 只在表单挂载时初始化一次：Service 列表还没取回就挂载的话，
  // 「网络」区块会永远停在「不创建服务」，晚到的反显不会再被应用。
  // 列表查询失败（如 RBAC 拒绝）时降级为「无 Service」，不卡住编辑页。
  if (!initialData || (services === undefined && !servicesError)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <DeploymentFormPage
      resourceType={resourceType}
      editName={name}
      initialData={initialData}
      originalManifest={data as Record<string, unknown>}
    />
  )
}

/**
 * 加载克隆源对象，把它预处理成克隆草稿（改名 + 剥离服务端字段 +
 * 对齐 selector，见 lib/clone-manifest）后交给与创建页相同的表单。
 * 保存走创建而不是更新，名称默认加 `-copy` 后缀且可改。
 */
function DeploymentClonePage({
  resourceType,
  name,
  namespace,
}: {
  resourceType: WorkloadResourceType
  name: string
  namespace: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, isError, error } = useResource(resourceType, name, namespace)
  const targetName = `${name}-copy`

  const cloneManifest = useMemo(
    () =>
      data
        ? (prepareCloneResource(
            data,
            resourceType,
            name,
            targetName
          ) as Record<string, unknown>)
        : null,
    [data, resourceType, name, targetName]
  )

  const initialData = useMemo(
    () =>
      cloneManifest
        ? parseYamlToFormData(YAML.dump(cloneManifest), resourceType, {
            ...initialFormData,
            name: targetName,
            namespace,
          })
        : null,
    [cloneManifest, resourceType, targetName, namespace]
  )

  if (isError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{translateError(error, t)}</p>
        <Button
          variant="outline"
          onClick={() => navigate(`/${resourceType}/${namespace}/${name}`)}
        >
          {t('common.actions.cancel', '取消')}
        </Button>
      </div>
    )
  }

  if (!initialData) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <DeploymentFormPage
      resourceType={resourceType}
      cloneSourceName={name}
      initialData={initialData}
      originalManifest={cloneManifest || undefined}
    />
  )
}

/** Number input with an attached unit chip (秒 / 版本), console style. */
function SuffixedNumberField({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string
  value: string
  suffix: string
  onChange: (next: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <div className="flex">
        <Input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 rounded-r-none"
        />
        <span className="flex h-9 w-11 shrink-0 items-center justify-center rounded-r-md border border-l-0 bg-muted/40 text-xs text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  )
}

/** 输入框与单位下拉框组合（Pods / %），控制台风格。 */
function QuantityField({
  label,
  value,
  unit,
  units,
  onValueChange,
  onUnitChange,
}: {
  label: string
  value: string
  unit: string
  units: Array<{ value: string; label: string }>
  onValueChange: (next: string) => void
  onUnitChange: (next: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <div className="flex">
        <Input
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className="h-9 rounded-r-none"
        />
        <Select value={unit} onValueChange={onUnitChange}>
          <SelectTrigger className="h-9 w-[88px] shrink-0 rounded-l-none border-l-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {units.map((u) => (
              <SelectItem key={u.value} value={u.value}>
                {u.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

function StrategyFormView({
  strategy,
  onChange,
  variant = 'deployment',
}: {
  strategy: StrategyForm
  onChange: (next: StrategyForm) => void
  /** StatefulSet 使用 OnDelete + partition，而不是 Recreate + maxSurge。 */
  variant?: 'deployment' | 'statefulset'
}) {
  const { t } = useTranslation()
  const isStatefulSet = variant === 'statefulset'
  const units = [
    { value: 'percent', label: '%' },
    { value: 'count', label: t('workloadWizard.unitPods', 'Pods') },
  ]
  return (
    <div className="space-y-5">
      <h4 className="text-base font-medium">
        {t('workloadWizard.strategyTitle', '扩缩容和升级策略')}
      </h4>
      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-2 text-sm leading-5">
          <input
            type="radio"
            name="strategy-type"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={strategy.type === 'RollingUpdate'}
            onChange={() => onChange({ ...strategy, type: 'RollingUpdate' })}
          />
          <span className="text-muted-foreground">
            {isStatefulSet
              ? t(
                  'workloadWizard.rollingUpdateSs',
                  '滚动升级：按序号从大到小逐个更新 Pod，可通过分区（partition）控制只更新部分 Pod。'
                )
              : t(
                  'workloadWizard.rollingUpdate',
                  '滚动升级：创建新 Pod，直到达到最大 Pod 数量（max surge）的值，然后再删除旧 Pod。停用的 pod 数量不能超过设定的最大不可用数量。'
                )}
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm leading-5">
          <input
            type="radio"
            name="strategy-type"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={strategy.type === 'Recreate'}
            onChange={() => onChange({ ...strategy, type: 'Recreate' })}
          />
          <span className="text-muted-foreground">
            {isStatefulSet
              ? t(
                  'workloadWizard.onDelete',
                  '删除重建（OnDelete）：默认使用当前模板，仅在手动删除 Pod 后才按新模板创建。'
                )
              : t(
                  'workloadWizard.recreate',
                  '重置创建：终止所有 Pod，然后启动新 Pod。'
                )}
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-x-3 gap-y-4 lg:grid-cols-2">
        {strategy.type === 'RollingUpdate' &&
          (isStatefulSet ? (
            <SuffixedNumberField
              label={t('workloadWizard.partition', '分区（partition）')}
              value={strategy.partition}
              suffix={t('workloadWizard.unitOrder', '序号')}
              onChange={(v) => onChange({ ...strategy, partition: v })}
            />
          ) : (
            <>
              <QuantityField
                label={t('workloadWizard.maxSurge', '最大 Pod 数量')}
                value={strategy.maxSurge}
                unit={strategy.maxSurgeUnit}
                units={units}
                onValueChange={(v) => onChange({ ...strategy, maxSurge: v })}
                onUnitChange={(v) =>
                  onChange({
                    ...strategy,
                    maxSurgeUnit: v as StrategyForm['maxSurgeUnit'],
                  })
                }
              />
              <QuantityField
                label={t('workloadWizard.maxUnavailable', '最大不可用数量')}
                value={strategy.maxUnavailable}
                unit={strategy.maxUnavailableUnit}
                units={units}
                onValueChange={(v) =>
                  onChange({ ...strategy, maxUnavailable: v })
                }
                onUnitChange={(v) =>
                  onChange({
                    ...strategy,
                    maxUnavailableUnit: v as StrategyForm['maxUnavailableUnit'],
                  })
                }
              />
            </>
          ))}
        <SuffixedNumberField
          label={t('workloadWizard.minReadySeconds', '最小缩短时长')}
          value={strategy.minReadySeconds}
          suffix={t('workloadWizard.unitSeconds', '秒')}
          onChange={(v) => onChange({ ...strategy, minReadySeconds: v })}
        />
        <SuffixedNumberField
          label={t('workloadWizard.revisionHistoryLimit', '修订历史记录限制')}
          value={strategy.revisionHistoryLimit}
          suffix={t('workloadWizard.unitRevisions', '版本')}
          onChange={(v) => onChange({ ...strategy, revisionHistoryLimit: v })}
        />
        {!isStatefulSet && (
          <SuffixedNumberField
            label={t('workloadWizard.progressDeadlineSeconds', '进展截止时间')}
            value={strategy.progressDeadlineSeconds}
            suffix={t('workloadWizard.unitSeconds', '秒')}
            onChange={(v) =>
              onChange({ ...strategy, progressDeadlineSeconds: v })
            }
          />
        )}
      </div>
    </div>
  )
}

/** 控制台风格字段：标签位于控件框内部。 */
function BoxedInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1.5 left-3 text-xs font-normal text-muted-foreground">
        {label}
      </span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-14 px-3 pt-6 pb-1.5"
      />
    </div>
  )
}

/** 控制台风格下拉：标签在值上方，二者都在触发器内。 */
function BoxedSelect({
  label,
  value,
  onValueChange,
  children,
}: {
  label: string
  value: string
  onValueChange: (next: string) => void
  children: React.ReactNode
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      {/* `h-14!` beats the trigger's `data-[size=default]:h-9`, otherwise the
          boxed select collapses to the default height. */}
      <SelectTrigger className="h-14! w-full px-3">
        <div className="flex flex-col items-start gap-0.5 text-left">
          <span className="text-xs font-normal text-muted-foreground">
            {label}
          </span>
          <SelectValue />
        </div>
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  )
}

function NetworkFormView({
  network,
  onChange,
}: {
  network: ReturnType<typeof defaultNetwork>
  onChange: (next: ReturnType<typeof defaultNetwork>) => void
}) {
  const { t } = useTranslation()
  const dns = network.dnsConfig
  const patch = (updates: Partial<ReturnType<typeof defaultNetwork>>) =>
    onChange({ ...network, ...updates })

  const addButton = (label: string, onClick: () => void) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
      onClick={onClick}
    >
      {label}
    </Button>
  )

  const removeButton = (onClick: () => void) => (
    <button
      type="button"
      className="shrink-0 text-sm text-primary transition-colors hover:underline"
      onClick={onClick}
    >
      {t('workloadWizard.remove', '移除')}
    </button>
  )

  return (
    <div className="space-y-6">
      <h4 className="text-base font-medium">
        {t('workloadWizard.networkTitle', '网络')}
      </h4>

      {/* 网络设置 */}
      <div className="space-y-3">
        <h5 className="text-sm font-medium">
          {t('workloadWizard.networkSettings', '网络设置')}
        </h5>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 lg:grid-cols-2">
          <BoxedSelect
            label={t('workloadWizard.networkMode', '网络模式')}
            value={network.hostNetwork ? 'host' : 'default'}
            onValueChange={(v) => patch({ hostNetwork: v === 'host' })}
          >
            <SelectItem value="default">
              {t('workloadWizard.networkModeDefault', '常规')}
            </SelectItem>
            <SelectItem value="host">
              {t('workloadWizard.networkModeHost', '主机网络')}
            </SelectItem>
          </BoxedSelect>
          <BoxedSelect
            label={t('workloadWizard.dnsPolicy', 'DNS 策略')}
            value={network.dnsPolicy || 'default'}
            onValueChange={(v) =>
              patch({ dnsPolicy: v === 'default' ? '' : v })
            }
          >
            <SelectItem value="default">
              {t('workloadWizard.dnsDefault', '集群优先 (ClusterFirst)')}
            </SelectItem>
            <SelectItem value="ClusterFirstWithHostNet">
              ClusterFirstWithHostNet
            </SelectItem>
            <SelectItem value="None">None</SelectItem>
          </BoxedSelect>
          <BoxedInput
            label={t('workloadWizard.hostname', '主机名')}
            value={network.hostname}
            onChange={(v) => patch({ hostname: v })}
            placeholder={t('workloadWizard.exampleWeb', '例如: web')}
          />
          <BoxedInput
            label={t('workloadWizard.subdomain', '子域')}
            value={network.subdomain}
            onChange={(v) => patch({ subdomain: v })}
            placeholder={t('workloadWizard.exampleWeb', '例如: web')}
          />
        </div>
      </div>

      {/* DNS */}
      <div className="space-y-4">
        <h5 className="text-sm font-medium">
          {t('workloadWizard.dnsSection', 'DNS')}
        </h5>
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 lg:grid-cols-2">
          <div className="space-y-2">
            <div className="text-sm">
              {t('workloadWizard.nameservers', '名称服务器')}
            </div>
            {dns.nameservers.map((value, index) => (
              <div key={index} className="flex items-center gap-3">
                <Input
                  value={value}
                  onChange={(e) =>
                    patch({
                      dnsConfig: {
                        ...dns,
                        nameservers: dns.nameservers.map((ns, i) =>
                          i === index ? e.target.value : ns
                        ),
                      },
                    })
                  }
                  placeholder="10.0.0.10"
                  className="h-9"
                />
                {removeButton(() =>
                  patch({
                    dnsConfig: {
                      ...dns,
                      nameservers: dns.nameservers.filter(
                        (_, i) => i !== index
                      ),
                    },
                  })
                )}
              </div>
            ))}
            {addButton(
              t('workloadWizard.addNameserver', '添加名称服务器'),
              () =>
                patch({
                  dnsConfig: { ...dns, nameservers: [...dns.nameservers, ''] },
                })
            )}
          </div>

          <div className="space-y-2">
            <div className="text-sm">
              {t('workloadWizard.searchDomains', '搜索域')}
            </div>
            {dns.searches.map((value, index) => (
              <div key={index} className="flex items-center gap-3">
                <Input
                  value={value}
                  onChange={(e) =>
                    patch({
                      dnsConfig: {
                        ...dns,
                        searches: dns.searches.map((s, i) =>
                          i === index ? e.target.value : s
                        ),
                      },
                    })
                  }
                  placeholder={t(
                    'workloadWizard.searchDomainPlaceholder',
                    '例如: cluster.local'
                  )}
                  className="h-9"
                />
                {removeButton(() =>
                  patch({
                    dnsConfig: {
                      ...dns,
                      searches: dns.searches.filter((_, i) => i !== index),
                    },
                  })
                )}
              </div>
            ))}
            {addButton(t('workloadWizard.addSearchDomain', '添加搜索域'), () =>
              patch({ dnsConfig: { ...dns, searches: [...dns.searches, ''] } })
            )}
          </div>

          <div className="space-y-2">
            <div className="text-sm">
              {t('workloadWizard.resolverOptions', '解析器选项')}
            </div>
            {dns.options.map((option, index) => (
              <div key={index} className="flex items-center gap-3">
                <Input
                  value={option.name}
                  onChange={(e) =>
                    patch({
                      dnsConfig: {
                        ...dns,
                        options: dns.options.map((o, i) =>
                          i === index ? { ...o, name: e.target.value } : o
                        ),
                      },
                    })
                  }
                  placeholder={t('workloadWizard.optionName', '名称')}
                  className="h-9"
                />
                <Input
                  value={option.value}
                  onChange={(e) =>
                    patch({
                      dnsConfig: {
                        ...dns,
                        options: dns.options.map((o, i) =>
                          i === index ? { ...o, value: e.target.value } : o
                        ),
                      },
                    })
                  }
                  placeholder={t('workloadWizard.optionValue', '值')}
                  className="h-9"
                />
                {removeButton(() =>
                  patch({
                    dnsConfig: {
                      ...dns,
                      options: dns.options.filter((_, i) => i !== index),
                    },
                  })
                )}
              </div>
            ))}
            {addButton(t('workloadWizard.addOption', '添加选项'), () =>
              patch({
                dnsConfig: {
                  ...dns,
                  options: [...dns.options, { name: '', value: '' }],
                },
              })
            )}
          </div>

          <div className="space-y-2">
            <div className="text-sm">
              {t('workloadWizard.hostAliases', '主机别名')}
            </div>
            {network.hostAliases.map((alias, index) => (
              <div key={index} className="flex items-center gap-3">
                <Input
                  value={alias.ip}
                  onChange={(e) =>
                    patch({
                      hostAliases: network.hostAliases.map((a, i) =>
                        i === index ? { ...a, ip: e.target.value } : a
                      ),
                    })
                  }
                  placeholder={t(
                    'workloadWizard.aliasIpPlaceholder',
                    '例如: 192.168.1.1'
                  )}
                  className="h-9"
                />
                <Input
                  value={alias.hostnames}
                  onChange={(e) =>
                    patch({
                      hostAliases: network.hostAliases.map((a, i) =>
                        i === index ? { ...a, hostnames: e.target.value } : a
                      ),
                    })
                  }
                  placeholder={t(
                    'workloadWizard.aliasHostnamesPlaceholder',
                    '主机名（逗号分隔）'
                  )}
                  className="h-9"
                />
                {removeButton(() =>
                  patch({
                    hostAliases: network.hostAliases.filter(
                      (_, i) => i !== index
                    ),
                  })
                )}
              </div>
            ))}
            {addButton(t('workloadWizard.addAlias', '添加别名'), () =>
              patch({
                hostAliases: [
                  ...network.hostAliases,
                  { ip: '', hostnames: '' },
                ],
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 「添加卷」菜单里的卷类型，顺序即菜单顺序。 */
const VOLUME_TYPE_ITEMS: Array<{
  value: VolumeSourceType
  labelKey: string
  fallback: string
}> = [
  {
    value: 'emptyDir',
    labelKey: 'workloadWizard.volumeTypeEmptyDir',
    fallback: '空目录',
  },
  {
    value: 'hostPath',
    labelKey: 'workloadWizard.volumeTypeHostPath',
    fallback: '主机路径（Bind-Mount）',
  },
  {
    value: 'configMap',
    labelKey: 'workloadWizard.volumeTypeConfigMap',
    fallback: 'ConfigMap',
  },
  {
    value: 'secret',
    labelKey: 'workloadWizard.volumeTypeSecret',
    fallback: '密文',
  },
  {
    value: 'pvc',
    labelKey: 'workloadWizard.volumeTypePvc',
    fallback: '持久卷声明',
  },
  {
    value: 'nfs',
    labelKey: 'workloadWizard.volumeTypeNfs',
    fallback: 'NFS',
  },
  {
    value: 'csi',
    labelKey: 'workloadWizard.volumeTypeCsi',
    fallback: 'CSI',
  },
]

/** hostPath 路径类型的文案：取值集合来自 `hostPathTypeOptions`。 */
const HOST_PATH_TYPE_LABEL_KEYS: Record<string, string> = {
  '': 'workloadWizard.hostPathTypeAny',
  DirectoryOrCreate: 'workloadWizard.hostPathTypeDirectoryOrCreate',
  Directory: 'workloadWizard.hostPathTypeDirectory',
  FileOrCreate: 'workloadWizard.hostPathTypeFileOrCreate',
  File: 'workloadWizard.hostPathTypeFile',
  Socket: 'workloadWizard.hostPathTypeSocket',
  CharDevice: 'workloadWizard.hostPathTypeCharDevice',
  BlockDevice: 'workloadWizard.hostPathTypeBlockDevice',
}

/** Radix Select 不接受空字符串 value，用这个哨兵表示「不指定路径类型」。 */
const HOST_PATH_TYPE_NONE = '__none__'

function VolumeField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

function StorageFormView({
  formData,
  setFormData,
}: {
  formData: DeploymentFormData
  setFormData: React.Dispatch<React.SetStateAction<DeploymentFormData>>
}) {
  const { t } = useTranslation()
  const volumes = formData.podSpec.volumes || []

  const patchVolumes = (updater: (list: VolumeForm[]) => VolumeForm[]) =>
    setFormData((prev) => ({
      ...prev,
      podSpec: {
        ...prev.podSpec,
        volumes: updater(prev.podSpec.volumes || []),
      },
    }))

  const patchOptions = (
    index: number,
    options: Partial<NonNullable<VolumeForm['options']>>
  ) =>
    patchVolumes((list) =>
      list.map((v, i) =>
        i === index ? { ...v, options: { ...v.options, ...options } } : v
      )
    )

  const patchAttributes = (
    index: number,
    updater: (
      list: Array<{ key: string; value: string }>
    ) => Array<{ key: string; value: string }>
  ) =>
    patchVolumes((list) =>
      list.map((v, i) =>
        i === index
          ? {
              ...v,
              options: {
                ...v.options,
                csiVolumeAttributes: updater(
                  v.options?.csiVolumeAttributes || []
                ),
              },
            }
          : v
      )
    )

  const typeLabel = (type: VolumeSourceType) => {
    const item = VOLUME_TYPE_ITEMS.find((i) => i.value === type)
    return item ? t(item.labelKey, item.fallback) : type
  }

  return (
    <div className="space-y-3">
      <h4 className="text-base font-medium">
        {t('workloadWizard.storageTitle', '存储')}
      </h4>
      {volumes.map((volume, index) => (
        <div key={index} className="rounded-md border p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {typeLabel(volume.sourceType)}
            </span>
            <button
              type="button"
              className="shrink-0 text-sm text-primary transition-colors hover:underline"
              onClick={() =>
                patchVolumes((list) => list.filter((_, i) => i !== index))
              }
            >
              {t('workloadWizard.remove', '移除')}
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <VolumeField label={t('workloadWizard.volumeName', '卷名称')}>
              <Input
                value={volume.name}
                onChange={(e) =>
                  patchVolumes((list) =>
                    list.map((v, i) =>
                      i === index ? { ...v, name: e.target.value } : v
                    )
                  )
                }
                placeholder={t('workloadWizard.exampleVolume', '例如: data')}
                className="h-9"
              />
            </VolumeField>
            {volume.sourceType === 'hostPath' && (
              <>
                <VolumeField label={t('workloadWizard.hostPath', '主机路径')}>
                  <Input
                    value={volume.options?.path || ''}
                    onChange={(e) =>
                      patchOptions(index, { path: e.target.value })
                    }
                    placeholder="/data"
                    className="h-9"
                  />
                </VolumeField>
                <VolumeField
                  label={t('workloadWizard.hostPathType', '路径类型')}
                >
                  <Select
                    value={volume.options?.hostPathType || HOST_PATH_TYPE_NONE}
                    onValueChange={(value) =>
                      patchOptions(index, {
                        hostPathType:
                          value === HOST_PATH_TYPE_NONE ? '' : value,
                      })
                    }
                  >
                    <SelectTrigger className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {hostPathTypeOptions.map((type) => (
                        <SelectItem
                          key={type || HOST_PATH_TYPE_NONE}
                          value={type || HOST_PATH_TYPE_NONE}
                        >
                          {type
                            ? t(HOST_PATH_TYPE_LABEL_KEYS[type], type)
                            : t(
                                'workloadWizard.hostPathTypeAny',
                                '任意路径：不需要检查目标路径'
                              )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </VolumeField>
              </>
            )}
            {volume.sourceType === 'configMap' && (
              <VolumeField
                label={t('workloadWizard.configMapName', 'ConfigMap 名称')}
              >
                <Input
                  value={volume.options?.configMapName || ''}
                  onChange={(e) =>
                    patchOptions(index, { configMapName: e.target.value })
                  }
                  className="h-9"
                />
              </VolumeField>
            )}
            {volume.sourceType === 'secret' && (
              <VolumeField
                label={t('workloadWizard.secretName', 'Secret 名称')}
              >
                <Input
                  value={volume.options?.secretName || ''}
                  onChange={(e) =>
                    patchOptions(index, { secretName: e.target.value })
                  }
                  className="h-9"
                />
              </VolumeField>
            )}
            {volume.sourceType === 'pvc' && (
              <VolumeField label={t('workloadWizard.pvcName', 'PVC 名称')}>
                <Input
                  value={volume.options?.claimName || ''}
                  onChange={(e) =>
                    patchOptions(index, { claimName: e.target.value })
                  }
                  placeholder={t('workloadWizard.examplePvc', '例如: my-pvc')}
                  className="h-9"
                />
              </VolumeField>
            )}
            {volume.sourceType === 'nfs' && (
              <>
                <VolumeField
                  label={t('workloadWizard.nfsServer', 'NFS 服务器')}
                >
                  <Input
                    value={volume.options?.nfsServer || ''}
                    onChange={(e) =>
                      patchOptions(index, { nfsServer: e.target.value })
                    }
                    placeholder={t(
                      'workloadWizard.nfsServerPlaceholder',
                      '例如: 10.0.0.1'
                    )}
                    className="h-9"
                  />
                </VolumeField>
                <VolumeField label={t('workloadWizard.nfsPath', '共享路径')}>
                  <Input
                    value={volume.options?.nfsPath || ''}
                    onChange={(e) =>
                      patchOptions(index, { nfsPath: e.target.value })
                    }
                    placeholder={t(
                      'workloadWizard.nfsPathPlaceholder',
                      '例如: /exports/data'
                    )}
                    className="h-9"
                  />
                </VolumeField>
                <label className="flex h-9 items-center gap-2 self-end text-sm">
                  <Checkbox
                    checked={volume.options?.nfsReadOnly === true}
                    onCheckedChange={(checked) =>
                      patchOptions(index, { nfsReadOnly: checked === true })
                    }
                  />
                  {t('workloadWizard.readOnlyMount', '以只读方式挂载')}
                </label>
              </>
            )}
            {volume.sourceType === 'csi' && (
              <>
                <VolumeField label={t('workloadWizard.csiDriver', 'CSI 驱动')}>
                  <Input
                    value={volume.options?.csiDriver || ''}
                    onChange={(e) =>
                      patchOptions(index, { csiDriver: e.target.value })
                    }
                    placeholder={t(
                      'workloadWizard.csiDriverPlaceholder',
                      '例如: disk.csi.everest.io'
                    )}
                    className="h-9"
                  />
                </VolumeField>
                <VolumeField
                  label={t('workloadWizard.csiFsType', '文件系统类型')}
                >
                  <Input
                    value={volume.options?.csiFsType || ''}
                    onChange={(e) =>
                      patchOptions(index, { csiFsType: e.target.value })
                    }
                    placeholder={t(
                      'workloadWizard.csiFsTypePlaceholder',
                      '例如: ext4'
                    )}
                    className="h-9"
                  />
                </VolumeField>
                <label className="flex h-9 items-center gap-2 self-end text-sm">
                  <Checkbox
                    checked={volume.options?.csiReadOnly === true}
                    onCheckedChange={(checked) =>
                      patchOptions(index, { csiReadOnly: checked === true })
                    }
                  />
                  {t('workloadWizard.readOnlyMount', '以只读方式挂载')}
                </label>
              </>
            )}
          </div>
          {volume.sourceType === 'csi' && (
            <div className="mt-3 space-y-2">
              <Label className="text-xs font-normal text-muted-foreground">
                {t('workloadWizard.csiVolumeAttributes', '卷属性')}
              </Label>
              {(volume.options?.csiVolumeAttributes || []).map((pair, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={pair.key}
                    onChange={(e) =>
                      patchAttributes(index, (attrs) =>
                        attrs.map((p, j) =>
                          j === i ? { ...p, key: e.target.value } : p
                        )
                      )
                    }
                    placeholder={t('workloadWizard.labelKey', '键')}
                    className="h-9 min-w-0 flex-1"
                  />
                  <Input
                    value={pair.value}
                    onChange={(e) =>
                      patchAttributes(index, (attrs) =>
                        attrs.map((p, j) =>
                          j === i ? { ...p, value: e.target.value } : p
                        )
                      )
                    }
                    placeholder={t('workloadWizard.labelValue', '值')}
                    className="h-9 min-w-0 flex-1"
                  />
                  <button
                    type="button"
                    className="shrink-0 text-sm text-primary transition-colors hover:underline"
                    onClick={() =>
                      patchAttributes(index, (attrs) =>
                        attrs.filter((_, j) => j !== i)
                      )
                    }
                  >
                    {t('workloadWizard.remove', '移除')}
                  </button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
                onClick={() =>
                  patchAttributes(index, (attrs) => [
                    ...attrs,
                    { key: '', value: '' },
                  ])
                }
              >
                {t('workloadWizard.addVolumeAttribute', '添加卷属性')}
              </Button>
            </div>
          )}
        </div>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
          >
            {t('workloadWizard.addVolume', '添加卷')}
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {VOLUME_TYPE_ITEMS.map((item) => (
            <DropdownMenuItem
              key={item.value}
              onSelect={() =>
                patchVolumes((list) => [
                  ...list,
                  { name: '', sourceType: item.value },
                ])
              }
            >
              {t(item.labelKey, item.fallback)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default DeploymentCreatePage

/** 拉取密钥选择器：该命名空间的 docker-registry secret。 */
function PullSecretSelector({
  namespace,
  value,
  onChange,
}: {
  namespace: string
  value: string
  onChange: (name: string) => void
}) {
  const { t } = useTranslation()
  const { data: secrets = [] } = useResources<'secrets'>('secrets', namespace, {
    staleTime: 30_000,
  })
  const names = secrets
    .map((s) => s.metadata?.name)
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b))

  return (
    <Select
      value={value || '__none__'}
      onValueChange={(v) => onChange(v === '__none__' ? '' : v)}
    >
      <SelectTrigger className="h-9">
        <SelectValue
          placeholder={t(
            'workloadWizard.pullSecretPlaceholder',
            '选择镜像拉取密文...'
          )}
        />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">
          {t('workloadWizard.none', '不设置')}
        </SelectItem>
        {names.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
