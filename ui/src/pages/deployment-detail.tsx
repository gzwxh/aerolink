import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconEdit,
  IconFileText,
  IconNetwork,
  IconReload,
  IconScale,
  IconTerminal2,
} from '@tabler/icons-react'
import { Deployment } from 'kubernetes-types/apps/v1'
import type { Container } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  applyResource,
  patchResource,
  updateResource,
  useRelatedResources,
  useResource,
  useResources,
  useResourcesEvents,
  useResourcesWatch,
} from '@/lib/api'
import { useClusterNavigate } from '@/lib/cluster-path'
import {
  getDeploymentStatus,
  servicesForWorkload,
  toSimpleContainer,
} from '@/lib/k8s'
import {
  generateServiceYaml,
  initialData,
  servicePortErrorCodes,
  type ServiceFormData,
  type ServiceType,
} from '@/lib/service-yaml'
import { translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { useNodePortRange } from '@/hooks/use-node-port-range'
import { useServicePortErrorText } from '@/hooks/use-service-port-error-text'
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
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ContainerInfoCard } from '@/components/container-info-card'
import { DeploymentOverview } from '@/components/deployment-overview'
import { EventTable } from '@/components/event-table'
import { PodMonitoring } from '@/components/pod-monitoring'
import { PodTable } from '@/components/pod-table'
import { RelatedResourcesTable } from '@/components/related-resource-table'
import { ServicePortsEditor } from '@/components/service-ports-editor'
import { useOpenWorkspaceSession } from '@/components/terminal-launcher'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'
import { VolumeTable } from '@/components/volume-table'
import { WorkloadHistoryTabs } from '@/components/workload-history-tabs'

import {
  ResourceDetailShell,
  type ResourceDetailShellTab,
} from './resource-detail-shell'

export function DeploymentDetail(props: { namespace: string; name: string }) {
  const { namespace, name } = props
  const [scaleReplicas, setScaleReplicas] = useState(1)
  const [isExposing, setIsExposing] = useState(false)
  const [isExposeDialogOpen, setIsExposeDialogOpen] = useState(false)
  // 「暴露」弹窗就是建一个 Service，表单与「服务」创建页同源（见 lib/service-yaml.ts）。
  // 初值在打开那一刻按当前 Deployment 填（exposeInitialForm），baseline 供草稿判定用。
  const [exposeForm, setExposeForm] = useState<ServiceFormData>(initialData)
  const [exposeBaseline, setExposeBaseline] =
    useState<ServiceFormData>(initialData)
  const [isScalePopoverOpen, setIsScalePopoverOpen] = useState(false)
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false)
  const openWorkspaceSession = useOpenWorkspaceSession()
  const [refreshInterval, setRefreshInterval] = useState(0)
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const can = useCan()
  // 扩缩容 / 重启（PATCH 模板）是写操作，暴露服务则会创建 Service。
  const canUpdate = can('deployments', 'update', { namespace })
  const canCreateService = can('services', 'create', { namespace })
  const canExec = can('pods', 'exec', { namespace })
  // 日志走独立的 log 动词（只读管理员有，自定义角色可能没有）。
  const canLog = can('pods', 'log', { namespace })

  const {
    data: deployment,
    isLoading,
    isError,
    error,
    refetch,
  } = useResource('deployments', name, namespace, { refreshInterval })

  const labelSelector = deployment?.spec?.selector.matchLabels
    ? Object.entries(deployment.spec.selector.matchLabels)
        .map(([key, value]) => `${key}=${value}`)
        .join(',')
    : undefined

  const { data: relatedServices } = useResources('services', namespace, {
    staleTime: 30_000,
  })
  const { data: relatedPods, isLoading: isLoadingPods } = useResourcesWatch(
    'pods',
    namespace,
    {
      labelSelector,
      enabled: !!deployment?.spec?.selector.matchLabels,
    }
  )
  const { data: deploymentEvents, isLoading: isEventsLoading } =
    useResourcesEvents('deployments', name, namespace)
  const { data: relatedResources, refetch: refetchRelatedResources } =
    useRelatedResources('deployments', name, namespace)

  // 与该工作负载关联的 Service（选择器匹配；无 selector 的按名字兜底）——
  // 由 Endpoints 卡片使用；同一命名空间中不相关的 Service
  // 不是该 Deployment 概览需要关心的。
  // Service 的 selector 指向的是 Pod 标签，因此以 Pod 模板标签为基准
  // （Rancher 等工具创建的 Service 常带额外键），并合并工作负载 selector。
  const associatedServices = useMemo(
    () =>
      servicesForWorkload(relatedServices || [], {
        name,
        labels: {
          ...(deployment?.spec?.template?.metadata?.labels || {}),
          ...(deployment?.spec?.selector?.matchLabels || {}),
        },
      }),
    [relatedServices, name, deployment]
  )

  const hasRelatedService = useMemo(
    () => relatedResources?.some((resource) => resource.type === 'services'),
    [relatedResources]
  )
  // 删除联动：删 Deployment 时要一并删除的关联 Service。
  // 只有真的有 services 删除权限才联动（fail-closed），
  // 否则弹窗里只删 Deployment 本身。
  const deletableRelatedServices = useMemo(
    () =>
      can('services', 'delete', { namespace })
        ? associatedServices
            .map((svc) => svc.metadata?.name || '')
            .filter(Boolean)
        : [],
    [associatedServices, can, namespace]
  )
  // 终端弹窗与 containers 标签页共用同一份容器列表。
  const containers = useMemo(
    () => deployment?.spec?.template.spec?.containers || [],
    [deployment]
  )
  const initContainers = useMemo(
    () => deployment?.spec?.template.spec?.initContainers || [],
    [deployment]
  )

  useEffect(() => {
    if (deployment) {
      setScaleReplicas(deployment.spec?.replicas || 1)
    }
  }, [deployment])

  /**
   * 「暴露」弹窗的初值：名称取工作负载名，选择器取它的 Pod 标签（即
   * `spec.selector.matchLabels`，界面上只读），端口默认用容器声明的第一个端口。
   */
  const exposeInitialForm = useCallback((): ServiceFormData => {
    const containerPort =
      deployment?.spec?.template.spec?.containers
        ?.flatMap((container) => container.ports || [])
        .find((port) => port.containerPort)?.containerPort || 80

    return {
      ...initialData,
      name,
      namespace,
      selector: Object.entries(
        deployment?.spec?.selector?.matchLabels || {}
      ).map(([key, value]) => ({ key, value })),
      ports: [
        {
          name: '',
          port: String(containerPort),
          targetPort: String(containerPort),
          nodePort: '',
          protocol: 'TCP',
        },
      ],
    }
  }, [deployment, name, namespace])

  const openExposeDialog = useCallback(() => {
    const next = exposeInitialForm()
    setExposeForm(next)
    setExposeBaseline(next)
    setIsExposeDialogOpen(true)
  }, [exposeInitialForm])

  const closeExposeDialog = useCallback(() => setIsExposeDialogOpen(false), [])
  // 承载可编辑草稿的弹窗：遮罩 / Esc / 关闭按钮都要先确认（见 AGENTS.md）。
  const exposeGuard = useUnsavedChangesGuard({
    dirty: useDraftDirty(exposeForm, exposeBaseline),
    onClose: closeExposeDialog,
  })

  const updateExpose = useCallback((updates: Partial<ServiceFormData>) => {
    setExposeForm((prev) => ({ ...prev, ...updates }))
  }, [])

  const exposeNodePortRange = useNodePortRange()
  const exposePortErrors = useMemo(
    () =>
      servicePortErrorCodes(
        exposeForm.ports,
        exposeForm.serviceType,
        exposeNodePortRange
      ),
    [exposeForm.ports, exposeForm.serviceType, exposeNodePortRange]
  )
  const exposeErrorText = useServicePortErrorText()

  useEffect(() => {
    if (deployment) {
      const status = getDeploymentStatus(deployment)
      const isStable =
        status === 'Available' ||
        status === 'Scaled Down' ||
        status === 'Paused'
      if (isStable) {
        const timer = setTimeout(() => setRefreshInterval(0), 2000)
        return () => clearTimeout(timer)
      } else {
        setRefreshInterval(1000)
      }
    }
  }, [deployment, refreshInterval])

  const handleSaveYaml = async (content: Deployment) => {
    await updateResource('deployments', name, namespace, content)
    toast.success(t('common.messages.yamlSaved'))
    setRefreshInterval(1000)
  }

  const handleRestart = useCallback(async () => {
    if (!deployment) return
    try {
      const updated = { ...deployment } as Deployment
      if (!updated.spec!.template?.metadata?.annotations) {
        updated.spec!.template!.metadata!.annotations = {}
      }
      updated.spec!.template!.metadata!.annotations![
        'aerolink.kubernetes.io/restartedAt'
      ] = new Date().toISOString()
      await updateResource('deployments', name, namespace, updated)
      toast.success(
        t('detail.status.restartInitiated', { resource: 'Deployment' })
      )
      setIsRestartDialogOpen(false)
      setRefreshInterval(1000)
    } catch (error) {
      toast.error(translateError(error, t))
    }
  }, [t, deployment, name, namespace])

  const handleScale = useCallback(async () => {
    if (!deployment) return
    try {
      await patchResource('deployments', name, namespace, {
        spec: { replicas: scaleReplicas },
      })
      toast.success(
        t('detail.status.scaledTo', {
          resource: 'Deployment',
          replicas: scaleReplicas,
        })
      )
      setIsScalePopoverOpen(false)
      setRefreshInterval(1000)
    } catch (error) {
      toast.error(translateError(error, t))
    }
  }, [t, deployment, name, namespace, scaleReplicas])

  const handleExpose = useCallback(async () => {
    if (!deployment) return

    // 选择器在弹窗里是只读的（取工作负载的 Pod 标签），但仍是提交的必填项：
    // Deployment 没有 matchLabels 时建的 Service 不会选中任何 Pod。
    const selector = exposeForm.selector.filter(
      (pair) => pair.key.trim() && pair.value.trim()
    )
    if (selector.length === 0) {
      toast.error(t('deployments.exposeNoSelector'))
      return
    }
    if (!exposeForm.name.trim()) {
      toast.error(t('deployments.exposeNameRequired', '请填写 Service 名称'))
      return
    }
    if (exposeForm.ports.length === 0) {
      toast.error(t('deployments.exposeInvalidPort'))
      return
    }
    const firstPortError = [...exposePortErrors.values()][0]
    if (firstPortError) {
      toast.error(exposeErrorText(firstPortError))
      return
    }

    setIsExposing(true)
    try {
      // 与「服务」创建页走同一条生成路径，两个入口产出的 Service 一致。提交用 apply：
      // 同名 Service 已存在时是原地更新，而不是报「已存在」。
      await applyResource(
        generateServiceYaml({ ...exposeForm, selector }),
        exposeForm.namespace
      )
      toast.success(t('deployments.exposed', { service: exposeForm.name }))
      setIsExposeDialogOpen(false)
      await refetchRelatedResources()
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsExposing(false)
    }
  }, [
    deployment,
    exposeErrorText,
    exposeForm,
    exposePortErrors,
    refetchRelatedResources,
    t,
  ])

  const handleContainerUpdate = useCallback(
    async (updatedContainer: Container, init: boolean) => {
      if (!deployment) return
      try {
        const updated = JSON.parse(JSON.stringify(deployment)) as Deployment
        const templateSpec = updated.spec!.template.spec!

        if (init) {
          templateSpec.initContainers = (templateSpec.initContainers || []).map(
            (container) =>
              container.name === updatedContainer.name
                ? updatedContainer
                : container
          )
        } else {
          templateSpec.containers = templateSpec.containers.map((container) =>
            container.name === updatedContainer.name
              ? updatedContainer
              : container
          )
        }

        await updateResource('deployments', name, namespace, updated)
        toast.success(
          t('common.messages.containerUpdated', {
            defaultValue: 'Container updated successfully',
          })
        )
        setRefreshInterval(1000)
      } catch (error) {
        toast.error(translateError(error, t))
      }
    },
    [deployment, name, namespace, t]
  )

  const extraTabs = useMemo<ResourceDetailShellTab<Deployment>[]>(() => {
    const tabs: ResourceDetailShellTab<Deployment>[] = []
    const pods = relatedPods || []

    tabs.push(
      {
        value: 'pods',
        label: (
          <>
            {t('common.tabs.pods')}
            <Badge variant="secondary">{pods.length}</Badge>
          </>
        ),
        content: (
          <PodTable
            pods={pods}
            isLoading={isLoadingPods}
            labelSelector={labelSelector}
          />
        ),
      },
      {
        value: 'containers',
        label: (
          <>
            {t('common.tabs.containers')}
            <Badge variant="secondary">
              {containers.length + initContainers.length}
            </Badge>
          </>
        ),
        content: (
          <div className="space-y-4">
            {initContainers.length > 0 ? (
              <div className="space-y-3">
                {initContainers.map((container) => (
                  <ContainerInfoCard
                    key={container.name}
                    container={container}
                    init
                    onContainerUpdate={
                      canUpdate
                        ? (updatedContainer) =>
                            handleContainerUpdate(updatedContainer, true)
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : null}
            <div className="space-y-3">
              {containers.map((container) => (
                <ContainerInfoCard
                  key={container.name}
                  container={container}
                  onContainerUpdate={
                    canUpdate
                      ? (updatedContainer) =>
                          handleContainerUpdate(updatedContainer, false)
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
        ),
      }
    )

    tabs.push(
      {
        value: 'related',
        label: t('common.tabs.related'),
        content: (
          <RelatedResourcesTable
            resource="deployments"
            name={name}
            namespace={namespace}
          />
        ),
      },
      {
        value: 'history',
        label: t('common.tabs.history'),
        content: deployment ? (
          <WorkloadHistoryTabs
            resourceType="deployments"
            namespace={namespace}
            name={name}
            resource={deployment}
            onRollbackComplete={refetch}
          />
        ) : null,
      }
    )

    if (deployment?.spec?.template?.spec?.volumes) {
      tabs.push({
        value: 'volumes',
        label: (
          <>
            {t('common.tabs.volumes')}
            <Badge variant="secondary">
              {deployment.spec.template.spec.volumes.length}
            </Badge>
          </>
        ),
        content: (
          <VolumeTable
            namespace={namespace}
            volumes={deployment.spec.template.spec.volumes}
            containers={toSimpleContainer(
              deployment.spec.template.spec.initContainers,
              deployment.spec.template.spec.containers
            )}
            isLoading={isLoading}
          />
        ),
      })
    }

    tabs.push(
      {
        value: 'events',
        label: t('common.tabs.events'),
        content: (
          <EventTable
            resource="deployments"
            name={name}
            namespace={namespace}
          />
        ),
      },
      {
        value: 'monitor',
        label: t('common.tabs.monitor'),
        content: (
          <PodMonitoring
            namespace={namespace}
            pods={pods}
            containers={containers}
            initContainers={initContainers}
            labelSelector={labelSelector}
          />
        ),
      }
    )

    return tabs
  }, [
    canUpdate,
    containers,
    deployment,
    initContainers,
    isLoading,
    isLoadingPods,
    labelSelector,
    handleContainerUpdate,
    name,
    namespace,
    refetch,
    relatedPods,
    t,
  ])

  return (
    <ResourceDetailShell
      resourceType="deployments"
      resourceLabel="Deployment"
      name={name}
      namespace={namespace}
      clonePath={`/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/clone`}
      deleteRelatedServices={deletableRelatedServices}
      data={deployment}
      isLoading={isLoading}
      error={isError ? error : null}
      onRefresh={refetch}
      onSaveYaml={handleSaveYaml}
      overview={
        deployment ? (
          <DeploymentOverview
            deployment={deployment}
            namespace={namespace}
            name={name}
            pods={relatedPods}
            isPodsLoading={isLoadingPods}
            events={deploymentEvents}
            isEventsLoading={isEventsLoading}
            services={associatedServices}
          />
        ) : null
      }
      headerActions={
        <>
          {canLog ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                openWorkspaceSession({
                  mode: 'logs',
                  namespace,
                  pods: relatedPods ?? [],
                  containers,
                  initContainers,
                  labelSelector,
                  source: 'deployment',
                })
              }
            >
              <IconFileText className="w-4 h-4" />
              {t('common.tabs.logs')}
            </Button>
          ) : null}
          {canExec && (relatedPods?.length ?? 0) > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                openWorkspaceSession({
                  mode: 'terminal',
                  namespace,
                  pods: relatedPods ?? [],
                  containers,
                  initContainers,
                  source: 'deployment',
                })
              }
            >
              <IconTerminal2 className="w-4 h-4" />
              {t('common.tabs.terminal')}
            </Button>
          ) : null}
          {canUpdate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/deployments/${namespace}/${name}/edit`)}
            >
              <IconEdit className="w-4 h-4" />
              {t('common.actions.edit')}
            </Button>
          ) : null}
          {canUpdate ? (
            <Popover
              open={isScalePopoverOpen}
              onOpenChange={setIsScalePopoverOpen}
            >
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <IconScale className="w-4 h-4" />
                  {t('common.actions.scale')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h4 className="font-medium">
                      {t('detail.dialogs.scaleDeployment.title')}
                    </h4>
                    <p className="text-sm text-muted-foreground">
                      {t('detail.dialogs.scaleDeployment.description')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="replicas">
                      {t('common.fields.replicas')}
                    </Label>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="size-9 p-0"
                        onClick={() =>
                          setScaleReplicas(Math.max(0, scaleReplicas - 1))
                        }
                        disabled={scaleReplicas <= 0}
                      >
                        -
                      </Button>
                      <Input
                        id="replicas"
                        type="number"
                        min="0"
                        value={scaleReplicas}
                        onChange={(e) =>
                          setScaleReplicas(parseInt(e.target.value) || 0)
                        }
                        className="text-center"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="size-9 p-0"
                        onClick={() => setScaleReplicas(scaleReplicas + 1)}
                      >
                        +
                      </Button>
                    </div>
                  </div>
                  <Button onClick={handleScale} className="w-full">
                    <IconScale className="w-4 h-4 mr-2" />
                    {t('common.actions.scale')}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          <Dialog
            open={isExposeDialogOpen}
            onOpenChange={exposeGuard.handleOpenChange}
          >
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t('deployments.exposeTitle')}</DialogTitle>
                <DialogDescription>
                  {t('deployments.exposeDescription')}
                </DialogDescription>
              </DialogHeader>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  handleExpose()
                }}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="expose-name">
                      {t('common.fields.name', '名称')} *
                    </Label>
                    <Input
                      id="expose-name"
                      value={exposeForm.name}
                      onChange={(event) =>
                        updateExpose({ name: event.target.value })
                      }
                      placeholder={name}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="expose-service-type">
                      {t('deployments.serviceType')}
                    </Label>
                    <Select
                      value={exposeForm.serviceType}
                      onValueChange={(value) =>
                        updateExpose({ serviceType: value as ServiceType })
                      }
                    >
                      <SelectTrigger id="expose-service-type" className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ClusterIP">ClusterIP</SelectItem>
                        <SelectItem value="NodePort">NodePort</SelectItem>
                        <SelectItem value="LoadBalancer">
                          LoadBalancer
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t('serviceCreate.selectorTitle', '选择器')}</Label>
                  <div className="flex flex-wrap gap-1.5 rounded-md border p-2">
                    {exposeForm.selector.map((pair) => (
                      <Badge
                        key={pair.key}
                        variant="secondary"
                        className="font-mono text-xs font-normal"
                      >
                        {pair.key}={pair.value}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'deployments.exposeSelectorHint',
                      '选择器取本工作负载的 Pod 标签，固定不可改；需要自定义选择器时请到「服务」页面创建。'
                    )}
                  </p>
                </div>

                <ServicePortsEditor
                  ports={exposeForm.ports}
                  serviceType={exposeForm.serviceType}
                  errors={exposePortErrors}
                  onChange={(ports) => updateExpose({ ports })}
                />

                <div className="space-y-2">
                  <Label htmlFor="expose-session-affinity">
                    {t('serviceCreate.sessionAffinity', '会话保持')}
                  </Label>
                  <Select
                    value={exposeForm.sessionAffinity}
                    onValueChange={(value) =>
                      updateExpose({
                        sessionAffinity:
                          value as ServiceFormData['sessionAffinity'],
                      })
                    }
                  >
                    <SelectTrigger
                      id="expose-session-affinity"
                      className="h-9 w-48"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="None">None</SelectItem>
                      <SelectItem value="ClientIP">ClientIP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => exposeGuard.handleOpenChange(false)}
                  >
                    {t('common.actions.cancel')}
                  </Button>
                  <Button type="submit" disabled={isExposing}>
                    <IconNetwork className="w-4 h-4 mr-2" />
                    {t('common.actions.expose')}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          <UnsavedChangesConfirmDialog {...exposeGuard.confirmDialogProps} />
          <Dialog
            open={isRestartDialogOpen}
            onOpenChange={setIsRestartDialogOpen}
          >
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>
                  {t('detail.dialogs.restartDeployment.title')}
                </DialogTitle>
                <DialogDescription>
                  {t('detail.dialogs.restartDeployment.description')}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setIsRestartDialogOpen(false)}
                >
                  {t('common.actions.cancel')}
                </Button>
                <Button
                  onClick={() => {
                    handleRestart()
                    setIsRestartDialogOpen(false)
                  }}
                >
                  <IconReload className="w-4 h-4 mr-2" />
                  {t('common.actions.restart')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      }
      moreActions={
        <>
          {canCreateService && relatedResources && !hasRelatedService && (
            <DropdownMenuItem onSelect={() => openExposeDialog()}>
              <IconNetwork className="size-4" />
              {t('common.actions.expose')}
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <DropdownMenuItem onSelect={() => setIsRestartDialogOpen(true)}>
              <IconReload className="size-4" />
              {t('common.actions.restart')}
            </DropdownMenuItem>
          )}
        </>
      }
      preYamlTabs={extraTabs.filter((tab) =>
        ['pods', 'containers'].includes(tab.value)
      )}
      extraTabs={extraTabs.filter(
        (tab) => !['pods', 'containers'].includes(tab.value)
      )}
    />
  )
}
