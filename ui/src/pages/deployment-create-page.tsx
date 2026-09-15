import { useEffect, useMemo, useRef, useState } from 'react'
import { IconAlertCircle } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as YAML from 'js-yaml'
import { ArrowLeft, Loader2, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { applyResource, useResources } from '@/lib/api'
import { cn, translateError } from '@/lib/utils'
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
import {
  createDefaultContainer,
  defaultNetwork,
  generateWorkloadYaml,
  initialFormData,
  parseYamlToFormData,
  StrategyForm,
  VolumeForm,
  type DeploymentFormData,
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
 * Standalone Tencent-cloud-style workload creation page (replaces the
 * wizard dialog for deployments): persistent basic info on top, tabbed
 * Deployment / Pod / containers / YAML configuration below.
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
}

export function DeploymentCreatePage({
  resourceType = 'deployments',
}: DeploymentCreatePageProps = {}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const { namespace: namespaceParam } = useParams()
  const [formData, setFormData] = useState<DeploymentFormData>(() => ({
    ...initialFormData,
    namespace: namespaceParam || searchParams.get('namespace') || 'default',
    ...(resourceType === 'cronjobs' ? { schedule: '*/5 * * * *' } : {}),
  }))
  const [activeTab, setActiveTab] = useState<MainTab | number>(() => {
    const tabParam = searchParams.get('tab')
    if (tabParam === 'pod') return 'pod'
    if (tabParam === 'yaml') return 'yaml'
    const match = tabParam?.match(/^container-(\d+)$/)
    if (match) {
      const index = Number(match[1])
      if (index >= 0 && index < formData.containers.length) return index
    }
    return 'deployment'
  })
  const [deploySection, setDeploySection] = useState<DeploySection>('labels')
  const [podSection, setPodSection] = useState<PodSection>('labels')
  const [containerSection, setContainerSection] = useState(
    'general' as 'general' | 'health' | 'resources' | 'security' | 'storage'
  )
  const [editedYaml, setEditedYaml] = useState('')
  const yamlSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A pending reverse-sync must not fire after the page is gone.
  useEffect(
    () => () => {
      if (yamlSyncTimer.current) clearTimeout(yamlSyncTimer.current)
    },
    []
  )
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const update = (updates: Partial<DeploymentFormData>) =>
    setFormData((prev) => ({ ...prev, ...updates }))

  const currentYaml = useMemo(
    () => generateWorkloadYaml(formData, resourceType),
    [formData, resourceType]
  )
  const finalYaml = editedYaml || currentYaml

  // Keep the tab in the URL so a refresh reopens the same section.
  const setTab = (tab: MainTab | number) => {
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams)
    params.set('tab', typeof tab === 'number' ? `container-${tab}` : tab)
    setSearchParams(params, { replace: true })
  }

  // When the user edited the YAML by hand it becomes the source of truth:
  // skip form validation (the YAML document itself is what gets applied).
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
    if (!formData.name || !formData.namespace || formData.replicas <= 0)
      return false
    if (!formData.labels.every((l) => l.key && l.value)) return false
    if (!formData.containers.every((c) => c.image && c.name)) return false
    if (resourceType === 'statefulsets' && !formData.serviceName?.trim())
      return false
    if (resourceType === 'cronjobs' && !formData.schedule?.trim()) return false
    return true
  }, [yamlOverrides, finalYaml, formData, resourceType])

  const handleCreate = async () => {
    if (!isValid) {
      // Name the missing fields so the banner is actionable instead of a
      // generic "please complete the form".
      const missing: string[] = []
      if (!formData.name.trim()) {
        missing.push(t('workloadWizard.fieldName', '名称'))
      }
      if (!formData.namespace.trim()) {
        missing.push(t('workloadWizard.namespace', '命名空间'))
      }
      if (formData.replicas <= 0) {
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
      queryClient.invalidateQueries()
      toast.success(t('common.messages.applied', 'Applied successfully'))
      // Navigate to the newly created deployment's detail page.
      navigate(`/${resourceType}/${formData.namespace}/${formData.name}`)
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

  // Keep the selected tab on a container that still exists: after a removal we
  // land on the neighbouring container (or the Pod tab when the last one is
  // gone) instead of a dangling index that would render a blank panel.
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

  // Derive the active container from the selected tab so the two can never
  // drift apart — a stale index rendered the wrong container, or nothing at
  // all once containers were removed.
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => navigate('/deployments')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-semibold">
          {t('workloadWizard.pageTitle', {
            kind: KIND_LABELS[resourceType] || resourceType,
            defaultValue: `${KIND_LABELS[resourceType] || resourceType}: 创建`,
          })}
        </h1>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {/* Basic info: namespace / name / description on one row, then replicas */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr]">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('workloadWizard.namespace')} *</Label>
            <NamespaceSelector
              selectedNamespace={formData.namespace}
              handleNamespaceChange={(ns) =>
                update({ namespace: ns || 'default' })
              }
              triggerClassName="w-full sm:w-full sm:max-w-none"
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
        <div className="flex flex-wrap items-center gap-1 border-b">
          {[
            ...(resourceType !== 'pods'
              ? ([
                  [
                    'deployment' as MainTab,
                    KIND_LABELS[resourceType] || 'Workload',
                  ],
                ] as Array<[MainTab, string]>)
              : []),
            ['pod', 'Pod'] as [MainTab, string],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-t-md border-b-2 px-4 py-2 text-sm transition-colors ${
                activeTab === key
                  ? 'border-primary font-medium text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
          {containerTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setTab(tab.index)}
              className={`group flex items-center gap-1 rounded-t-md border-b-2 px-4 py-2 text-sm transition-colors ${
                activeTab === tab.index
                  ? 'border-primary font-medium text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
              {formData.containers.length > 1 && (
                <X
                  className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeContainer(tab.index)
                  }}
                />
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={addContainer}
            className="flex items-center gap-1 rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('workloadWizard.addContainer', '添加容器')}
          </button>
          <button
            type="button"
            onClick={() => setTab('yaml')}
            className={`rounded-t-md border-b-2 px-4 py-2 text-sm transition-colors ${
              activeTab === 'yaml'
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('workloadWizard.stepYaml', 'YAML')}
          </button>
        </div>

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
                    // Monaco echoes the controlled `value` back through
                    // onChange when the form regenerates the YAML; ignoring
                    // those echoes keeps the form authoritative.
                    if (next === currentYaml) return
                    // Keep the typed text immediately; debounce the reverse
                    // sync so typing is smooth. Once synced the override is
                    // cleared and later form edits regenerate the YAML.
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

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button variant="outline" onClick={() => navigate(`/${resourceType}`)}>
          {t('common.actions.cancel', '取消')}
        </Button>
        {/* Kept clickable while invalid so the banner can name the missing fields. */}
        <Button onClick={handleCreate} disabled={isCreating}>
          {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('workloadWizard.createKind', {
            kind: KIND_LABELS[resourceType] || resourceType,
            defaultValue: `创建 ${KIND_LABELS[resourceType] || resourceType}`,
          })}
        </Button>
      </div>
    </div>
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

/** Input joined with a unit dropdown (Pods / %), console style. */
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
  /** StatefulSet uses OnDelete + partition instead of Recreate + maxSurge. */
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

/** Console-style field: the label sits inside the control box. */
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

/** Console-style select: label above the value, both inside the trigger. */
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

function StorageFormView({
  formData,
  setFormData,
}: {
  formData: DeploymentFormData
  setFormData: React.Dispatch<React.SetStateAction<DeploymentFormData>>
}) {
  const { t } = useTranslation()
  const volumes = formData.podSpec.volumes || []
  return (
    <div className="space-y-3">
      <h4 className="text-base font-medium">
        {t('workloadWizard.storageTitle', '存储')}
      </h4>
      {volumes.map((volume, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)_auto] items-end gap-3"
        >
          <div className="space-y-1.5">
            <Label className="text-xs font-normal text-muted-foreground">
              {t('workloadWizard.volumeName', '卷名称')}
            </Label>
            <Input
              value={volume.name}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  podSpec: {
                    ...prev.podSpec,
                    volumes: (prev.podSpec.volumes || []).map((v, i) =>
                      i === index ? { ...v, name: e.target.value } : v
                    ),
                  },
                }))
              }
              placeholder={t('workloadWizard.exampleVolume', '例如: data')}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-normal text-muted-foreground">
              {t('workloadWizard.volumeType', '类型')}
            </Label>
            <Select
              value={volume.sourceType}
              onValueChange={(sourceType) =>
                setFormData((prev) => ({
                  ...prev,
                  podSpec: {
                    ...prev.podSpec,
                    volumes: (prev.podSpec.volumes || []).map((vol, i) =>
                      i === index
                        ? {
                            ...vol,
                            sourceType: sourceType as VolumeForm['sourceType'],
                          }
                        : vol
                    ),
                  },
                }))
              }
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="emptyDir">emptyDir</SelectItem>
                <SelectItem value="hostPath">hostPath</SelectItem>
                <SelectItem value="configMap">ConfigMap</SelectItem>
                <SelectItem value="secret">Secret</SelectItem>
                <SelectItem value="pvc">PVC</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-normal text-muted-foreground">
              {volume.sourceType === 'hostPath'
                ? t('workloadWizard.hostPath', '主机路径')
                : volume.sourceType === 'configMap'
                  ? t('workloadWizard.configMapName', 'ConfigMap 名称')
                  : volume.sourceType === 'secret'
                    ? t('workloadWizard.secretName', 'Secret 名称')
                    : t('workloadWizard.pvcName', 'PVC 名称')}
            </Label>
            <Input
              value={
                volume.options?.path ||
                volume.options?.configMapName ||
                volume.options?.secretName ||
                volume.options?.claimName ||
                ''
              }
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  podSpec: {
                    ...prev.podSpec,
                    volumes: (prev.podSpec.volumes || []).map((v, i) => {
                      if (i !== index) return v
                      const key =
                        v.sourceType === 'hostPath'
                          ? 'path'
                          : v.sourceType === 'configMap'
                            ? 'configMapName'
                            : v.sourceType === 'secret'
                              ? 'secretName'
                              : 'claimName'
                      return {
                        ...v,
                        options: { ...v.options, [key]: e.target.value },
                      }
                    }),
                  },
                }))
              }
              placeholder={
                volume.sourceType === 'hostPath'
                  ? '/data'
                  : volume.sourceType === 'pvc'
                    ? t('workloadWizard.examplePvc', '例如: my-pvc')
                    : ''
              }
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
                  volumes: (prev.podSpec.volumes || []).filter(
                    (_, i) => i !== index
                  ),
                },
              }))
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
          setFormData((prev) => ({
            ...prev,
            podSpec: {
              ...prev.podSpec,
              volumes: [
                ...(prev.podSpec.volumes || []),
                { name: '', sourceType: 'emptyDir' as const },
              ],
            },
          }))
        }
      >
        {t('workloadWizard.addVolume', '添加存储卷')}
      </Button>
    </div>
  )
}

export default DeploymentCreatePage

/** Pull secret selector: docker-registry secrets of the namespace. */
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
