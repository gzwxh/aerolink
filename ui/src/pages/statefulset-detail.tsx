import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconEdit,
  IconFileText,
  IconReload,
  IconScale,
  IconTerminal2,
} from '@tabler/icons-react'
import { StatefulSet } from 'kubernetes-types/apps/v1'
import type { Container } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  patchResource,
  updateResource,
  useResource,
  useResourcesEvents,
  useResourcesWatch,
} from '@/lib/api'
import { useClusterNavigate } from '@/lib/cluster-path'
import { checkScaleDraft, scaleBlockedForSubmission } from '@/lib/scale-guard'
import { translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ContainerInfoCard } from '@/components/container-info-card'
import { EventTable } from '@/components/event-table'
import { PodMonitoring } from '@/components/pod-monitoring'
import { PodTable } from '@/components/pod-table'
import { RelatedResourcesTable } from '@/components/related-resource-table'
import { StatefulSetOverview } from '@/components/statefulset-overview'
import { useOpenWorkspaceSession } from '@/components/terminal-launcher'
import { VolumeTable } from '@/components/volume-table'
import { WorkloadHistoryTabs } from '@/components/workload-history-tabs'

import {
  ResourceDetailShell,
  type ResourceDetailShellTab,
} from './resource-detail-shell'

export function StatefulSetDetail(props: { namespace: string; name: string }) {
  const { namespace, name } = props
  const [isRestartPopoverOpen, setIsRestartPopoverOpen] = useState(false)
  const [isScalePopoverOpen, setIsScalePopoverOpen] = useState(false)
  // 草稿保留**输入文本**（才能区分「空」与「0」），与 Deployment 详情同一个把关（D-70/D-139）。
  const [scaleInput, setScaleInput] = useState('1')
  const [scaleConfirmed, setScaleConfirmed] = useState(false)
  const [refreshInterval, setRefreshInterval] = useState(0)
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const can = useCan()
  // 扩缩容 / 重启 / 进编辑页都会改写对象，是写操作：只读角色不该看到入口。
  const canUpdate = can('statefulsets', 'update', { namespace })
  const canExec = can('pods', 'exec', { namespace })
  // 日志走独立的 log 动词（只读管理员有，自定义角色可能没有）。
  const canLog = can('pods', 'log', { namespace })
  const openWorkspaceSession = useOpenWorkspaceSession()

  const {
    data: statefulset,
    isLoading,
    isError,
    error,
    refetch,
  } = useResource('statefulsets', name, namespace, { refreshInterval })

  const labelSelector = statefulset?.spec?.selector.matchLabels
    ? Object.entries(statefulset.spec.selector.matchLabels)
        .map(([key, value]) => `${key}=${value}`)
        .join(',')
    : undefined

  const { data: relatedPods, isLoading: isLoadingPods } = useResourcesWatch(
    'pods',
    namespace,
    {
      labelSelector,
      enabled: !!statefulset?.spec?.selector.matchLabels,
    }
  )
  const { data: statefulSetEvents, isLoading: isEventsLoading } =
    useResourcesEvents('statefulsets', name, namespace)

  useEffect(() => {
    // 弹窗没开着时跟随线上值；开着期间不打断输入。
    if (statefulset && !isScalePopoverOpen) {
      setScaleInput(String(statefulset.spec?.replicas ?? 0))
      setScaleConfirmed(false)
    }
  }, [statefulset, isScalePopoverOpen])

  useEffect(() => {
    if (statefulset && refreshInterval > 0) {
      const { status } = statefulset
      const readyReplicas = status?.readyReplicas || 0
      const replicas = status?.replicas || 0
      const updatedReplicas = status?.updatedReplicas || 0
      const isStable =
        readyReplicas === replicas && updatedReplicas === replicas
      if (isStable) setRefreshInterval(0)
    }
  }, [statefulset, refreshInterval])

  const handleSaveYaml = async (content: StatefulSet) => {
    await updateResource('statefulsets', name, namespace, content)
    toast.success(t('common.messages.yamlSaved'))
    setRefreshInterval(1000)
  }

  const scaleCheck = checkScaleDraft({
    input: scaleInput,
    current: statefulset?.spec?.replicas ?? 1,
  })
  // 「+/-」在草稿非法时退回线上值，不让 NaN 参与运算。
  const scaleDraftBase = /^\d+$/.test(scaleInput.trim())
    ? Number(scaleInput)
    : (statefulset?.spec?.replicas ?? 1)
  const scaleBlocked = scaleBlockedForSubmission(scaleCheck, scaleConfirmed)

  const handleScale = async () => {
    // 与按钮的 disabled 共用 scaleBlocked（D-70 的教训：两处各写一套判据会做出死按钮）。
    if (!statefulset || scaleCheck.kind === 'invalid' || scaleBlocked) {
      return
    }
    try {
      await patchResource('statefulsets', name, namespace, {
        spec: { replicas: scaleCheck.replicas },
      })
      toast.success(
        t('detail.status.scaledTo', {
          resource: 'StatefulSet',
          replicas: scaleCheck.replicas,
        })
      )
      setIsScalePopoverOpen(false)
      setRefreshInterval(1000)
    } catch (error) {
      toast.error(translateError(error, t))
    }
  }

  const handleRestart = async () => {
    if (!statefulset) return
    try {
      const updated = { ...statefulset } as StatefulSet
      if (!updated.spec) {
        updated.spec = {
          selector: { matchLabels: {} },
          template: { spec: { containers: [] } },
          serviceName: '',
        }
      }
      if (!updated.spec.template) {
        updated.spec.template = { spec: { containers: [] } }
      }
      if (!updated.spec.template.metadata) {
        updated.spec.template.metadata = {}
      }
      if (!updated.spec.template.metadata.annotations) {
        updated.spec.template.metadata.annotations = {}
      }
      updated.spec.template.metadata.annotations[
        'aerolink.kubernetes.io/restartedAt'
      ] = new Date().toISOString()
      await updateResource('statefulsets', name, namespace, updated)
      toast.success(
        t('detail.status.restartInitiated', { resource: 'StatefulSet' })
      )
      setIsRestartPopoverOpen(false)
      setRefreshInterval(1000)
    } catch (error) {
      toast.error(translateError(error, t))
    }
  }

  const handleContainerUpdate = useCallback(
    async (updatedContainer: Container, init: boolean) => {
      if (!statefulset) return
      try {
        const updated = JSON.parse(JSON.stringify(statefulset)) as StatefulSet
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

        await updateResource('statefulsets', name, namespace, updated)
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
    [name, namespace, statefulset, t]
  )

  const extraTabs = useMemo<ResourceDetailShellTab<StatefulSet>[]>(() => {
    const pods = relatedPods || []
    const containers = statefulset?.spec?.template?.spec?.containers || []
    const initContainers =
      statefulset?.spec?.template?.spec?.initContainers || []
    const volumes = statefulset?.spec?.template?.spec?.volumes || []
    const allContainers = [...initContainers, ...containers]

    return [
      {
        value: 'pods',
        label: (
          <>
            {t('common.tabs.pods', { defaultValue: 'Pods' })}
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
            {t('common.tabs.containers', {
              defaultValue: 'Containers',
            })}
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
      },
      {
        value: 'volumes',
        label: (
          <>
            {t('common.tabs.volumes', { defaultValue: 'Volumes' })}
            <Badge variant="secondary">{volumes.length}</Badge>
          </>
        ),
        content: (
          <VolumeTable
            namespace={namespace}
            volumes={volumes}
            containers={allContainers}
            isLoading={isLoading}
          />
        ),
      },
      {
        value: 'related',
        label: t('common.tabs.related', { defaultValue: 'Related' }),
        content: (
          <RelatedResourcesTable
            resource="statefulsets"
            name={name}
            namespace={namespace}
          />
        ),
      },
      {
        value: 'history',
        label: t('common.tabs.history', { defaultValue: 'History' }),
        content: statefulset ? (
          <WorkloadHistoryTabs
            resourceType="statefulsets"
            namespace={namespace}
            name={name}
            resource={statefulset}
            onRollbackComplete={refetch}
          />
        ) : null,
      },
      {
        value: 'events',
        label: t('common.tabs.events', { defaultValue: 'Events' }),
        content: (
          <EventTable
            resource="statefulsets"
            name={name}
            namespace={namespace}
          />
        ),
      },
      {
        value: 'monitor',
        label: t('common.tabs.monitor', { defaultValue: 'Monitor' }),
        content: (
          <PodMonitoring
            namespace={namespace}
            pods={pods}
            containers={containers}
            initContainers={initContainers}
            defaultQueryName={pods[0]?.metadata?.generateName}
            labelSelector={labelSelector}
          />
        ),
      },
    ]
  }, [
    canUpdate,
    handleContainerUpdate,
    isLoading,
    isLoadingPods,
    labelSelector,
    name,
    namespace,
    refetch,
    relatedPods,
    statefulset,
    t,
  ])

  return (
    <ResourceDetailShell
      resourceType="statefulsets"
      resourceLabel="StatefulSet"
      name={name}
      namespace={namespace}
      clonePath={`/statefulsets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/clone`}
      data={statefulset}
      isLoading={isLoading}
      error={isError ? error : null}
      onRefresh={refetch}
      onSaveYaml={handleSaveYaml}
      overview={
        statefulset ? (
          <StatefulSetOverview
            statefulset={statefulset}
            namespace={namespace}
            name={name}
            pods={relatedPods}
            isPodsLoading={isLoadingPods}
            events={statefulSetEvents}
            isEventsLoading={isEventsLoading}
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
                  containers: statefulset?.spec?.template?.spec?.containers,
                  initContainers:
                    statefulset?.spec?.template?.spec?.initContainers,
                  labelSelector,
                  source: 'statefulset',
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
                  containers: statefulset?.spec?.template?.spec?.containers,
                  initContainers:
                    statefulset?.spec?.template?.spec?.initContainers,
                  source: 'statefulset',
                })
              }
            >
              <IconTerminal2 className="w-4 h-4" />
              {t('common.tabs.terminal')}
            </Button>
          ) : null}
          {canUpdate ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate(`/statefulsets/${namespace}/${name}/edit`)
                }
              >
                <IconEdit className="w-4 h-4" />
                {t('common.actions.edit')}
              </Button>
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
                        {t('detail.dialogs.scaleStatefulSet.title')}
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        {t('detail.dialogs.scaleStatefulSet.description')}
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
                          aria-label={t(
                            'detail.scale.decrease',
                            '减少一个副本'
                          )}
                          onClick={() =>
                            setScaleInput(
                              String(Math.max(0, scaleDraftBase - 1))
                            )
                          }
                          disabled={scaleDraftBase <= 0}
                        >
                          -
                        </Button>
                        <Input
                          id="replicas"
                          type="number"
                          min="0"
                          step="1"
                          value={scaleInput}
                          onChange={(e) => {
                            setScaleInput(e.target.value)
                            setScaleConfirmed(false)
                          }}
                          className="text-center"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="size-9 p-0"
                          aria-label={t(
                            'detail.scale.increase',
                            '增加一个副本'
                          )}
                          onClick={() =>
                            setScaleInput(String(scaleDraftBase + 1))
                          }
                        >
                          +
                        </Button>
                      </div>
                      {/* 非法值拦住；缩到 0 / 一次建很多要勾选确认（与 Deployment 同一口径） */}
                      {scaleCheck.kind === 'invalid' && (
                        <p className="text-xs text-destructive">
                          {t(
                            scaleCheck.messageKey,
                            scaleCheck.messageKey === 'detail.scale.empty'
                              ? '请输入副本数。'
                              : '副本数必须是不小于 0 的整数。'
                          )}
                        </p>
                      )}
                      {scaleCheck.kind === 'needsConfirm' && (
                        <label className="flex items-start gap-2 text-xs text-destructive">
                          <Checkbox
                            className="mt-0.5"
                            checked={scaleConfirmed}
                            onCheckedChange={(value) =>
                              setScaleConfirmed(value === true)
                            }
                          />
                          <span>
                            {scaleCheck.messageKey ===
                            'detail.scale.confirmZero'
                              ? t(
                                  'detail.scale.confirmZero',
                                  '缩容到 0 个副本：这个服务不会有任何运行中的 Pod，流量会全部中断。'
                                )
                              : t('detail.scale.confirmLarge', {
                                  replicas: scaleCheck.replicas,
                                  defaultValue: `将创建 ${scaleCheck.replicas} 个副本，请确认集群资源足够。`,
                                })}
                          </span>
                        </label>
                      )}
                    </div>
                    <Button
                      onClick={handleScale}
                      disabled={scaleBlocked}
                      variant={
                        scaleCheck.kind === 'needsConfirm'
                          ? 'destructive'
                          : 'default'
                      }
                      className="w-full"
                    >
                      <IconScale className="w-4 h-4 mr-2" />
                      {t('common.actions.scale')}
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              <Popover
                open={isRestartPopoverOpen}
                onOpenChange={setIsRestartPopoverOpen}
              >
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm">
                    <IconReload className="w-4 h-4" />
                    {t('common.actions.restart')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80">
                  <div className="space-y-2">
                    <h4 className="font-medium">
                      {t('detail.dialogs.restartStatefulSet.title')}
                    </h4>
                    <p className="text-sm text-muted-foreground">
                      {t('detail.dialogs.restartStatefulSet.description')}
                    </p>
                    {/* 原先只有一个「重启」按钮，没有退出口（DaemonSet 同名弹窗有）：
                        Popover 内无取消按钮时，用户只能靠点空白处关掉。 */}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => setIsRestartPopoverOpen(false)}
                      >
                        {t('common.actions.cancel')}
                      </Button>
                      <Button
                        onClick={handleRestart}
                        className="flex-1"
                        variant="outline"
                      >
                        {t('common.actions.restart')}
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </>
          ) : null}
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
