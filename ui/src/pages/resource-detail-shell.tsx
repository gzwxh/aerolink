import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconCopy,
  IconLoader,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { type ResourceType } from '@/types/api'
import { getResourceListPath } from '@/lib/resource-catalog'
import { getResourceMetadata } from '@/lib/resource-metadata'
import { cn, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { usePageTitle } from '@/hooks/use-page-title'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  titleIcon?: ReactNode
  yamlToolbar?:
    ReactNode | ((context: ResourceDetailShellContext<T>) => ReactNode)
  loadingMessage?: string
  yamlTabLabel?: ReactNode
  showDescribe?: boolean
  showDelete?: boolean
  showClone?: boolean
  /**
   * Whether the YAML tab offers editing and saving. Read-only users still get
   * the tab so they can inspect the manifest.
   */
  yamlEditable?: boolean
  defaultTab?: string
  /**
   * Resource used for the permission checks; defaults to `resourceType`.
   * Actions are gated automatically for resources Kite knows about, pass a
   * value to force gating for others (e.g. CRDs).
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
  titleIcon,
  yamlToolbar,
  loadingMessage,
  yamlTabLabel,
  showDescribe = true,
  showDelete = true,
  showClone = true,
  yamlEditable = true,
  defaultTab,
  permissionResource,
}: ResourceDetailShellProps<T>) {
  const { t } = useTranslation()
  const [yamlContent, setYamlContent] = useState('')
  const [isSavingYaml, setIsSavingYaml] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isCloneDialogOpen, setIsCloneDialogOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const isIframe = searchParams.get('iframe') === 'true'
  const navigate = useNavigate()
  const listPath = getResourceListPath(resourceType)

  // Every action used to default to visible, which left read-only users with
  // buttons the backend rejects. They are gated by default for the resources
  // Kite knows about; unknown CRs keep the previous behaviour.
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
    if (data) {
      setYamlContent(yaml.dump(data, { indent: 2 }))
    }
  }, [data])

  const handleRefresh = useCallback(async () => {
    setRefreshKey((prev) => prev + 1)
    setIsRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setIsRefreshing(false)
    }
  }, [onRefresh])

  const handleSaveYaml = useCallback(
    async (content: T) => {
      if (!onSaveYaml) {
        return
      }

      setIsSavingYaml(true)
      try {
        await onSaveYaml(content)
      } catch (saveError) {
        toast.error(translateError(saveError, t))
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
              onChange={setYamlContent}
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

    // Resource deleted (or never existed): offer a way back to the list
    // instead of a dead "retry" screen.
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
              <Button
                disabled={isRefreshing}
                variant="outline"
                size="sm"
                onClick={handleRefresh}
              >
                <IconRefresh className="w-4 h-4" />
                {t('common.actions.refresh')}
              </Button>
              {effectiveShowDescribe ? (
                <DescribeDialog
                  resourceType={resourceType}
                  namespace={namespace}
                  name={name}
                />
              ) : null}
              {effectiveShowClone ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsCloneDialogOpen(true)}
                >
                  <IconCopy className="size-4" />
                  {t('common.actions.clone')}
                </Button>
              ) : null}
              {headerActions}
              {effectiveShowDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setIsDeleteDialogOpen(true)}
                >
                  <IconTrash className="w-4 h-4" />
                  {t('common.actions.delete')}
                </Button>
              )}
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
        />
      )}

      {effectiveShowClone ? (
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
