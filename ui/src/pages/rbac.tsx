import { Navigate, useSearchParams } from 'react-router-dom'

/**
 * RBAC now lives inside System Settings. This keeps the old `/rbac` deep links
 * working (namespace permission dialog, user group grants, bookmarks) while
 * renaming `tab` to the nested RBAC tab param so it cannot collide with the
 * settings section param.
 */
export function RBACRedirect() {
  const [searchParams] = useSearchParams()
  const params = new URLSearchParams()
  searchParams.forEach((value, key) => {
    params.set(key === 'tab' ? 'rbacTab' : key, value)
  })
  const query = params.toString()

  return <Navigate to={`/settings/rbac${query ? `?${query}` : ''}`} replace />
}

export default RBACRedirect
