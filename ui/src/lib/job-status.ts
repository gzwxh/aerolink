import type { Job } from 'kubernetes-types/batch/v1'
import type { useTranslation } from 'react-i18next'

import { neutralBadge, statusBadge, type StatusBadgeStyle } from './status-badge'

type TranslationFn = ReturnType<typeof useTranslation>['t']

export interface JobStatusBadge {
  key: 'failed' | 'complete' | 'running' | 'pending'
  label: string
  /** 徽标样式：统一走语义 token（见 lib/status-badge.ts），不再用品牌色/实心红。 */
  style: StatusBadgeStyle
}

export function getJobStatusBadge(job: Job): JobStatusBadge {
  const conditions = job.status?.conditions || []
  const completed = conditions.find(
    (condition) => condition.type === 'Complete'
  )
  const failed = conditions.find((condition) => condition.type === 'Failed')

  if (failed?.status === 'True') {
    return { key: 'failed', label: 'Failed', style: statusBadge('failure') }
  }

  if (completed?.status === 'True') {
    return { key: 'complete', label: 'Complete', style: statusBadge('success') }
  }

  if ((job.status?.active || 0) > 0) {
    return { key: 'running', label: 'Running', style: statusBadge('info') }
  }

  return { key: 'pending', label: 'Pending', style: neutralBadge() }
}

export function formatJobStatusBadge(
  badge: JobStatusBadge,
  t: TranslationFn,
  namespace = 'status'
) {
  return t(`${namespace}.${badge.key}`, {
    defaultValue: badge.label,
  })
}
