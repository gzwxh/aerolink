import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'

interface NodeLinkProps {
  name?: string
  className?: string
  title?: string
}

// NodeLink 渲染节点名。只有当用户有权读取节点时才链接到节点
// 详情页；否则名称仍以纯文本展示，
// 这样在不授予节点界面访问权限的情况下依然能看懂 pod。
export function NodeLink({ name, className, title }: NodeLinkProps) {
  const can = useCan()

  if (!name) {
    return <span className={cn('text-muted-foreground', className)}>-</span>
  }

  if (!can('nodes', 'get')) {
    return (
      <span
        className={cn('text-muted-foreground', className)}
        title={title ?? name}
      >
        {name}
      </span>
    )
  }

  return (
    <Link
      to={`/nodes/${name}`}
      className={cn('app-link', className)}
      title={title ?? name}
    >
      {name}
    </Link>
  )
}
