import React from 'react'
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react'

interface NetworkSpeedIndicatorProps {
  uploadSpeed: number
  downloadSpeed: number
}

// 把每秒字节数格式化为易读形式
const formatSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond === 0) return '0 B/s'

  const k = 1024
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k))

  const value = bytesPerSecond / Math.pow(k, i)
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${sizes[i]}`
}

export const NetworkSpeedIndicator: React.FC<NetworkSpeedIndicatorProps> = ({
  uploadSpeed,
  downloadSpeed,
}) => {
  // 只在有网络活动时显示
  if (uploadSpeed === 0 && downloadSpeed === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {uploadSpeed > 0 && (
        <div className="flex items-center gap-1">
          <IconArrowUp className="h-3 w-3 text-info" />
          <span>{formatSpeed(uploadSpeed)}</span>
        </div>
      )}
      {downloadSpeed > 0 && (
        <div className="flex items-center gap-1">
          <IconArrowDown className="h-3 w-3 text-success" />
          <span>{formatSpeed(downloadSpeed)}</span>
        </div>
      )}
    </div>
  )
}
