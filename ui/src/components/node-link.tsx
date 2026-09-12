import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'

interface NodeLinkProps {
  name?: string
  className?: string
  title?: string
}

// NodeLink renders a node name. It links to the node detail page only when the
// user may read nodes; otherwise the name stays visible as plain text so pods
// remain understandable without granting access to the node surface.
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
