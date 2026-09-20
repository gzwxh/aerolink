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
        if (status === 'Running') {
          return (
            <IconCircleCheckFilled
              className={`fill-green-500 dark:fill-green-400 ${className}`}
            />
          )
        }
        // 已完成 / 成功状态
        return (
          <IconCircleCheckFilled
            className={`fill-blue-500 dark:fill-blue-400 ${className}`}
          />
        )

      case 'error':
        return (
          <IconCircleXFilled
            className={`fill-red-500 dark:fill-red-400 ${className}`}
          />
        )

      case 'terminating':
        return (
          <IconTrash
            className={`text-orange-500 dark:text-orange-400 ${className}`}
          />
        )

      case 'warning':
        return (
          <IconAlertTriangle
            className={`fill-yellow-500 dark:fill-yellow-400 ${className}`}
          />
        )

      case 'pending':
        return (
          <IconLoader
            className={`text-blue-500 dark:text-blue-400 ${className}`}
          />
        )

      case 'loading':
        return (
          <IconLoader
            className={`${animationClass} text-gray-500 dark:text-gray-400 ${className}`}
          />
        )

      case 'default':
      default:
        return (
          <IconExclamationCircle
            className={`fill-gray-500 dark:fill-gray-400 ${className}`}
          />
        )
    }
  }

  return renderIcon()
}
