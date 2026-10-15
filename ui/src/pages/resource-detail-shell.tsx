import {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRequestPageRefresh } from '@/contexts/page-refresh-context'
import {
  IconClipboardText,
  IconCopy,
  IconDots,
  IconLoader,
  IconPencil,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { type ResourceType } from '@/types/api'
import { getResourceListPath } from '@/lib/resource-catalog'
import { getResourceMetadata } from '@/lib/resource-metadata'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { cn, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { usePageTitle } from '@/hooks/use-page-title'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ResponsiveTabs } from '@/components/ui/responsive-tabs'
import { CloneResourceDialog } from '@/components/clone-resource-dialog'
import { DescribeDialog } from '@/components/describe-dialog'
import { ErrorMessage } from '@/components/error-message'
import { ResourceDeleteConfirmationDialog } from '@/components/resource-delete-confirmation-dialog'
import { YamlEditor } from '@/components/yaml-editor'

export interface ResourceDetailShellContext<T> {
  resource: T
  yamlContent: string
  setYamlContent: (value: string) => void
  refreshKey: number
  isSavingYaml: boolean
  onRefresh: () => Promise<unknown>
}

export interface ResourceDetailShellTab<T> {
  value: string
  label: ReactNode
  content: ReactNode | ((context: ResourceDetailShellContext<T>) => ReactNode)
}

interface ResourceDetailShellProps<T> {
  resourceType: ResourceType
  resourceLabel: string
  name: string
  namespace?: string
  data: T | undefined
  isLoading: boolean
  error: Error | unknown | null
  onRefresh: () => Promise<unknown>
  onSaveYaml?: (content: T) => Promise<unknown>
  overview: ReactNode | ((context: ResourceDetailShellContext<T>) => ReactNode)
  preYamlTabs?: ResourceDetailShellTab<T>[]
  extraTabs?: ResourceDetailShellTab<T>[]
  headerActions?: ReactNode
  /**
   * 收进「更多」（…）菜单的页面级操作，用于不常用或高危项；
   * 菜单里描述 / 克隆 / 删除由 shell 自带，追加在这些项之后。
   */
  moreActions?: ReactNode
  /**
   * 有可视化表单编辑页的资源传入该路径，标题栏就会多一个「编辑」按钮
   * （路径来源见 `lib/resource-catalog.ts` 的 `getResourceFormEditPath`）。
   */
  editPath?: string
  /**
   * 设置后「克隆」不再打开 YAML 克隆弹窗，而是跳转到该路径
   * （例如工作负载的表单克隆页，见 deployment-create-page 的克隆分支）。
   */
  clonePath?: string
  titleIcon?: ReactNode
  yamlToolbar?:
    ReactNode | ((context: ResourceDetailShellContext<T>) => ReactNode)
  loadingMessage?: string
  yamlTabLabel?: ReactNode
  showDescribe?: boolean
  showDelete?: boolean
  showClone?: boolean
  /**
   * 删除该资源时会一并删除的关联 Service 名单（调用方算好并做权限过滤），
   * 删除弹窗里会展示联动提醒。
   */
  deleteRelatedServices?: string[]
  /**
   * YAML 标签页是否提供编辑与保存。只读用户仍能看到该标签页，
   * 以便查看 manifest。
   */
  yamlEditable?: boolean
  defaultTab?: string
  /**
   * 用于权限校验的资源；默认为 `resourceType`。
   * 对 AeroLink 已知的资源会自动做操作门控，传一个值
   * 可以为其它资源（例如 CRD）强制开启门控。
   */
  permissionResource?: string
}

export function ResourceDetailShell<T>({
  resourceType,
  resourceLabel,
  name,
  namespace,
  data,
  isLoading,
  error,
  onRefresh,
  onSaveYaml,
  overview,
  preYamlTabs = [],
  extraTabs = [],
  headerActions,
  moreActions,
  editPath,
  clonePath,
  titleIcon,
  yamlToolbar,
  loadingMessage,
  yamlTabLabel,
  showDescribe = true,
  showDelete = true,
  showClone = true,
  deleteRelatedServices,
  yamlEditable = true,
  defaultTab,
  permissionResource,
}: ResourceDetailShellProps<T>) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [yamlContent, setYamlContent] = useState('')
  const [yamlDirty, setYamlDirty] = useState(false)
  // 最近一次从服务端数据同步出来的 YAML：编辑器可能把程序化更新也回抛给
  // onChange，只有与这份基线不同才算用户改过。
  const syncedYamlRef = useRef('')
  // 「有未保存草稿」的同步镜像：下面是 effect 里要同步读取它，
  // 直接用 state 会逼着 effect 把标记放进 deps，反而让同步在草稿存在时重跑。
  const yamlDirtyRef = useRef(false)
  const [isSavingYaml, setIsSavingYaml] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isCloneDialogOpen, setIsCloneDialogOpen] = useState(false)
  const [isDescribeOpen, setIsDescribeOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const isIframe = searchParams.get('iframe') === 'true'
  const navigate = useNavigate()
  const listPath = getResourceListPath(resourceType)

  // 过去所有操作默认可见，导致只读用户看到后端本会拒绝的
  // 按钮。现在对 AeroLink 已知的资源默认做门控；
  // 未知的 CR 保持原有行为。
  const can = useCan()
  const permissionTarget = permissionResource ?? resourceType
  const gatePermissions =
    permissionResource !== undefined || !!getResourceMetadata(resourceType)
  const canRead =
    !gatePermissions || can(permissionTarget, 'get', { namespace })
  const canUpdate =
    !gatePermissions || can(permissionTarget, 'update', { namespace })
  const canDelete =
    !gatePermissions || can(permissionTarget, 'delete', { namespace })
  const canCreate =
    !gatePermissions || can(permissionTarget, 'create', { namespace })
  const effectiveYamlEditable = yamlEditable && canUpdate
  const effectiveShowDescribe = showDescribe && canRead
  const effectiveShowClone = showClone && canCreate
  const effectiveShowDelete = showDelete && canDelete

  usePageTitle(name ? `${name} (${resourceLabel})` : resourceLabel)

  useEffect(() => {
    if (!data) return
    const dumped = yaml.dump(data, { indent: 2 })
    syncedYamlRef.current = dumped
    // 详情页会定时刷新数据（滚动更新期间甚至每秒一次），每次都会换掉 data。
    // 有未保存草稿时不能把实时对象写回编辑器：那会静默冲掉正在编辑的内容，
    // 保存下去的也变成旧对象，而且顺手清掉的「未保存」标记会让切集群确认也失效。
    if (yamlDirtyRef.current) return
    setYamlContent(dumped)
  }, [data])

  const handleYamlChange = useCallback((value: string) => {
    setYamlContent(value)
    const dirty = value !== syncedYamlRef.current
    yamlDirtyRef.current = dirty
    setYamlDirty(dirty)
  }, [])

  // 集群切换入口据此弹「未保存」确认（见 ClusterProvider）。
  useUnsavedEdits(yamlDirty)

  // 把「这一页要刷新了」广播给不在 react-query 里的数据源（SSE 列表）。
  const requestPageRefresh = useRequestPageRefresh()

  const handleRefresh = useCallback(async () => {
    setRefreshKey((prev) => prev + 1)
    setIsRefreshing(true)
    // 这一页上的数据不止主资源一份，刷新按钮的语义是「重新取这一页的全部数据」：
    // 1) 主资源走页面传进来的 onRefresh；
    // 2) 事件、相关资源、监控曲线等是各自独立的查询（见 components/resource-overview.tsx
    //    的 useResourcesEvents / useRelatedResources），按 type: 'active' 一并重取
    //    （范围恰好是这一页）；refetchQueries 不看 staleTime，刚点就一定能拿到新数据。
    //    传 cancelRefetch: false：主资源此时正由 onRefresh 在取，复用它那条请求，不重发。
    // 3) 走 SSE 的列表（详情页的 Pods）数据在本地 state 里、不在 react-query 缓存中，
    //    refetchQueries 碰不到它，靠广播页面刷新信号让那条连接重连并重取快照——漏掉它就会
    //    出现「Pod 已删掉、点刷新列表还是旧的、只能整页重载」（见 page-refresh-context）。
    requestPageRefresh()
    try {
      await Promise.all([
        onRefresh(),
        queryClient.refetchQueries(
          { type: 'active' },
          { cancelRefetch: false }
        ),
      ])
    } finally {
      setIsRefreshing(false)
    }
  }, [onRefresh, queryClient, requestPageRefresh])

  const handleSaveYaml = useCallback(
    async (content: T) => {
      if (!onSaveYaml) {
        return
      }

      setIsSavingYaml(true)
      try {
        await onSaveYaml(content)
        // 保存成功后 data 刷新会重置基线；这里先清掉，避免刷新失败时草稿标记残留。
        yamlDirtyRef.current = false
        setYamlDirty(false)
      } catch (error) {
        toast.error(translateError(error, t))
      } finally {
        setIsSavingYaml(false)
      }
    },
    [onSaveYaml, t]
  )

  const shellContext = useMemo<ResourceDetailShellContext<T>>(
    () => ({
      resource: data as T,
      yamlContent,
      setYamlContent,
      refreshKey,
      isSavingYaml,
      onRefresh: handleRefresh,
    }),
    [data, handleRefresh, isSavingYaml, refreshKey, yamlContent]
  )

  const tabs = useMemo(() => {
    const resolvedTabs: ResourceDetailShellTab<T>[] = [
      {
        value: 'overview',
        label: t('common.tabs.overview'),
        content: overview,
      },
    ]

    resolvedTabs.push(...preYamlTabs)

    if (onSaveYaml) {
      resolvedTabs.push({
        value: 'yaml',
        label: yamlTabLabel || t('common.tabs.yaml'),
        content: (
          <div className="flex h-full min-h-0 flex-col gap-4">
            {yamlToolbar ? (
              <div className="flex shrink-0 justify-end">
                {typeof yamlToolbar === 'function'
                  ? yamlToolbar(shellContext)
                  : yamlToolbar}
              </div>
            ) : null}
            <YamlEditor
              key={refreshKey}
              value={yamlContent}
              title={t('common.fields.yamlConfiguration')}
              readOnly={!effectiveYamlEditable}
              showControls={effectiveYamlEditable}
              onSave={
                effectiveYamlEditable
                  ? (value) => {
                      void handleSaveYaml(value as T)
                    }
                  : undefined
              }
              onChange={handleYamlChange}
              isSaving={isSavingYaml}
              fillHeight
            />
          </div>
        ),
      })
    }

    return [...resolvedTabs, ...extraTabs]
  }, [
    extraTabs,
    handleSaveYaml,
    handleYamlChange,
    isSavingYaml,
    preYamlTabs,
    onSaveYaml,
    overview,
    shellContext,
    t,
    refreshKey,
    yamlContent,
    effectiveYamlEditable,
    yamlTabLabel,
    yamlToolbar,
  ])

  if (isLoading) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-center gap-2">
              <IconLoader className="animate-spin" />
              <span>
                {loadingMessage ||
                  t('detail.status.loading', { resource: resourceLabel })}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    if (!data && !error) {
      return (
        <div className="p-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-center gap-2 text-muted-foreground">
                {t('common.messages.resourceNotFound', {
                  resource: resourceLabel,
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      )
    }

    // 资源已删除（或从未存在）：提供返回列表的入口，
    // 而不是一个死的"重试"页面。
    const errorMessage = String(
      (error as { response?: { data?: { error?: string } } })?.response?.data
        ?.error ??
        (error as Error)?.message ??
        error ??
        ''
    ).toLowerCase()
    if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      return (
        <div className="p-6">
          <Card>
            <CardContent className="flex flex-col items-center gap-3 pt-6 text-center">
              <p className="text-sm text-muted-foreground">
                {t('common.messages.resourceNotFound', {
                  resource: resourceLabel,
                })}
              </p>
              <Button variant="outline" onClick={() => navigate(listPath)}>
                {t('common.actions.backToList', '返回列表')}
              </Button>
            </CardContent>
          </Card>
        </div>
      )
    }

    return (
      <ErrorMessage
        resourceName={resourceLabel}
        error={error}
        refetch={handleRefresh}
      />
    )
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        isIframe ? 'h-dvh px-4 py-3 lg:px-6' : 'h-full'
      )}
    >
      <ResponsiveTabs
        className={cn('min-h-0 flex-1', namespace ? 'gap-2' : 'gap-4')}
        contentClassName="min-h-0 flex-1 overflow-y-auto"
        stickyHeader={
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              {titleIcon}
              <div className="min-w-0">
                <h1 className="truncate text-lg font-extrabold">{name}</h1>
                {namespace ? (
                  <p className="text-muted-foreground">
                    {t('common.fields.namespace')}:{' '}
                    <span className="font-medium">{namespace}</span>
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex w-full flex-wrap gap-2 md:w-auto md:justify-end">
              {canUpdate && editPath ? (
                <Button size="sm" onClick={() => navigate(editPath)}>
                  <IconPencil className="size-4" />
                  {t('common.actions.edit')}
                </Button>
              ) : null}
              <Button
                disabled={isRefreshing}
                variant="outline"
                size="sm"
                onClick={handleRefresh}
              >
                <IconRefresh className="w-4 h-4" />
                {t('common.actions.refresh')}
              </Button>
              {headerActions}
              {moreActions ||
              effectiveShowDescribe ||
              effectiveShowClone ||
              effectiveShowDelete ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-8 px-0"
                      aria-label={t('common.actions.more')}
                    >
                      <IconDots className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    {moreActions}
                    {moreActions ? <DropdownMenuSeparator /> : null}
                    {effectiveShowDescribe && (
                      <DropdownMenuItem
                        onSelect={() => setIsDescribeOpen(true)}
                      >
                        <IconClipboardText className="size-4" />
                        {t('common.actions.describe')}
                      </DropdownMenuItem>
                    )}
                    {effectiveShowClone && (
                      <DropdownMenuItem
                        onSelect={() =>
                          clonePath
                            ? navigate(clonePath)
                            : setIsCloneDialogOpen(true)
                        }
                      >
                        <IconCopy className="size-4" />
                        {t('common.actions.clone')}
                      </DropdownMenuItem>
                    )}
                    {effectiveShowDelete && (
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => setIsDeleteDialogOpen(true)}
                      >
                        <IconTrash className="size-4" />
                        {t('common.actions.delete')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        }
        stickyHeaderClassName={cn(
          'sticky z-40 bg-background px-4',
          isIframe
            ? 'top-0 -mx-4 lg:-mx-6 lg:px-6'
            : 'top-(--header-height) -mx-4 -mt-4 pt-2 lg:-mx-6 lg:px-6'
        )}
        tabs={tabs.map((tab) => ({
          value: tab.value,
          label: tab.label,
          content:
            typeof tab.content === 'function'
              ? tab.content(shellContext)
              : tab.content,
        }))}
        customizationKey={`resource-detail:${resourceType}`}
        defaultTab={defaultTab}
      />

      {effectiveShowDelete && (
        <ResourceDeleteConfirmationDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          resourceName={name}
          resourceType={resourceType}
          namespace={namespace}
          relatedServices={deleteRelatedServices}
        />
      )}

      {effectiveShowDescribe && (
        <DescribeDialog
          resourceType={resourceType}
          namespace={namespace}
          name={name}
          open={isDescribeOpen}
          onOpenChange={setIsDescribeOpen}
        />
      )}

      {effectiveShowClone && !clonePath ? (
        <CloneResourceDialog
          open={isCloneDialogOpen}
          onOpenChange={setIsCloneDialogOpen}
          resourceType={resourceType}
          resourceLabel={resourceLabel}
          sourceName={name}
          namespace={namespace}
          resource={data}
        />
      ) : null}
    </div>
  )
}
