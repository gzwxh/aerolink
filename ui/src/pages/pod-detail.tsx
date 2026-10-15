import { useEffect, useMemo, useState } from 'react'
import {
  IconAdjustments,
  IconBug,
  IconEdit,
  IconFileText,
  IconTerminal2,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { Container, Pod } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import {
  resizePod,
  updateResource,
  useResource,
  useResourcesEvents,
} from '@/lib/api'
import {
  getResourceDetailPath,
  getResourceQueryKey,
} from '@/lib/resource-metadata'
import { isVersionAtLeast, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { useCluster } from '@/hooks/use-cluster'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ContainerInfoCard } from '@/components/container-info-card'
import { ResourceEditor } from '@/components/editors/resource-editor'
import { EventTable } from '@/components/event-table'

import { PodDebugDialog } from '@/components/pod-debug-dialog'
import { PodFileBrowser } from '@/components/pod-file-browser'
import { PodMonitoring } from '@/components/pod-monitoring'
import { PodOverview } from '@/components/pod-overview'
import { RelatedResourcesTable } from '@/components/related-resource-table'
import { ContainerSelector } from '@/components/selector/container-selector'
import { useOpenWorkspaceSession } from '@/components/terminal-launcher'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { VolumeTable } from '@/components/volume-table'

import {
  ResourceDetailShell,
  type ResourceDetailShellTab,
} from './resource-detail-shell'

export function PodDetail(props: { namespace: string; name: string }) {
  const { namespace, name } = props
  const [isDebugDialogOpen, setIsDebugDialogOpen] = useState(false)
  const [isResizeDialogOpen, setIsResizeDialogOpen] = useState(false)
  const [selectedContainerName, setSelectedContainerName] = useState<string>()
  const [resizeContainer, setResizeContainer] = useState<Container | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { t } = useTranslation()
  const { clusters, currentCluster } = useCluster()
  const can = useCan()

  const {
    data: pod,
    isLoading,
    isError,
    error: podError,
    refetch,
  } = useResource('pods', name, namespace)
  const { data: podEvents, isLoading: isEventsLoading } = useResourcesEvents(
    'pods',
    name,
    namespace
  )
  const attachContainerName =
    pod?.metadata?.annotations?.['aerolink.io/debug-container']

  useEffect(() => {
    if (!pod || !pod?.spec?.containers?.length) {
      setSelectedContainerName(undefined)
      setResizeContainer(null)
      return
    }
    setSelectedContainerName((prev) => prev || pod.spec?.containers[0].name)
  }, [pod])

  useEffect(() => {
    if (!pod || !selectedContainerName) {
      setResizeContainer(null)
      return
    }
    const container = pod.spec?.containers.find(
      (item) => item.name === selectedContainerName
    )
    setResizeContainer(
      container ? (JSON.parse(JSON.stringify(container)) as Container) : null
    )
  }, [pod, selectedContainerName])

  const handleSaveYaml = async (content: Pod) => {
    await updateResource('pods', name, namespace, content)
    toast.success(t('common.messages.yamlSaved'))
    await refetch()
  }

  const handleDebugCreated = (updatedPod: Pod, containerName: string) => {
    const updatedNamespace = updatedPod.metadata!.namespace!
    const updatedName = updatedPod.metadata!.name!
    const queryKey = getResourceQueryKey('pods', updatedNamespace, updatedName)
    queryClient.setQueryData(queryKey, updatedPod)
    setIsDebugDialogOpen(false)
    if (updatedNamespace === namespace && updatedName === name) {
      // 调试容器是临时容器，直接把终端开进底部工作区。
      openWorkspaceSession({
        mode: 'terminal',
        namespace,
        podName: name,
        containers: updatedPod.spec?.containers,
        initContainers: updatedPod.spec?.initContainers,
        ephemeralContainers: updatedPod.spec?.ephemeralContainers,
        selectedContainerName: containerName,
        source: 'pod',
      })
    } else {
      navigate(
        getResourceDetailPath('pods', updatedName, updatedNamespace)
      )
    }
  }

  const handleResizeSave = async () => {
    if (!resizeContainer) return
    setIsResizing(true)
    try {
      await resizePod(namespace, name, {
        spec: {
          containers: [
            {
              name: resizeContainer.name,
              resources: resizeContainer.resources,
            },
          ],
        },
      })
      toast.success(t('pods.resizeResourcesSuccess'))
      await refetch()
      setIsResizeDialogOpen(false)
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsResizing(false)
    }
  }

  const clusterVersion = useMemo(
    () => clusters.find((cluster) => cluster.name === currentCluster)?.version,
    [clusters, currentCluster]
  )
  const resizeSupported = useMemo(
    () => isVersionAtLeast(clusterVersion, '1.35.0'),
    [clusterVersion]
  )
  // 调整资源（PATCH Pod）与调试（临时容器，后端要求 exec）都是写操作，
  // 只读角色不该看到入口，否则点下去只会被后端拒绝。
  const canUpdate = can('pods', 'update', { namespace })
  const canExec = can('pods', 'exec', { namespace })
  // 日志走独立的 log 动词（只读管理员有，自定义角色可能没有）。
  const canLog = can('pods', 'log', { namespace })
  const openWorkspaceSession = useOpenWorkspaceSession()
  const resizeAvailable =
    canUpdate && resizeSupported && (pod?.spec?.containers?.length ?? 0) > 0
  const debugAvailable =
    canExec &&
    !!pod &&
    !pod.metadata?.deletionTimestamp &&
    pod.spec?.os?.name !== 'windows' &&
    pod.spec?.nodeSelector?.['kubernetes.io/os'] !== 'windows' &&
    (pod.spec?.containers.length ?? 0) > 0
  const ephemeralAvailable =
    debugAvailable &&
    isVersionAtLeast(clusterVersion, '1.25.0') &&
    pod.status?.phase !== 'Succeeded' &&
    pod.status?.phase !== 'Failed' &&
    !pod.metadata?.annotations?.['kubernetes.io/config.mirror']
  const extraTabs = useMemo<ResourceDetailShellTab<Pod>[]>(
    () => [
      {
        value: 'containers',
        label: (
          <>
            {t('common.tabs.containers')}
            <Badge variant="secondary">
              {(pod?.spec?.containers?.length || 0) +
                (pod?.spec?.initContainers?.length || 0) +
                (pod?.spec?.ephemeralContainers?.length || 0)}
            </Badge>
          </>
        ),
        content: (
          <div className="space-y-4">
            {pod?.spec?.initContainers &&
              pod.spec.initContainers.length > 0 && (
                <Card>
                  <CardContent className="space-y-3 pt-4">
                    {pod.spec.initContainers.map((container) => (
                      <ContainerInfoCard
                        key={container.name}
                        container={container}
                        status={pod.status?.initContainerStatuses?.find(
                          (s) => s.name === container.name
                        )}
                        init
                      />
                    ))}
                  </CardContent>
                </Card>
              )}
            <Card>
              <CardContent className="space-y-3 pt-4">
                {pod?.spec?.containers?.map((container) => (
                  <ContainerInfoCard
                    key={container.name}
                    container={container}
                    status={pod.status?.containerStatuses?.find(
                      (s) => s.name === container.name
                    )}
                  />
                ))}
              </CardContent>
            </Card>
            {!!pod?.spec?.ephemeralContainers?.length && (
              <Card>
                <CardContent className="space-y-3 pt-4">
                  {pod.spec.ephemeralContainers.map((container) => (
                    <ContainerInfoCard
                      key={container.name}
                      container={container}
                      status={pod.status?.ephemeralContainerStatuses?.find(
                        (status) => status.name === container.name
                      )}
                      ephemeral
                    />
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        ),
      },
      {
        value: 'files',
        label: t('common.tabs.files'),
        content: (
          <PodFileBrowser
            namespace={namespace}
            podName={name}
            containers={pod?.spec?.containers}
            initContainers={pod?.spec?.initContainers}
          />
        ),
      },
      {
        value: 'volumes',
        label: (
          <>
            {t('common.tabs.volumes')}
            {pod?.spec?.volumes && (
              <Badge variant="secondary">{pod.spec.volumes.length}</Badge>
            )}
          </>
        ),
        content: (
          <VolumeTable
            namespace={namespace}
            volumes={pod?.spec?.volumes}
            containers={pod?.spec?.containers}
            isLoading={isLoading}
          />
        ),
      },
      {
        value: 'related',
        label: t('common.tabs.related'),
        content: (
          <RelatedResourcesTable
            resource="pods"
            name={name}
            namespace={namespace}
          />
        ),
      },
      {
        value: 'events',
        label: t('common.tabs.events'),
        content: (
          <EventTable resource="pods" name={name} namespace={namespace} />
        ),
      },
      {
        value: 'monitor',
        label: t('common.tabs.monitor'),
        content: (
          <PodMonitoring
            namespace={namespace}
            podName={name}
            containers={pod?.spec?.containers}
            initContainers={pod?.spec?.initContainers}
          />
        ),
      },
    ],
    [isLoading, name, namespace, pod, t]
  )
  return (
    <>
      <ResourceDetailShell
        resourceType="pods"
        resourceLabel="Pod"
        name={name}
        namespace={namespace}
        data={pod}
        isLoading={isLoading}
        error={isError ? podError : null}
        onRefresh={refetch}
        onSaveYaml={handleSaveYaml}
        overview={
          pod ? (
            <PodOverview
              pod={pod}
              namespace={namespace}
              name={name}
              events={podEvents}
              isEventsLoading={isEventsLoading}
            />
          ) : null
        }
        headerActions={
          <>
            {canUpdate ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/pods/${namespace}/${name}/edit`)}
              >
                <IconEdit className="w-4 h-4" />
                {t('common.actions.edit')}
              </Button>
            ) : null}
            {debugAvailable && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsDebugDialogOpen(true)}
              >
                <IconBug className="size-4" />
                {t('pods.debug')}
              </Button>
            )}
            {resizeAvailable && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsResizeDialogOpen(true)}
              >
                <IconAdjustments className="w-4 h-4" />
                {t('pods.resizeResources')}
              </Button>
            )}
          </>
        }
        moreActions={
          <>
            {canLog && (
              <DropdownMenuItem
                onSelect={() =>
                  openWorkspaceSession({
                    mode: 'logs',
                    namespace,
                    podName: name,
                    containers: pod?.spec?.containers,
                    initContainers: pod?.spec?.initContainers,
                    ephemeralContainers: pod?.spec?.ephemeralContainers,
                    source: 'pod',
                  })
                }
              >
                <IconFileText className="size-4" />
                {t('common.tabs.logs')}
              </DropdownMenuItem>
            )}
            {canExec && (
              <DropdownMenuItem
                onSelect={() =>
                  openWorkspaceSession({
                    mode: 'terminal',
                    namespace,
                    podName: name,
                    containers: pod?.spec?.containers,
                    initContainers: pod?.spec?.initContainers,
                    ephemeralContainers: pod?.spec?.ephemeralContainers,
                    attachContainerName,
                    source: 'pod',
                  })
                }
              >
                <IconTerminal2 className="size-4" />
                {t('common.tabs.terminal')}
              </DropdownMenuItem>
            )}
          </>
        }
        preYamlTabs={extraTabs.filter((tab) => tab.value === 'containers')}
        extraTabs={extraTabs.filter((tab) => tab.value !== 'containers')}
      />
      {isDebugDialogOpen && debugAvailable && (
        <PodDebugDialog
          namespace={namespace}
          name={name}
          containers={[
            ...(pod.spec?.containers || []),
            ...(pod.spec?.initContainers || []),
          ]}
          ephemeralAvailable={ephemeralAvailable}
          onClose={() => setIsDebugDialogOpen(false)}
          onCreated={handleDebugCreated}
        />
      )}
      <Dialog open={isResizeDialogOpen} onOpenChange={setIsResizeDialogOpen}>
        <DialogContent className="!max-w-3xl max-h-[90vh] overflow-y-auto sm:!max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('pods.resizeResourcesTitle')}</DialogTitle>
            <DialogDescription>
              {t('pods.resizeResourcesDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('common.fields.container')}</Label>
              <ContainerSelector
                containers={(pod?.spec?.containers || []).map((item) => ({
                  name: item.name,
                  image: item.image || '',
                  init: false,
                }))}
                selectedContainer={selectedContainerName}
                onContainerChange={setSelectedContainerName}
                showAllOption={false}
                placeholder={t('pods.selectContainer')}
              />
            </div>
            {resizeContainer ? (
              <ResourceEditor
                container={resizeContainer}
                onUpdate={(updates) =>
                  setResizeContainer((prev) =>
                    prev ? { ...prev, ...updates } : prev
                  )
                }
              />
            ) : (
              <div className="text-sm text-muted-foreground">
                {t('pods.selectContainer')}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsResizeDialogOpen(false)}
            >
              {t('common.actions.cancel')}
            </Button>
            <Button
              onClick={handleResizeSave}
              disabled={!resizeContainer || isResizing}
            >
              {t('common.actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
