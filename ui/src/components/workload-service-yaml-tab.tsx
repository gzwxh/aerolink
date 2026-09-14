import { useMemo, useState } from 'react'
import * as yaml from 'js-yaml'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type { Deployment } from 'kubernetes-types/apps/v1'
import type { Service } from 'kubernetes-types/core/v1'
import { deleteResource, updateResource } from '@/lib/api'
import { translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'

/**
 * Shows the Services related to a workload (created together with it by the
 * create page) as editable YAML cards, so users can view/modify/delete them
 * without leaving the workload detail page.
 */
export function WorkloadServiceYamlTab({
  deployment,
  namespace,
  services,
}: {
  deployment: Deployment
  namespace: string
  services: Service[]
}) {
  const { t } = useTranslation()
  const name = deployment.metadata?.name || ''
  const related = useMemo(() => {
    const matchLabels = deployment.spec?.selector?.matchLabels || {}
    return services.filter((svc) => {
      const svcName = svc.metadata?.name || ''
      if (svcName === name || svcName.startsWith(`${name}-`)) return true
      const selector = (svc.spec?.selector || {}) as Record<string, string>
      return Object.entries(matchLabels).every(([k, v]) => selector[k] === v)
    })
  }, [services, name, deployment])

  return (
    <div className="space-y-4">
      {related.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t(
            'workloadServiceYaml.noServices',
            '该工作负载暂无关联的 Service（创建工作负载时的网络配置会自动生成）。'
          )}
        </p>
      )}
      {related.map((svc) => (
        <ServiceYamlCard
          key={svc.metadata?.name}
          service={svc}
          namespace={namespace}
        />
      ))}
    </div>
  )
}

function ServiceYamlCard({
  service,
  namespace,
}: {
  service: Service
  namespace: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const svcName = service.metadata?.name || ''
  const [content, setContent] = useState(() =>
    yaml.dump(service, { indent: 2, noRefs: true })
  )
  // Read-only until the user explicitly enters edit mode.
  const [isEditing, setIsEditing] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const parseDoc = () => {
    try {
      return { doc: yaml.load(content) as Service, error: null as null | string }
    } catch (err) {
      return { doc: null, error: translateError(err, t) }
    }
  }

  const handleSave = async () => {
    const { doc, error } = parseDoc()
    if (error || !doc) {
      toast.error(error || t('serviceYaml.invalidYaml', 'YAML 格式不正确'))
      return
    }
    setIsSaving(true)
    try {
      await updateResource('services', svcName, namespace, doc)
      queryClient.invalidateQueries()
      toast.success(
        t('serviceYaml.saved', { name: svcName, defaultValue: 'Service {{name}} 已更新' })
      )
      setIsEditing(false)
    } catch (err) {
      toast.error(translateError(err, t))
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteResource('services', svcName, namespace)
      queryClient.invalidateQueries()
      toast.success(
        t('serviceYaml.deleted', { name: svcName, defaultValue: 'Service {{name}} 已删除' })
      )
    } catch (err) {
      toast.error(translateError(err, t))
    } finally {
      setIsDeleting(false)
    }
  }

  const serviceType = String(
    (service.spec as Record<string, unknown> | undefined)?.type || 'ClusterIP'
  )

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">
          Service: {svcName}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {serviceType}
          </span>
        </CardTitle>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setIsEditing(false)
                  setContent(yaml.dump(service, { indent: 2, noRefs: true }))
                }}
                disabled={isSaving || isDeleting}
              >
                {t('common.actions.cancel', '取消')}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={isSaving}>
                {t('common.actions.save', '保存')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteConfirmOpen(true)}
                disabled={isSaving}
              >
                {t('common.actions.delete', '删除')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
              {t('common.actions.edit', '编辑')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <SimpleYamlEditor
            value={content}
            onChange={(value) => setContent(value || '')}
            disabled={!isEditing}
            height="300px"
          />
        </div>
      </CardContent>
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('serviceYaml.deleteTitle', {
                name: svcName,
                defaultValue: '删除 Service {{name}}？',
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                'serviceYaml.deleteDescription',
                '删除后通过该 Service 的外部访问将立即中断，且无法恢复。'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={isDeleting}
            >
              {t('common.actions.cancel', '取消')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {t('common.actions.delete', '删除')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
