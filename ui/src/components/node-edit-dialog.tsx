import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Node } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { NodeWithMetrics } from '@/types/api'
import { updateResource } from '@/lib/api'
import { getAge } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { KVEditor, type KVPair } from '@/components/kv-editor'

const TAINT_EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const

interface TaintRow {
  key: string
  value: string
  effect: string
}

function toRecord(pairs: KVPair[]): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  for (const pair of pairs) {
    const key = pair.key.trim()
    if (key) {
      record[key] = pair.value
    }
  }
  return Object.keys(record).length > 0 ? record : undefined
}

interface NodeEditDialogProps {
  node: NodeWithMetrics
  open: boolean
  onOpenChange: (open: boolean) => void
}

// NodeEditDialog edits the parts of a node that operators actually change:
// taints, labels and annotations. "Edit as YAML" hands off to the detail page's
// YAML tab for anything else.
export function NodeEditDialog({
  node,
  open,
  onOpenChange,
}: NodeEditDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [tab, setTab] = useState('taints')
  const [labels, setLabels] = useState<KVPair[]>([])
  const [annotations, setAnnotations] = useState<KVPair[]>([])
  const [taints, setTaints] = useState<TaintRow[]>([])
  const [isSaving, setIsSaving] = useState(false)

  const name = node.metadata?.name || ''

  useEffect(() => {
    if (!open) return
    setTab('taints')
    setLabels(
      Object.entries(node.metadata?.labels ?? {}).map(([key, value]) => ({
        key,
        value,
      }))
    )
    setAnnotations(
      Object.entries(node.metadata?.annotations ?? {}).map(([key, value]) => ({
        key,
        value: value ?? '',
      }))
    )
    setTaints(
      (node.spec?.taints ?? []).map((taint) => ({
        key: taint.key,
        value: taint.value ?? '',
        effect: taint.effect || 'NoSchedule',
      }))
    )
  }, [open, node])

  const updateTaint = (index: number, patch: Partial<TaintRow>) =>
    setTaints((prev) =>
      prev.map((taint, i) => (i === index ? { ...taint, ...patch } : taint))
    )

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const nextTaints = taints
        .filter((taint) => taint.key.trim())
        .map((taint) => ({
          key: taint.key.trim(),
          ...(taint.value.trim() ? { value: taint.value.trim() } : {}),
          effect: taint.effect,
        }))
      const next: Node = {
        ...node,
        metadata: {
          ...node.metadata,
          labels: toRecord(labels),
          annotations: toRecord(annotations),
        },
        spec: {
          ...node.spec,
          taints: nextTaints,
        },
      }
      await updateResource('nodes', name, undefined, next)
      toast.success(
        t('nodeEdit.saved', {
          name,
          defaultValue: 'Node {{name}} updated',
        })
      )
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
      onOpenChange(false)
    } catch (err) {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-3 pr-12">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {t('nodeEdit.title', {
              name,
              defaultValue: 'Edit node: {{name}}',
            })}
            <Badge variant="outline" className="text-xs font-normal">
              {t('common.fields.age', 'Age')}:{' '}
              {node.metadata?.creationTimestamp
                ? getAge(node.metadata.creationTimestamp)
                : '-'}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="max-w-sm space-y-1.5">
            <Label className="text-xs">{t('common.fields.name', 'Name')}</Label>
            <Input value={name} disabled className="bg-muted" />
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="taints">
                {t('nodeEdit.taintsTab', 'Taints')}
              </TabsTrigger>
              <TabsTrigger value="labels">
                {t('nodeEdit.labelsAnnotationsTab', 'Labels & Annotations')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="taints" className="space-y-3 pt-3">
              {taints.length > 0 && (
                <div className="space-y-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 text-xs font-medium text-muted-foreground">
                    <span>{t('nodeEdit.key', 'Key')}</span>
                    <span>{t('nodeEdit.value', 'Value')}</span>
                    <span>{t('nodeEdit.effect', 'Effect')}</span>
                    <span className="w-14" />
                  </div>
                  {taints.map((taint, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
                    >
                      <Input
                        value={taint.key}
                        onChange={(e) =>
                          updateTaint(index, { key: e.target.value })
                        }
                        className="h-8"
                      />
                      <Input
                        value={taint.value}
                        onChange={(e) =>
                          updateTaint(index, { value: e.target.value })
                        }
                        className="h-8"
                      />
                      <Select
                        value={taint.effect}
                        onValueChange={(value) =>
                          updateTaint(index, { effect: value })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TAINT_EFFECTS.map((effect) => (
                            <SelectItem key={effect} value={effect}>
                              {effect}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-14 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setTaints((prev) =>
                            prev.filter((_, i) => i !== index)
                          )
                        }
                      >
                        {t('nodeEdit.remove', 'Remove')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setTaints((prev) => [
                    ...prev,
                    { key: '', value: '', effect: 'NoSchedule' },
                  ])
                }
              >
                {t('nodeEdit.addTaint', 'Add Taint')}
              </Button>
            </TabsContent>

            <TabsContent value="labels" className="space-y-6 pt-3">
              <KVEditor
                title={t('common.fields.labels', 'Labels')}
                hint={t(
                  'nodeEdit.labelsHint',
                  'Key-value pairs attached to identifying attributes.'
                )}
                pairs={labels}
                addLabel={t('nodeEdit.addLabel', 'Add Label')}
                onChange={setLabels}
              />
              <KVEditor
                title={t('common.fields.annotations', 'Annotations')}
                pairs={annotations}
                addLabel={t('nodeEdit.addAnnotation', 'Add Annotation')}
                onChange={setAnnotations}
              />
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
              navigate(`/nodes/${name}?tab=yaml`)
            }}
            disabled={isSaving}
          >
            {t('nodeEdit.editAsYaml', 'Edit as YAML')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving
              ? t('common.actions.saving', 'Saving...')
              : t('common.actions.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
