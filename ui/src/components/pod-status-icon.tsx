import {
  IconAlertTriangle,
  IconCircleCheckFilled,
  IconCircleXFilled,
  IconExclamationCircle,
  IconLoader,
  IconTrash,
} from '@tabler/icons-react'

export type StatusType =
  | 'success'
  | 'warning'
  | 'error'
  | 'pending'
  | 'loading'
  | 'terminating'
  | 'default'

interface StatusIconProps {
  status: string
  className?: string
  showAnimation?: boolean
}

export const PodStatusIcon = ({
  status,
  className = '',
  showAnimation = true,
}: StatusIconProps) => {
  const getStatusType = (status: string): StatusType => {
    // 成功状态
    if (status === 'Running') {
      return 'success'
    }

    // 已完成 / 成功状态
    if (status === 'Succeeded' || status === 'Completed') {
      return 'success'
    }

    // 失败 / 错误状态
    if (
      status === 'Failed' ||
      status.startsWith('Init:ExitCode:') ||
      status.startsWith('Init:Signal:') ||
      status.startsWith('ExitCode:') ||
      status.startsWith('Signal:') ||
      status.includes('Error') ||
      status.includes('CrashLoopBackOff') ||
      status.includes('ImagePullBackOff') ||
      status.includes('ErrImagePull')
    ) {
      return 'error'
    }

    // 终止中状态
    if (status === 'Terminating') {
      return 'terminating'
    }

    // 告警状态
    if (
      status === 'Unknown' ||
      status === 'NotReady' ||
      status.includes('ImageInspectError') ||
      status.includes('RegistryUnavailable')
    ) {
      return 'warning'
    }

    // 等待 / 未就绪状态
    if (
      status === 'Pending' ||
      status === 'ContainerCreating' ||
      status === 'PodInitializing' ||
      status === 'SchedulingGated' ||
      status.startsWith('Init:') ||
      status.includes('Pending') ||
      status.includes('Creating') ||
      (status.includes('ImagePullBackOff') === false && status.includes('Pull'))
    ) {
      return 'pending'
    }

    // 进行中流程的加载状态
    if (
      status.includes('Pulling') ||
      status.includes('Starting') ||
      status.includes('Stopping')
    ) {
      return 'loading'
    }

    // 任何未匹配状态的默认值
    return 'default'
  }

  const renderIcon = () => {
    const statusType = getStatusType(status)
    const animationClass = showAnimation ? 'animate-spin' : ''

    switch (statusType) {
      case 'success':
        // Running 与「已完成」（Succeeded / Completed）都是成功态，共用 success。
        // 曾经把已完成画成 info 蓝以便与 Running 区分，但「蓝→info」的映射是给
        // 状态未知/进行中的，用在已完成的成功态上属语义拉伸（见 plans/
        // 2026-09-21-语义状态色token.md §7.1），已按语义统一。
        return <IconCircleCheckFilled className={`fill-success ${className}`} />

      case 'error':
        return <IconCircleXFilled className={`fill-destructive ${className}`} />

      case 'terminating':
        return <IconTrash className={`text-attention ${className}`} />

      case 'warning':
        return <IconAlertTriangle className={`fill-warning ${className}`} />

      case 'pending':
        return <IconLoader className={`text-info ${className}`} />

      case 'loading':
        return (
          <IconLoader
            className={`${animationClass} text-muted-foreground ${className}`}
          />
        )

      case 'default':
      default:
        return (
          <IconExclamationCircle
            className={`fill-muted-foreground ${className}`}
          />
        )
    }
  }

  return renderIcon()
}
