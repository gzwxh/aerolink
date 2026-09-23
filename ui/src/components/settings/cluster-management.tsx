import { useCallback, useMemo, useRef, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import {
  IconCheck,
  IconCopy,
  IconEdit,
  IconPalette,
  IconPlus,
  IconServer,
  IconSwitchHorizontal,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ColumnDef } from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Cluster } from '@/types/api'
import {
  ClusterBadgeUpdateRequest,
  ClusterCreateRequest,
  ClusterUpdateRequest,
  createCluster,
  deleteCluster,
  fetchBindingGroups,
  importClusters,
  updateCluster,
  updateClusterBadge,
  useClusterList,
} from '@/lib/api'
import { copyToClipboard } from '@/lib/clipboard'
import { neutralBadge, statusBadge } from '@/lib/status-badge'
import { useCluster } from '@/hooks/use-cluster'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ClusterBadge, ClusterBadgeIcon } from '@/components/cluster-badge'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'

import { Action, ActionTable } from '../action-table'
import { ClusterBadgeDialog } from './cluster-badge-dialog'
import { ClusterDialog } from './cluster-dialog'
import { ClusterImportDialog } from './cluster-import-dialog'

export function ClusterManagement() {
  const { t } = useTranslation()
  // 只读章节（只有 settings.clusters 的读权限）时不渲染集群写入口。
  const { readOnly } = useSettingsSectionAccess()
  // 切换当前集群只是客户端偏好（写入 localStorage），不是对集群的写操作，
  // 所以只读章节里也保留这个入口。
  const { currentCluster, setCurrentCluster } = useCluster()
  const queryClient = useQueryClient()

  const {
    data: clusters = [],
    isLoading,
    error,
  } = useClusterList({
    refetchInterval: 5000,
  })

  const [showClusterDialog, setShowClusterDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [editingCluster, setEditingCluster] = useState<Cluster | null>(null)
  const [badgeCluster, setBadgeCluster] = useState<Cluster | null>(null)
  const [deletingCluster, setDeletingCluster] = useState<Cluster | null>(null)
  const [deleteBindingGroups, setDeleteBindingGroups] = useState(false)
  const [clusterAgentCommand, setClusterAgentCommand] = useState('')
  const [clusterAgentYaml, setClusterAgentYaml] = useState('')
  const [clusterAgentYamlError, setClusterAgentYamlError] = useState<
    string | null
  >(null)
  const [isClusterAgentYamlLoading, setIsClusterAgentYamlLoading] =
    useState(false)
  const [clusterAgentManifestURL, setClusterAgentManifestURL] = useState('')
  const [clusterAgentCopyError, setClusterAgentCopyError] = useState<
    'command' | 'yaml' | null
  >(null)
  const clusterAgentYamlRequestID = useRef(0)

  const getClusterTypeBadge = useCallback(
    (cluster: Cluster) => {
      if (cluster.clusterAgent) {
        const badge = (
          <Badge {...statusBadge('success')}>
            {t('clusterManagement.type.clusterAgent', 'Cluster Agent')}
          </Badge>
        )
        if (!cluster.clusterAgentVersion) return badge
        return (
          <Tooltip>
            <TooltipTrigger asChild>{badge}</TooltipTrigger>
            <TooltipContent>
              {t('clusterManagement.clusterAgent.version', {
                defaultValue: 'Version: {{version}}',
                version: cluster.clusterAgentVersion,
              })}
            </TooltipContent>
          </Tooltip>
        )
      }
      if (cluster.inCluster) {
        return (
          <Badge {...statusBadge('info')}>
            {t('clusterManagement.type.inCluster', 'In-Cluster')}
          </Badge>
        )
      }
      return (
        <Badge
          variant="outline"
          className="bg-muted text-muted-foreground border-border"
        >
          {t('clusterManagement.type.external', 'External')}
        </Badge>
      )
    },
    [t]
  )

  const getStatusBadge = useCallback(
    (cluster: Cluster) => {
      if (!cluster.enabled) {
        return (
          <Badge {...neutralBadge()}>{t('status.disabled', 'Disabled')}</Badge>
        )
      }
      if (cluster.clusterAgent && !cluster.connected) {
        return (
          <Badge variant="outline">
            {t('clusterManagement.status.waiting', 'Waiting for Cluster Agent')}
          </Badge>
        )
      }
      if (cluster.clusterAgent) {
        return (
          <Badge {...statusBadge('success')}>
            {t('clusterManagement.status.connected', 'Connected')}
          </Badge>
        )
      }
      return (
        <Badge {...statusBadge('success')}>
          {t('status.enabled', 'Enabled')}
        </Badge>
      )
    },
    [t]
  )

  const columns = useMemo<ColumnDef<Cluster>[]>(
    () => [
      {
        id: 'name',
        header: t('common.fields.name', 'Name'),
        cell: ({ row: { original: cluster } }) => {
          const description = cluster.description?.trim()
          return (
            <div className="flex items-start gap-2">
              {/* 图标跟着名称走，和集群切换器、页头徽章位一致：管理员改完能在这里直接看到结果。 */}
              <ClusterBadgeIcon
                cluster={cluster}
                size="sm"
                className="mt-0.5"
              />
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <ClusterBadge cluster={cluster} />
                  {/* 名称是这张表里最自然的入口：点一下直接开「编辑集群」，
                      不必先展开右侧的操作菜单。只读角色保持纯文本，不做假入口。 */}
                  {readOnly ? (
                    <span className="font-medium">{cluster.name}</span>
                  ) : (
                    <button
                      type="button"
                      className="app-link text-left font-medium"
                      title={t('common.actions.edit', 'Edit')}
                      onClick={() => {
                        setEditingCluster(cluster)
                        setShowClusterDialog(true)
                      }}
                    >
                      {cluster.name}
                    </button>
                  )}
                  {cluster.name === currentCluster && (
                    <Badge variant="outline" className="gap-1 text-primary">
                      <IconCheck className="h-3 w-3" />
                      {t('clusterManagement.currentBadge', 'Current')}
                    </Badge>
                  )}
                  {cluster.isDefault && (
                    <Badge variant="secondary">Default</Badge>
                  )}
                </div>
                {/* 描述跟在名称下面：备注往往是整段说明，这里只显示两行，完整内容放
                    tooltip（编辑弹窗里也能看到全文），免得把表格撑宽、把行撑高。 */}
                {description && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="line-clamp-2 max-w-64 cursor-default text-left text-xs break-all text-muted-foreground">
                        {description}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="max-w-sm break-all">{description}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          )
        },
      },
      {
        id: 'version',
        header: t('common.fields.version', 'Version'),
        cell: ({ row: { original: cluster } }) => {
          if (cluster.clusterAgent && !cluster.connected) {
            return <span className="text-muted-foreground">-</span>
          }
          if (cluster.error) {
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge {...statusBadge('failure')}>Error</Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs break-all">{cluster.error}</p>
                </TooltipContent>
              </Tooltip>
            )
          }
          return (
            <Badge variant="secondary" className="font-mono">
              {cluster.version || '-'}
            </Badge>
          )
        },
      },
      {
        id: 'type',
        header: t('common.fields.type', 'Type'),
        cell: ({ row: { original: cluster } }) => getClusterTypeBadge(cluster),
      },
      {
        id: 'status',
        header: t('common.fields.status', 'Status'),
        cell: ({ row: { original: cluster } }) => (
          <div className="flex items-center gap-3">
            {getStatusBadge(cluster)}
          </div>
        ),
      },
      {
        id: 'Prometheus',
        header: t('common.fields.prometheus', 'Prometheus'),
        cell: ({ row: { original: cluster } }) => (
          <div className="text-sm text-muted-foreground">
            {cluster.prometheusURL ? 'Yes' : 'No'}
          </div>
        ),
      },
    ],
    [getClusterTypeBadge, getStatusBadge, t, currentCluster, readOnly]
  )

  const actions = useMemo<Action<Cluster>[]>(
    () => [
      {
        label: (
          <>
            <IconSwitchHorizontal className="h-4 w-4" />
            {t('clusterManagement.actions.switch', 'Switch to this cluster')}
          </>
        ),
        onClick: (cluster) => setCurrentCluster(cluster.name),
        shouldDisable: (cluster) =>
          cluster.name === currentCluster || Boolean(cluster.error),
        hint: (cluster) =>
          cluster.name === currentCluster
            ? t(
                'clusterManagement.hints.currentCluster',
                'This cluster is already in use'
              )
            : cluster.error
              ? t(
                  'clusterManagement.hints.switchUnavailable',
                  'Sync error: this cluster cannot be selected'
                )
              : undefined,
      },
      ...(readOnly
        ? []
        : [
            {
              label: (
                <>
                  <IconEdit className="h-4 w-4" />
                  {t('common.actions.edit', 'Edit')}
                </>
              ),
              onClick: (cluster: Cluster) => {
                setEditingCluster(cluster)
                setShowClusterDialog(true)
              },
            },
            {
              label: (
                <>
                  <IconPalette className="h-4 w-4" />
                  {t('clusterManagement.actions.badge', '自定义徽章')}
                </>
              ),
              onClick: (cluster: Cluster) => setBadgeCluster(cluster),
            },
            {
              label: (
                <div className="inline-flex items-center gap-2 text-destructive">
                  <IconTrash className="h-4 w-4" />
                  {t('common.actions.delete', 'Delete')}
                </div>
              ),
              shouldDisable: (cluster: Cluster) => cluster.isDefault,
              onClick: (cluster: Cluster) => {
                setDeletingCluster(cluster)
              },
            },
          ]),
    ],
    [t, currentCluster, setCurrentCluster, readOnly]
  )

  const createMutation = useMutation({
    mutationFn: createCluster,
    onSuccess: async ({
      clusterAgentServer,
      clusterAgentToken,
      clusterAgentPublicKey,
      clusterAgentManifestURL,
    }: {
      clusterAgentServer?: string
      clusterAgentToken?: string
      clusterAgentPublicKey?: string
      clusterAgentManifestURL?: string
    }) => {
      queryClient.invalidateQueries({ queryKey: ['cluster-list'] })
      toast.success(
        t('clusterManagement.messages.created', 'Cluster created successfully')
      )
      setShowClusterDialog(false)
      if (clusterAgentServer && clusterAgentToken && clusterAgentPublicKey) {
        setClusterAgentCopyError(null)
        setClusterAgentCommand(
          `aerolink cluster-agent --server='${clusterAgentServer}' --token='${clusterAgentToken}' --public-key='${clusterAgentPublicKey}'`
        )
        setClusterAgentYaml('')
        setClusterAgentYamlError(null)
        setClusterAgentManifestURL(clusterAgentManifestURL || '')
        setIsClusterAgentYamlLoading(true)
        const requestID = ++clusterAgentYamlRequestID.current
        try {
          if (!clusterAgentManifestURL) throw new Error('Missing manifest URL')
          const manifestURL = new URL(
            clusterAgentManifestURL,
            window.location.origin
          )
          const response = await fetch(
            `${manifestURL.pathname}${manifestURL.search}`,
            {
              cache: 'no-store',
            }
          )
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const yaml = await response.text()
          if (requestID === clusterAgentYamlRequestID.current) {
            setClusterAgentYaml(yaml)
          }
        } catch {
          if (requestID === clusterAgentYamlRequestID.current) {
            setClusterAgentYamlError(
              t(
                'clusterManagement.clusterAgent.loadYamlError',
                'Failed to load YAML from the manifest URL.'
              )
            )
          }
        } finally {
          if (requestID === clusterAgentYamlRequestID.current) {
            setIsClusterAgentYamlLoading(false)
          }
        }
      }
    },
    onError: () => {},
  })

  const importMutation = useMutation({
    mutationFn: (config: string) => importClusters({ config }),
    onSuccess: ({ importedCount }) => {
      queryClient.invalidateQueries({ queryKey: ['cluster-list'] })
      queryClient.invalidateQueries({ queryKey: ['clusters'] })
      toast.success(
        t(
          'clusterManagement.messages.imported',
          'Imported or updated {{count}} clusters successfully',
          { count: importedCount }
        )
      )
      setShowImportDialog(false)
    },
  })

  // 更新集群的 mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: ClusterUpdateRequest }) =>
      updateCluster(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cluster-list'] })
      toast.success(
        t('clusterManagement.messages.updated', 'Cluster updated successfully')
      )
      setShowClusterDialog(false)
      setEditingCluster(null)
    },
    onError: () => {},
  })

  // 徽章同时出现在集群切换器与顶栏，改完要把 ['clusters'] 一起失效——
  // 那个查询缓存 5 分钟，不失效的话用户得手动刷新才看到效果。
  const badgeMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number
      data: ClusterBadgeUpdateRequest
    }) => updateClusterBadge(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cluster-list'] })
      queryClient.invalidateQueries({ queryKey: ['clusters'] })
      toast.success(t('clusterBadge.saved', '集群徽章已更新'))
      setBadgeCluster(null)
    },
    onError: () => {},
  })

  // 集群下的权限绑定数量，用于删除集群时提示是否一并删除。
  const { data: clusterBindingGroups = [] } = useQuery({
    queryKey: ['binding-groups', 'all'],
    queryFn: () => fetchBindingGroups(),
  })
  const deletingBindingGroupCount = deletingCluster
    ? clusterBindingGroups.filter((g) => g.cluster === deletingCluster.name)
        .length
    : 0

  // 删除集群的 mutation
  const deleteMutation = useMutation({
    mutationFn: ({
      id,
      deleteBindingGroups,
    }: {
      id: number
      deleteBindingGroups: boolean
    }) => deleteCluster(id, { deleteBindingGroups }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['cluster-list'] })
      queryClient.invalidateQueries({ queryKey: ['binding-groups'] })
      toast.success(
        t('clusterManagement.messages.deleted', 'Cluster deleted successfully')
      )
      if ((result.bindingGroupsRetained ?? 0) > 0) {
        toast.info(
          t(
            'clusterManagement.messages.bindingGroupsRetained',
            'Kept {{count}} permission binding group(s); rebind them after re-importing the cluster.',
            { count: result.bindingGroupsRetained }
          )
        )
      }
      setDeletingCluster(null)
      setDeleteBindingGroups(false)
    },
    onError: () => {},
  })

  const handleSubmitCluster = (clusterData: ClusterCreateRequest) => {
    if (editingCluster) {
      // 更新已有集群——直接使用表单数据
      updateMutation.mutate({
        id: editingCluster.id,
        data: clusterData,
      })
    } else {
      // 创建新集群
      createMutation.mutate(clusterData)
    }
  }

  const handleDeleteCluster = () => {
    if (!deletingCluster) return
    deleteMutation.mutate({
      id: deletingCluster.id,
      deleteBindingGroups,
    })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-muted-foreground">
          {t('common.messages.loading', 'Loading...')}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-destructive">
          {t('clusterManagement.errors.loadFailed', 'Failed to load clusters')}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <IconServer className="h-5 w-5" />
                {t('clusterManagement.title', 'Cluster Management')}
              </CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {!readOnly && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      importMutation.reset()
                      setShowImportDialog(true)
                    }}
                    className="gap-2"
                  >
                    <IconUpload className="size-4" />
                    {t('clusterManagement.actions.import', 'Import Clusters')}
                  </Button>
                  <Button
                    onClick={() => {
                      setEditingCluster(null)
                      setShowClusterDialog(true)
                    }}
                    className="gap-2"
                  >
                    <IconPlus className="h-4 w-4" />
                    {t('clusterManagement.actions.add', 'Add Cluster')}
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ActionTable
            data={clusters}
            columns={columns}
            // 切换集群在只读章节里也可用，所以操作列始终渲染。
            actions={actions}
          />
          {clusters.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <IconServer className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>
                {t('clusterManagement.empty.title', 'No clusters configured')}
              </p>
              <p className="text-sm mt-1">
                {t(
                  'clusterManagement.empty.description',
                  'Add your first cluster to get started'
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cluster Dialog (Add/Edit) */}
      <ClusterDialog
        open={showClusterDialog}
        onOpenChange={(open) => {
          setShowClusterDialog(open)
          if (!open) {
            setEditingCluster(null)
          }
        }}
        cluster={editingCluster}
        onSubmit={handleSubmitCluster}
      />

      <ClusterBadgeDialog
        open={!!badgeCluster}
        onOpenChange={(open) => {
          if (!open) {
            setBadgeCluster(null)
          }
        }}
        cluster={badgeCluster}
        onSubmit={(data) => {
          if (badgeCluster) {
            badgeMutation.mutate({ id: badgeCluster.id, data })
          }
        }}
        isPending={badgeMutation.isPending}
      />

      <ClusterImportDialog
        open={showImportDialog}
        onOpenChange={(open) => {
          setShowImportDialog(open)
          if (!open) importMutation.reset()
        }}
        onSubmit={(config) => importMutation.mutate(config)}
        isSubmitting={importMutation.isPending}
        error={importMutation.error?.message}
      />

      <Dialog
        open={!!clusterAgentCommand}
        onOpenChange={(open) => {
          if (!open) {
            clusterAgentYamlRequestID.current += 1
            setClusterAgentCommand('')
            setClusterAgentYaml('')
            setClusterAgentYamlError(null)
            setIsClusterAgentYamlLoading(false)
            setClusterAgentManifestURL('')
            setClusterAgentCopyError(null)
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-balance">
              {t(
                'clusterManagement.clusterAgent.title',
                'Connect Cluster Agent'
              )}
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {t(
                'clusterManagement.clusterAgent.description',
                'Choose a command or Kubernetes YAML to run inside the target cluster. This connection information is shown only once.'
              )}
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="command">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="command">
                {t('clusterManagement.clusterAgent.command', 'Command')}
              </TabsTrigger>
              <TabsTrigger value="yaml">
                {t('clusterManagement.clusterAgent.yaml', 'Kubernetes YAML')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="command" className="space-y-2">
              <div className="flex gap-2">
                <Input
                  readOnly
                  className="font-mono"
                  aria-label={t(
                    'clusterManagement.clusterAgent.command',
                    'Command'
                  )}
                  value={clusterAgentCommand}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t(
                    'clusterManagement.clusterAgent.copyCommand',
                    'Copy command'
                  )}
                  onClick={async () => {
                    if (!clusterAgentCommand) return
                    if (await copyToClipboard(clusterAgentCommand)) {
                      setClusterAgentCopyError(null)
                      toast.success(t('common.messages.copied', 'Copied'))
                    } else {
                      setClusterAgentCopyError('command')
                    }
                  }}
                >
                  <IconCopy className="size-4" />
                </Button>
              </div>
              {clusterAgentCopyError === 'command' && (
                <p role="alert" className="text-sm text-destructive">
                  {t(
                    'clusterManagement.clusterAgent.copyError',
                    'Failed to copy. Copy the content manually.'
                  )}
                </p>
              )}
            </TabsContent>
            <TabsContent value="yaml" className="space-y-2">
              {clusterAgentManifestURL && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {t(
                      'clusterManagement.clusterAgent.applyUrl',
                      'Apply directly with URL'
                    )}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      className="font-mono text-xs"
                      value={`kubectl apply -f "${clusterAgentManifestURL}"`}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t(
                        'clusterManagement.clusterAgent.copyApplyCommand',
                        'Copy apply command'
                      )}
                      onClick={async () => {
                        const copied = await copyToClipboard(
                          `kubectl apply -f "${clusterAgentManifestURL}"`
                        )
                        if (copied) {
                          setClusterAgentCopyError(null)
                          toast.success(t('common.messages.copied', 'Copied'))
                        } else {
                          setClusterAgentCopyError('yaml')
                        }
                      }}
                    >
                      <IconCopy className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  {t(
                    'clusterManagement.clusterAgent.orUseYaml',
                    'Or deploy with YAML'
                  )}
                </Label>
                {isClusterAgentYamlLoading ? (
                  <Skeleton className="h-96 w-full" />
                ) : clusterAgentYamlError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {clusterAgentYamlError}
                  </p>
                ) : (
                  <Textarea
                    readOnly
                    className="h-96 resize-none font-mono text-xs"
                    aria-label={t(
                      'clusterManagement.clusterAgent.yaml',
                      'Kubernetes YAML'
                    )}
                    value={clusterAgentYaml}
                  />
                )}
              </div>
              {clusterAgentYaml && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={async () => {
                      if (await copyToClipboard(clusterAgentYaml)) {
                        setClusterAgentCopyError(null)
                        toast.success(t('common.messages.copied', 'Copied'))
                      } else {
                        setClusterAgentCopyError('yaml')
                      }
                    }}
                  >
                    <IconCopy className="size-4" />
                    {t('clusterManagement.clusterAgent.copyYaml', 'Copy YAML')}
                  </Button>
                </div>
              )}
              {clusterAgentCopyError === 'yaml' && (
                <p role="alert" className="text-sm text-destructive">
                  {t(
                    'clusterManagement.clusterAgent.copyError',
                    'Failed to copy. Copy the content manually.'
                  )}
                </p>
              )}
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                clusterAgentYamlRequestID.current += 1
                setClusterAgentCommand('')
                setClusterAgentYaml('')
                setClusterAgentYamlError(null)
                setIsClusterAgentYamlLoading(false)
                setClusterAgentManifestURL('')
                setClusterAgentCopyError(null)
              }}
            >
              {t('common.actions.close', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        open={!!deletingCluster}
        onOpenChange={() => {
          setDeletingCluster(null)
          setDeleteBindingGroups(false)
        }}
        onConfirm={handleDeleteCluster}
        resourceName={deletingCluster?.name || ''}
        resourceType="cluster"
        isDeleting={deleteMutation.isPending}
        additionalNote={t(
          'clusterManagement.deleteConfirmation',
          "This action will only remove the current cluster's configuration in AeroLink and will not delete any cluster resources."
        )}
        extraContent={
          deletingBindingGroupCount > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="delete-binding-groups"
                  checked={deleteBindingGroups}
                  onCheckedChange={(checked) =>
                    setDeleteBindingGroups(checked === true)
                  }
                />
                <label
                  htmlFor="delete-binding-groups"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  {t(
                    'clusterManagement.deleteBindingGroups',
                    'Also delete the {{count}} permission binding group(s) of this cluster',
                    { count: deletingBindingGroupCount }
                  )}
                </label>
              </div>
              <p className="ml-6 text-xs text-muted-foreground">
                {t(
                  'clusterManagement.keepBindingGroupsHint',
                  'If unchecked, the permission binding groups are kept but stop applying; after re-importing the cluster you can rebind them on the permission page.'
                )}
              </p>
            </div>
          ) : null
        }
      />
    </div>
  )
}
