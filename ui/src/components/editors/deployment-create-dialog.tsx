import { useState } from 'react'
import yaml from 'js-yaml'
import { Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { createResource } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'

import {
  NodeSchedulingSection,
  parseSchedulingFromYaml,
} from '../node-scheduling-section'
import { ConfigMapSelector } from '../selector/configmap-selector'
import { NamespaceSelector } from '../selector/namespace-selector'
import { PVCSelector } from '../selector/pvc-selector'
import { SecretSelector } from '../selector/secret-selector'
import { SimpleYamlEditor } from '../simple-yaml-editor'
import {
  ContainerConfig,
  createDefaultContainer,
  DeploymentFormData,
  generateWorkloadYaml,
  initialFormData,
  validateStep,
  VolumeForm,
  WorkloadResourceType,
} from './deployment-form'
import { EnvironmentEditor } from './environment-editor'
import { ImageEditor } from './image-editor'

const KIND_LABELS: Record<WorkloadResourceType, string> = {
  deployments: 'Deployment',
  pods: 'Pod',
  daemonsets: 'DaemonSet',
  statefulsets: 'StatefulSet',
  jobs: 'Job',
  cronjobs: 'CronJob',
}

interface DeploymentCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Defaults to 'deployments'; the wizard adapts its fields per kind. */
  resourceType?: WorkloadResourceType
  onSuccess: (resource: unknown, namespace: string) => void
  defaultNamespace?: string
}

export function DeploymentCreateDialog({
  open,
  onOpenChange,
  onSuccess,
  defaultNamespace,
  resourceType = 'deployments',
}: DeploymentCreateDialogProps) {
  const kindLabel = KIND_LABELS[resourceType]
  const showReplicas =
    resourceType === 'deployments' || resourceType === 'statefulsets'
  const [formData, setFormData] = useState<DeploymentFormData>({
    ...initialFormData,
    namespace: defaultNamespace || 'default',
  })
  const [isCreating, setIsCreating] = useState(false)
  const [step, setStep] = useState(1)
  const [editedYaml, setEditedYaml] = useState<string>('')
  const { t } = useTranslation()
  const totalSteps = 4

  const updateFormData = (updates: Partial<DeploymentFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }))
  }

  const addLabel = () => {
    setFormData((prev) => ({
      ...prev,
      labels: [...prev.labels, { key: '', value: '' }],
    }))
  }

  const updateLabel = (
    index: number,
    field: 'key' | 'value',
    value: string
  ) => {
    setFormData((prev) => ({
      ...prev,
      labels: prev.labels.map((label, i) =>
        i === index ? { ...label, [field]: value } : label
      ),
    }))
  }

  const removeLabel = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      labels: prev.labels.filter((_, i) => i !== index),
    }))
  }

  const addVolume = () => {
    setFormData((prev) => ({
      ...prev,
      podSpec: {
        ...prev.podSpec,
        volumes: [
          ...(prev.podSpec?.volumes || []),
          {
            name: `volume-${(prev.podSpec?.volumes?.length || 0) + 1}`,
            sourceType: 'emptyDir',
            options: {},
          },
        ],
      },
    }))
  }

  function updateVolume(index: number, key: string, value: string) {
    setFormData((prev) => {
      const volumes = [...(prev.podSpec?.volumes || [])]
      const updatedVolume = { ...volumes[index] }

      const isValidSourceType = (
        val: string
      ): val is VolumeForm['sourceType'] =>
        ['emptyDir', 'hostPath', 'configMap', 'secret', 'pvc'].includes(val)

      if (key === 'name') {
        updatedVolume.name = value
      } else if (key === 'sourceType' && isValidSourceType(value)) {
        updatedVolume.sourceType = value
      } else {
        updatedVolume.options = {
          ...(updatedVolume.options || {}),
          [key]: value,
        }
      }

      volumes[index] = updatedVolume

      return {
        ...prev,
        podSpec: {
          ...prev.podSpec,
          volumes,
        },
      }
    })
  }

  const removeVolume = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      podSpec: {
        ...prev.podSpec,
        volumes: (prev.podSpec?.volumes || []).filter((_, i) => i !== index),
      },
    }))
  }

  const addContainer = () => {
    setFormData((prev) => ({
      ...prev,
      containers: [
        ...prev.containers,
        createDefaultContainer(prev.containers.length),
      ],
    }))
  }

  const removeContainer = (index: number) => {
    if (formData.containers.length <= 1) {
      toast.error(t('workloadWizard.atLeastOneContainer'))
      return
    }
    setFormData((prev) => ({
      ...prev,
      containers: prev.containers.filter((_, i) => i !== index),
    }))
  }

  const updateContainer = (
    index: number,
    updates: Partial<ContainerConfig>
  ) => {
    setFormData((prev) => ({
      ...prev,
      containers: prev.containers.map((container, i) =>
        i === index ? { ...container, ...updates } : container
      ),
    }))
  }

  const isStepValid = (stepNum: number) => validateStep(formData, stepNum)

  const handleNext = () => {
    if (isStepValid(step)) {
      setStep((prev) => Math.min(prev + 1, totalSteps))
    }
  }

  const handlePrevious = () => {
    setStep((prev) => Math.max(prev - 1, 1))
  }

  const handleCreate = async () => {
    if (!isStepValid(step)) return

    setIsCreating(true)
    try {
      let manifest: Record<string, unknown>
      try {
        const yamlContent =
          editedYaml || generateWorkloadYaml(formData, resourceType)
        manifest = yaml.load(yamlContent) as Record<string, unknown>
      } catch (yamlError) {
        console.error('Failed to parse YAML:', yamlError)
        toast.error(
          t('workloadWizard.invalidYaml', {
            message:
              yamlError instanceof Error ? yamlError.message : 'Unknown error',
          })
        )
        return
      }

      const metadata = manifest.metadata as
        { name?: string; namespace?: string } | undefined

      // Validate required fields
      if (!metadata?.name || !metadata?.namespace) {
        toast.error(
          t('workloadWizard.mustHaveNameNamespace', { kind: kindLabel })
        )
        return
      }

      const created = await createResource(
        resourceType,
        metadata.namespace,
        manifest as never
      )

      toast.success(
        t('workloadWizard.created', {
          kind: kindLabel,
          name: metadata.name,
          namespace: metadata.namespace,
        })
      )

      // Reset form and close dialog
      setFormData({
        ...initialFormData,
        namespace: defaultNamespace || 'default',
      })
      setStep(1)
      setEditedYaml('')
      onOpenChange(false)

      // Call success callback with created resource
      onSuccess(created, metadata.namespace)
    } catch (error) {
      console.error('Failed to create workload:', error)
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsCreating(false)
    }
  }

  const handleDialogChange = (open: boolean) => {
    if (!open) {
      // Reset form when dialog closes
      setFormData({
        ...initialFormData,
        namespace: defaultNamespace || 'default',
      })
      setStep(1)
      setEditedYaml('')
    }
    onOpenChange(open)
  }

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">
                {t('workloadWizard.name', { kind: kindLabel })}
              </Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => {
                  const value = e.target.value
                  updateFormData({
                    name: value,
                  })
                  // Update app label with full name value
                  const appLabelIndex = formData.labels.findIndex(
                    (l) => l.key === 'app'
                  )
                  if (appLabelIndex !== -1) {
                    updateLabel(appLabelIndex, 'value', value)
                  }
                }}
                placeholder="my-app"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="namespace">{t('workloadWizard.namespace')}</Label>
              <NamespaceSelector
                selectedNamespace={formData.namespace}
                handleNamespaceChange={(namespace) =>
                  updateFormData({ namespace })
                }
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('workloadWizard.labels')}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addLabel}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  {t('workloadWizard.addLabel')}
                </Button>
              </div>
              <div className="space-y-2">
                {formData.labels.map((label, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <Input
                      placeholder="key"
                      value={label.key}
                      onChange={(e) =>
                        updateLabel(index, 'key', e.target.value)
                      }
                    />
                    <Input
                      placeholder="value"
                      value={label.value}
                      onChange={(e) =>
                        updateLabel(index, 'value', e.target.value)
                      }
                    />
                    {formData.labels.length > 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => removeLabel(index)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {showReplicas && (
              <div className="space-y-2">
                <Label htmlFor="replicas">{t('workloadWizard.replicas')}</Label>
                <Input
                  id="replicas"
                  type="number"
                  min="1"
                  value={formData.replicas}
                  onChange={(e) =>
                    updateFormData({ replicas: parseInt(e.target.value) || 1 })
                  }
                  required
                />
              </div>
            )}
            {resourceType === 'cronjobs' && (
              <div className="space-y-2">
                <Label htmlFor="schedule">{t('workloadWizard.schedule')}</Label>
                <Input
                  id="schedule"
                  value={formData.schedule || '*/5 * * * *'}
                  onChange={(e) => updateFormData({ schedule: e.target.value })}
                  placeholder="*/5 * * * *"
                  required
                />
              </div>
            )}
          </div>
        )
      case 2:
        return (
          <div className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Label>{t('workloadWizard.volume')}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addVolume}
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('workloadWizard.addVolume')}
              </Button>
            </div>
            <div className="space-y-2">
              {(formData.podSpec?.volumes || []).map((volume, index) => (
                <div key={index} className="flex gap-2 items-center">
                  <Input
                    className="flex-1"
                    placeholder={t('workloadWizard.volumeNamePlaceholder')}
                    value={volume.name}
                    onChange={(e) =>
                      updateVolume(index, 'name', e.target.value)
                    }
                  />
                  <Select
                    value={volume.sourceType}
                    onValueChange={(val) =>
                      updateVolume(index, 'sourceType', val)
                    }
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue
                        placeholder={t('workloadWizard.selectVolumeType')}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="emptyDir">emptyDir</SelectItem>
                      <SelectItem value="hostPath">hostPath</SelectItem>
                      <SelectItem value="configMap">configMap</SelectItem>
                      <SelectItem value="secret">secret</SelectItem>
                      <SelectItem value="pvc">pvc</SelectItem>
                    </SelectContent>
                  </Select>
                  {volume.sourceType === 'emptyDir' && (
                    <Input
                      className="flex-1 select-none cursor-default text-muted-foreground bg-muted"
                      readOnly
                      onFocus={(e) => e.target.blur()}
                      tabIndex={-1}
                    />
                  )}
                  {volume.sourceType === 'hostPath' && (
                    <Input
                      className="flex-1"
                      placeholder={t('workloadWizard.hostPathPlaceholder')}
                      value={volume.options?.path || ''}
                      onChange={(e) =>
                        updateVolume(index, 'path', e.target.value)
                      }
                    />
                  )}

                  {volume.sourceType === 'configMap' && (
                    <ConfigMapSelector
                      className="flex-1"
                      selectedConfigMap={volume.options?.configMapName || ''}
                      onConfigMapChange={(val) =>
                        updateVolume(index, 'configMapName', val)
                      }
                      namespace={formData.namespace}
                      placeholder="Select configmap"
                    />
                  )}

                  {volume.sourceType === 'secret' && (
                    <SecretSelector
                      className="flex-1"
                      selectedSecret={volume.options?.secretName || ''}
                      onSecretChange={(val) =>
                        updateVolume(index, 'secretName', val)
                      }
                      namespace={formData.namespace}
                      placeholder="Select secret"
                    />
                  )}

                  {volume.sourceType === 'pvc' && (
                    <PVCSelector
                      className="flex-1"
                      selectedPVC={volume.options?.claimName || ''}
                      onPVCChange={(val) =>
                        updateVolume(index, 'claimName', val)
                      }
                      namespace={formData.namespace}
                      placeholder="Select PVC"
                    />
                  )}

                  {(formData.podSpec?.volumes?.length || 0) > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeVolume(index)}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      case 3:
        return (
          <div className="space-y-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Label className="text-lg font-medium">
                {t('workloadWizard.containersTitle')}
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addContainer}
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('workloadWizard.addContainer')}
              </Button>
            </div>
            {formData.containers.map((containerConfig, containerIndex) => (
              <Card key={containerIndex}>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <CardTitle className="text-base">
                      {t('workloadWizard.containerTitle', {
                        index: containerIndex + 1,
                      })}
                    </CardTitle>
                    {formData.containers.length > 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => removeContainer(containerIndex)}
                        aria-label={t('workloadWizard.removeContainer', {
                          index: containerIndex + 1,
                        })}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <ImageEditor
                        container={containerConfig.container}
                        onUpdate={(updates) =>
                          updateContainer(containerIndex, {
                            image: updates.image,
                            container: {
                              ...containerConfig.container,
                              ...updates,
                            },
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`name-${containerIndex}`}>
                        {t('workloadWizard.containerName')}
                      </Label>
                      <Input
                        id={`name-${containerIndex}`}
                        value={containerConfig.name}
                        onChange={(e) =>
                          updateContainer(containerIndex, {
                            name: e.target.value,
                            container: {
                              ...containerConfig.container,
                              name: e.target.value,
                            },
                          })
                        }
                        placeholder={t(
                          'workloadWizard.containerNamePlaceholder'
                        )}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>{t('workloadWizard.resources')}</Label>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label className="text-sm text-muted-foreground">
                          {t('workloadWizard.requests')}
                        </Label>
                        <div className="space-y-1">
                          <Input
                            placeholder={t(
                              'workloadWizard.cpuRequestsPlaceholder'
                            )}
                            value={containerConfig.resources.requests.cpu}
                            onChange={(e) =>
                              updateContainer(containerIndex, {
                                resources: {
                                  ...containerConfig.resources,
                                  requests: {
                                    ...containerConfig.resources.requests,
                                    cpu: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                          <Input
                            placeholder={t(
                              'workloadWizard.memoryRequestsPlaceholder'
                            )}
                            value={containerConfig.resources.requests.memory}
                            onChange={(e) =>
                              updateContainer(containerIndex, {
                                resources: {
                                  ...containerConfig.resources,
                                  requests: {
                                    ...containerConfig.resources.requests,
                                    memory: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm text-muted-foreground">
                          {t('workloadWizard.limits')}
                        </Label>
                        <div className="space-y-1">
                          <Input
                            placeholder={t(
                              'workloadWizard.cpuLimitsPlaceholder'
                            )}
                            value={containerConfig.resources.limits.cpu}
                            onChange={(e) =>
                              updateContainer(containerIndex, {
                                resources: {
                                  ...containerConfig.resources,
                                  limits: {
                                    ...containerConfig.resources.limits,
                                    cpu: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                          <Input
                            placeholder={t(
                              'workloadWizard.memoryLimitsPlaceholder'
                            )}
                            value={containerConfig.resources.limits.memory}
                            onChange={(e) =>
                              updateContainer(containerIndex, {
                                resources: {
                                  ...containerConfig.resources,
                                  limits: {
                                    ...containerConfig.resources.limits,
                                    memory: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <EnvironmentEditor
                      container={containerConfig.container}
                      namespace={formData.namespace}
                      onUpdate={(updates) =>
                        updateContainer(containerIndex, {
                          container: {
                            ...containerConfig.container,
                            ...updates,
                          },
                        })
                      }
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={`port-${containerIndex}`}>
                        {t('workloadWizard.port')}
                      </Label>
                      <Input
                        id={`port-${containerIndex}`}
                        type="number"
                        min="1"
                        max="65535"
                        value={containerConfig.port || ''}
                        onChange={(e) =>
                          updateContainer(containerIndex, {
                            port: e.target.value
                              ? parseInt(e.target.value)
                              : undefined,
                          })
                        }
                        placeholder="8080"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`pullPolicy-${containerIndex}`}>
                        {t('workloadWizard.pullPolicy')}
                      </Label>
                      <Select
                        value={containerConfig.pullPolicy}
                        onValueChange={(value) =>
                          updateContainer(containerIndex, {
                            pullPolicy: value as
                              'Always' | 'IfNotPresent' | 'Never',
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="IfNotPresent">
                            IfNotPresent
                          </SelectItem>
                          <SelectItem value="Always">Always</SelectItem>
                          <SelectItem value="Never">Never</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {(formData.podSpec?.volumes?.length || 0) > 0 && (
                    <div className="space-y-2">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <Label>{t('workloadWizard.volumeMounts')}</Label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const availableVolumes =
                              formData.podSpec?.volumes || []
                            const newMount = {
                              name:
                                availableVolumes.length > 0
                                  ? availableVolumes[0].name
                                  : '',
                              mountPath: '',
                              readOnly: false,
                            }
                            const updatedMounts = [
                              ...(containerConfig.volumeMounts || []),
                              newMount,
                            ]
                            updateContainer(containerIndex, {
                              volumeMounts: updatedMounts,
                            })
                          }}
                        >
                          <Plus className="w-4 h-4 mr-2" />
                          {t('workloadWizard.addVolumeMount')}
                        </Button>
                      </div>

                      {(containerConfig.volumeMounts || []).map(
                        (mount, mountIndex) => (
                          <div
                            key={mountIndex}
                            className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"
                          >
                            <Select
                              value={mount.name}
                              onValueChange={(val) => {
                                const updatedMounts = [
                                  ...(containerConfig.volumeMounts || []),
                                ]
                                updatedMounts[mountIndex] = {
                                  ...updatedMounts[mountIndex],
                                  name: val,
                                }
                                updateContainer(containerIndex, {
                                  volumeMounts: updatedMounts,
                                })
                              }}
                            >
                              <SelectTrigger className="w-full sm:w-[160px]">
                                <SelectValue placeholder="Volume name" />
                              </SelectTrigger>
                              <SelectContent>
                                {(formData.podSpec?.volumes || []).map(
                                  (vol) => (
                                    <SelectItem key={vol.name} value={vol.name}>
                                      {vol.name}
                                    </SelectItem>
                                  )
                                )}
                              </SelectContent>
                            </Select>

                            <Input
                              className="flex-1"
                              placeholder={t(
                                'workloadWizard.mountPathPlaceholder'
                              )}
                              value={mount.mountPath}
                              onChange={(e) => {
                                const updatedMounts = [
                                  ...(containerConfig.volumeMounts || []),
                                ]
                                updatedMounts[mountIndex] = {
                                  ...updatedMounts[mountIndex],
                                  mountPath: e.target.value,
                                }
                                updateContainer(containerIndex, {
                                  volumeMounts: updatedMounts,
                                })
                              }}
                            />
                            <Input
                              className="flex-1"
                              placeholder={t(
                                'workloadWizard.subPathPlaceholder'
                              )}
                              value={mount.subPath || ''}
                              onChange={(e) => {
                                const updatedMounts = [
                                  ...(containerConfig.volumeMounts || []),
                                ]
                                updatedMounts[mountIndex] = {
                                  ...updatedMounts[mountIndex],
                                  subPath: e.target.value || undefined,
                                }
                                updateContainer(containerIndex, {
                                  volumeMounts: updatedMounts,
                                })
                              }}
                            />

                            <Select
                              value={String(mount.readOnly === true)}
                              onValueChange={(val) => {
                                const updatedMounts = [
                                  ...(containerConfig.volumeMounts || []),
                                ]
                                updatedMounts[mountIndex] = {
                                  ...updatedMounts[mountIndex],
                                  readOnly: val === 'true',
                                }
                                updateContainer(containerIndex, {
                                  volumeMounts: updatedMounts,
                                })
                              }}
                            >
                              <SelectTrigger className="w-full sm:w-[160px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="true">
                                  {t('workloadWizard.readOnly')}
                                </SelectItem>
                                <SelectItem value="false">
                                  {t('workloadWizard.writable')}
                                </SelectItem>
                              </SelectContent>
                            </Select>

                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="w-7 h-7"
                              aria-label={t('workloadWizard.removeMount', {
                                index: mountIndex + 1,
                              })}
                              onClick={() => {
                                const updatedMounts =
                                  containerConfig.volumeMounts?.filter(
                                    (_, i) => i !== mountIndex
                                  ) || []
                                updateContainer(containerIndex, {
                                  volumeMounts: updatedMounts,
                                })
                              }}
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </CardContent>
                {containerIndex < formData.containers.length - 1 && (
                  <Separator />
                )}
              </Card>
            ))}
          </div>
        )

      case 4: {
        const currentYaml =
          editedYaml || generateWorkloadYaml(formData, resourceType)
        const supportsScheduling = [
          'deployments',
          'statefulsets',
          'daemonsets',
          'jobs',
        ].includes(resourceType)
        return (
          <div className="space-y-4">
            <h3 className="text-lg font-medium">
              {t('workloadWizard.reviewTitle')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t('workloadWizard.reviewDescription', {
                kind: kindLabel.toLowerCase(),
              })}
            </p>
            {supportsScheduling && (
              <NodeSchedulingSection
                value={
                  formData.podSpec.scheduling ||
                  parseSchedulingFromYaml(currentYaml)
                }
                onChange={(scheduling) =>
                  setFormData((prev) => ({
                    ...prev,
                    podSpec: { ...prev.podSpec, scheduling },
                  }))
                }
              />
            )}
            <SimpleYamlEditor
              value={currentYaml}
              onChange={(value) => setEditedYaml(value || '')}
              disabled={false}
              height="500px"
            />
          </div>
        )
      }

      default:
        return null
    }
  }

  const getStepTitle = () => {
    switch (step) {
      case 1:
        return t('workloadWizard.stepBasic')
      case 2:
        return t('workloadWizard.stepPod')
      case 3:
        return t('workloadWizard.stepContainers')
      case 4:
        return t('workloadWizard.stepYaml')
      default:
        return ''
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent
        className="!max-w-4xl max-h-[90vh] overflow-y-auto sm:!max-w-4xl"
        onPointerDownOutside={(e) => {
          e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Create {kindLabel}</DialogTitle>
          <DialogDescription>
            Step {step} of {totalSteps}: {getStepTitle()}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {/* Progress indicator */}
          <div className="flex justify-between mb-6">
            {Array.from({ length: totalSteps }, (_, i) => i + 1).map(
              (stepNum) => (
                <div
                  key={stepNum}
                  className={`flex items-center ${
                    stepNum < totalSteps ? 'flex-1' : ''
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                      stepNum <= step
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {stepNum}
                  </div>
                  {stepNum < totalSteps && (
                    <div
                      className={`flex-1 h-0.5 mx-2 ${
                        stepNum < step ? 'bg-primary' : 'bg-muted'
                      }`}
                    />
                  )}
                </div>
              )
            )}
          </div>

          {renderStep()}
        </div>

        <DialogFooter>
          <div className="flex justify-between w-full">
            <div>
              {step > 1 && (
                <Button variant="outline" onClick={handlePrevious}>
                  {t('workloadWizard.previous')}
                </Button>
              )}
            </div>
            <div className="space-x-2">
              <Button
                variant="outline"
                onClick={() => handleDialogChange(false)}
              >
                {t('common.actions.cancel')}
              </Button>
              {step < totalSteps ? (
                <Button onClick={handleNext} disabled={!isStepValid(step)}>
                  {t('workloadWizard.next')}
                </Button>
              ) : (
                <Button
                  onClick={handleCreate}
                  disabled={!isStepValid(step) || isCreating}
                >
                  {isCreating
                    ? t('workloadWizard.creating')
                    : t('workloadWizard.createButton', { kind: kindLabel })}
                </Button>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
