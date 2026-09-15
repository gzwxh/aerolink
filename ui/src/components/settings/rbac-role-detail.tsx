import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { useAuth } from '@/contexts/auth-context'
import {
  IconPencil,
  IconPlus,
  IconSearch,
  IconServer,
  IconShieldCheck,
  IconTrash,
  IconUser,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Role, UserItem } from '@/types/api'
import {
  assignRole,
  createRole,
  deleteRole,
  fetchClusterNamespaces,
  fetchKnownGroups,
  fetchUserList,
  unassignRole,
  updateRole,
  useClusterList,
  useRoleList,
} from '@/lib/api'
import { ApiError } from '@/lib/api-client'
import {
  isClusterScopedOnly,
  isNodeOnlyRole,
  nodePermissionPresets,
  type PermissionPreset,
} from '@/lib/node-permissions'
import {
  isClusterScopedResource,
  resourceCatalog,
} from '@/lib/resource-catalog'
import { applyRoleNamePrefix, normalizeRoleName } from '@/lib/role-name'
import { cn, translateError } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { Textarea } from '@/components/ui/textarea'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { MultiSelect } from '@/components/multi-select'

interface RBACRoleDetailProps {
  /** Undefined/null means creating a new role. */
  role?: Role | null
  onSaved: (role: Role) => void
  onDeleted: () => void
  /** Deep-link: cluster preselected in the grant panes. */
  initialCluster?: string
  /** Deep-link: namespace pre-filled in the namespace search box. */
  initialNamespace?: string
  /** Resources preselected when creating a new role (e.g. a scoped entry point). */
  defaultResources?: string[]
  /** When set, the resource picker is replaced by a fixed read-only list. */
  lockedResources?: string[]
  /** Hide the namespace picker for cluster-scoped-only flows (e.g. nodes). */
  hideNamespacePanel?: boolean
  /** Optional hint rendered with the locked resource list. */
  permissionHint?: React.ReactNode
  /** Action-oriented permission items that replace the raw verb list. */
  permissionPresets?: PermissionPreset[]
  /** Title for the permissions panel when presets are provided. */
  permissionPanelTitle?: string
  /** Prefix enforced on role names, e.g. "node-" for the node permission tab. */
  namePrefix?: string
  /**
   * When set, an existing role opens as a read-only summary and the edit form
   * is revealed by the Edit button. New roles always open the form directly.
   */
  startInViewMode?: boolean
  /** Called when the cancel button is pressed while creating a new role. */
  onCancelForm?: () => void
}

export type { PermissionPreset }

function ReadOnlyField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm break-words">{children}</div>
    </div>
  )
}

type ArrayRoleField = 'namespaces' | 'resources' | 'verbs'

const USER_PAGE_SIZE = 500

const VERB_SUGGESTIONS = [
  '*',
  'get',
  'create',
  'update',
  'delete',
  'log',
  'exec',
  'view-file',
  'download-file',
  'upload-file',
]

const RESOURCE_SUGGESTIONS = [
  '*',
  ...resourceCatalog
    .filter((resource) => resource.type !== 'crs')
    .map((resource) => resource.type),
]

interface RoleFormState {
  name: string
  description: string
  roleType: 'user' | 'group'
  clusters: string[]
  namespaces: string[]
  resources: string[]
  verbs: string[]
}

const roleToForm = (role?: Role | null): RoleFormState => ({
  name: role?.name ?? '',
  description: role?.description ?? '',
  roleType: role?.roleType === 'group' ? 'group' : 'user',
  clusters: role?.clusters ?? [],
  namespaces: role?.namespaces ?? [],
  resources: role?.resources ?? [],
  verbs: role?.verbs ?? [],
})

// A bordered scrollable picker panel used for the cluster / namespace panes.
function PickerPanel({
  title,
  description,
  search,
  onSearchChange,
  searchPlaceholder,
  children,
  footer,
}: {
  title: string
  description?: React.ReactNode
  search: string
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-md border">
      <div className="border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{title}</span>
          {description}
        </div>
        <div className="relative mt-2">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>
      <div className="max-h-[22rem] overflow-y-auto">{children}</div>
      {footer && <div className="border-t px-3 py-2">{footer}</div>}
    </div>
  )
}

export function RBACRoleDetail({
  role,
  onSaved,
  onDeleted,
  initialCluster,
  initialNamespace,
  defaultResources,
  lockedResources,
  hideNamespacePanel,
  permissionHint,
  permissionPresets,
  permissionPanelTitle,
  namePrefix,
  startInViewMode,
  onCancelForm,
}: RBACRoleDetailProps) {
  const { t } = useTranslation()
  const { user: currentUser } = useAuth()
  const queryClient = useQueryClient()
  const isEdit = !!role
  const isSystem = !!role?.isSystem

  // A configured name prefix is part of the role's identity: it is applied when
  // creating a role, while an existing role keeps its stored name so editing
  // never renames it.
  const nameLocked = !!namePrefix && isEdit
  const buildFormState = (): RoleFormState => {
    const base = roleToForm(role)
    const named = nameLocked
      ? base
      : { ...base, name: normalizeRoleName(base.name, namePrefix) }
    if (!role && defaultResources?.length) {
      return { ...named, resources: [...defaultResources] }
    }
    return named
  }
  const [form, setForm] = useState<RoleFormState>(buildFormState)
  const [showDelete, setShowDelete] = useState(false)
  // Existing roles open as a read-only summary when the caller opts in; the
  // form is only revealed after clicking Edit (or immediately for new roles).
  const [editing, setEditing] = useState(false)
  const showEditForm = !startInViewMode || !isEdit || editing
  // The read-only entry point always offers a way out of the form: cancelling
  // discards pending edits, or leaves the create form entirely.
  const showCancelButton = !!startInViewMode
  // A role that only grants cluster-scoped resources (e.g. nodes) has no
  // namespace scope, so the namespace picker is hidden — the same presentation
  // the dedicated node permission tab uses.
  const effectiveResources = lockedResources?.length
    ? lockedResources
    : form.resources
  const clusterScopedOnly = isClusterScopedOnly(effectiveResources)
  const nodesOnly = isNodeOnlyRole(effectiveResources)
  const hideNamespaces = !!hideNamespacePanel || clusterScopedOnly
  // A role limited to specific namespaces cannot constrain cluster-scoped
  // resources, so offering them would silently widen the role to cluster-wide
  // access (e.g. "all resources in namespace dev" also granting every node).
  const namespaceRestricted =
    form.namespaces.length > 0 && !form.namespaces.includes('*')
  // Roles scoped to nodes reuse the node permission items (and panel title) so
  // the generic role editor presents them exactly like the node tab does.
  const effectivePermissionPresets =
    permissionPresets ?? (nodesOnly ? nodePermissionPresets(t) : undefined)
  const effectivePermissionPanelTitle =
    permissionPanelTitle ??
    (nodesOnly
      ? t('rbac.nodePermissions.panelTitle', 'Node permissions')
      : undefined)
  const effectivePermissionHint =
    permissionHint ??
    (nodesOnly
      ? t(
          'rbac.nodePermissionHint',
          'Buttons on the node pages are shown only when the matching permission is granted.'
        )
      : undefined)
  // Preference is given to the action labels (e.g. the node page permission
  // items) over raw verbs when summarising a role.
  const grantedPermissionLabels = effectivePermissionPresets?.length
    ? form.verbs.includes('*')
      ? [t('rbac.allPermissions', 'All permissions')]
      : effectivePermissionPresets
          .filter((preset) => form.verbs.includes(preset.verb))
          .map((preset) => preset.label)
    : null
  // The role type decides which subjects can be attached: a user role takes a
  // single user, a group role takes one or more LDAP / OIDC groups.
  const subjectKind: 'user' | 'group' =
    form.roleType === 'group' ? 'group' : 'user'
  // Subjects to grant when the role is saved (same flow as the namespace
  // permission dialog).
  const [grantSubjects, setGrantSubjects] = useState<string[]>([])

  // Cascade picker state: the cluster being inspected (not necessarily granted).
  const [activeCluster, setActiveCluster] = useState<string | null>(
    initialCluster ?? null
  )
  const [clusterSearch, setClusterSearch] = useState('')
  const [namespaceSearch, setNamespaceSearch] = useState(initialNamespace ?? '')
  const [resourceSearch, setResourceSearch] = useState('')
  const [verbSearch, setVerbSearch] = useState('')
  const [namespaceFilter, setNamespaceFilter] = useState<
    'all' | 'granted' | 'ungranted'
  >('all')
  const [namespacePage, setNamespacePage] = useState(0)

  // Member management state
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([])
  const [userOptions, setUserOptions] = useState<UserItem[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [groupOptions, setGroupOptions] = useState<string[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [isAssigning, setIsAssigning] = useState(false)
  const [isUnassigning, setIsUnassigning] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<{
    subjectType: 'user' | 'group'
    subject: string
  } | null>(null)

  // Switching the role type invalidates any subject picked for the other kind.
  useEffect(() => {
    setGrantSubjects([])
    setSelectedSubjects([])
  }, [subjectKind])

  const { data: clusterList = [] } = useClusterList()
  const allClusterNames = useMemo(
    () =>
      (clusterList || [])
        .map((c) => c.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [clusterList]
  )

  // Namespaces of the inspected cluster; results are cached per cluster so
  // switching back and forth is instant.
  const {
    data: activeClusterNamespaces = [],
    isLoading: activeNamespacesLoading,
  } = useQuery({
    queryKey: ['rbac-cluster-namespaces', activeCluster],
    queryFn: () => fetchClusterNamespaces(activeCluster!),
    enabled: !!activeCluster,
    staleTime: 60_000,
  })

  // Keep the inspected cluster valid as the cluster list changes; default to
  // the first cluster once the list is available.
  useEffect(() => {
    if (allClusterNames.length === 0) {
      if (activeCluster !== null) setActiveCluster(null)
      return
    }
    if (!activeCluster || !allClusterNames.includes(activeCluster)) {
      setActiveCluster(allClusterNames[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allClusterNames.join(',')])

  const setArrayField = (field: ArrayRoleField, items: string[]) =>
    setForm((prev) => ({ ...prev, [field]: items }))

  // ----- Resource / verb grant toggling (wildcard-aware) -----

  const allResourcesGranted = form.resources.includes('*')
  const resourceGranted = (name: string) =>
    allResourcesGranted || form.resources.includes(name)

  const toggleResourceWildcard = () =>
    setArrayField('resources', allResourcesGranted ? [] : ['*'])

  const toggleResource = (name: string) => {
    if (allResourcesGranted) {
      setArrayField('resources', [name])
      return
    }
    setArrayField(
      'resources',
      form.resources.includes(name)
        ? form.resources.filter((r) => r !== name)
        : [...form.resources, name]
    )
  }

  const allVerbsGranted = form.verbs.includes('*')
  const verbGranted = (name: string) =>
    allVerbsGranted || form.verbs.includes(name)

  const toggleVerbWildcard = () =>
    setArrayField('verbs', allVerbsGranted ? [] : ['*'])

  const toggleVerb = (name: string) => {
    if (allVerbsGranted) {
      setArrayField('verbs', [name])
      return
    }
    setArrayField(
      'verbs',
      form.verbs.includes(name)
        ? form.verbs.filter((v) => v !== name)
        : [...form.verbs, name]
    )
  }

  const filteredResourceOptions = useMemo(() => {
    const q = resourceSearch.trim().toLowerCase()
    if (!q) return RESOURCE_SUGGESTIONS.filter((r) => r !== '*')
    return RESOURCE_SUGGESTIONS.filter(
      (r) => r !== '*' && r.toLowerCase().includes(q)
    )
  }, [resourceSearch])

  const filteredVerbOptions = useMemo(() => {
    const q = verbSearch.trim().toLowerCase()
    if (!q) return VERB_SUGGESTIONS.filter((v) => v !== '*')
    return VERB_SUGGESTIONS.filter(
      (v) => v !== '*' && v.toLowerCase().includes(q)
    )
  }, [verbSearch])

  const filteredPermissionPresets = useMemo(() => {
    if (!effectivePermissionPresets?.length) return []
    const q = verbSearch.trim().toLowerCase()
    if (!q) return effectivePermissionPresets
    return effectivePermissionPresets.filter(
      (preset) =>
        preset.label.toLowerCase().includes(q) ||
        (preset.description || '').toLowerCase().includes(q)
    )
  }, [effectivePermissionPresets, verbSearch])

  // The resource picker splits namespaced and cluster-scoped resources so the
  // namespace boundary is explicit: only namespaced resources are constrained
  // by the role's namespace list.
  const { namespacedResourceOptions, clusterScopedResourceOptions } =
    useMemo(() => {
      const namespaced: string[] = []
      const clusterScoped: string[] = []
      for (const name of filteredResourceOptions) {
        if (isClusterScopedResource(name)) {
          clusterScoped.push(name)
        } else {
          namespaced.push(name)
        }
      }
      return {
        namespacedResourceOptions: namespaced,
        clusterScopedResourceOptions: clusterScoped,
      }
    }, [filteredResourceOptions])

  // Cluster-scoped options stay hidden for namespace-restricted roles, except
  // the ones already granted so they can still be revoked.
  const visibleClusterScopedOptions = namespaceRestricted
    ? clusterScopedResourceOptions.filter((name) => resourceGranted(name))
    : clusterScopedResourceOptions

  const renderResourceOption = (name: string) => (
    <button
      key={name}
      type="button"
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-accent"
      onClick={() => toggleResource(name)}
      disabled={isSystem}
    >
      <span className={checkboxClass(resourceGranted(name))}>
        {resourceGranted(name) && (
          <svg
            className="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
    </button>
  )

  const verbLabel = (verb: string) =>
    t(`rbac.verb.${verb}`, { defaultValue: verb })

  const inspectCluster = (name: string) => {
    setActiveCluster(name)
    setNamespacePage(0)
    setNamespaceFilter('all')
  }

  // ----- Cluster grant toggling (wildcard-aware) -----

  const allClustersGranted = form.clusters.includes('*')
  const clusterGranted = (name: string) =>
    allClustersGranted || form.clusters.includes(name)

  const toggleClusterWildcard = () => {
    setForm((prev) => ({
      ...prev,
      clusters: allClustersGranted ? [] : ['*'],
    }))
  }

  const toggleCluster = (name: string) => {
    if (allClustersGranted) {
      // Narrow the wildcard grant down to the clicked cluster.
      setForm((prev) => ({ ...prev, clusters: [name] }))
      return
    }
    setForm((prev) => ({
      ...prev,
      clusters: prev.clusters.includes(name)
        ? prev.clusters.filter((c) => c !== name)
        : [...prev.clusters, name],
    }))
  }

  // ----- Namespace grant toggling (wildcard-aware) -----

  const allNamespacesGranted = form.namespaces.includes('*')
  const namespaceGranted = (name: string) =>
    allNamespacesGranted || form.namespaces.includes(name)

  const toggleNamespaceWildcard = () => {
    setForm((prev) => ({
      ...prev,
      namespaces: allNamespacesGranted ? [] : ['*'],
    }))
  }

  const toggleNamespace = (name: string) => {
    if (allNamespacesGranted) {
      setForm((prev) => ({ ...prev, namespaces: [name] }))
      return
    }
    setForm((prev) => ({
      ...prev,
      namespaces: prev.namespaces.includes(name)
        ? prev.namespaces.filter((n) => n !== name)
        : [...prev.namespaces, name],
    }))
  }

  const filteredClusters = useMemo(() => {
    const q = clusterSearch.trim().toLowerCase()
    if (!q) return allClusterNames
    return allClusterNames.filter((name) => name.toLowerCase().includes(q))
  }, [allClusterNames, clusterSearch])

  const filteredNamespaces = useMemo(() => {
    const q = namespaceSearch.trim().toLowerCase()
    const base = q
      ? activeClusterNamespaces.filter((name) => name.toLowerCase().includes(q))
      : activeClusterNamespaces
    if (namespaceFilter === 'granted') {
      return base.filter(namespaceGranted)
    }
    if (namespaceFilter === 'ungranted') {
      return base.filter((name) => !namespaceGranted(name))
    }
    return base
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeClusterNamespaces,
    namespaceSearch,
    namespaceFilter,
    allNamespacesGranted,
    form.namespaces,
  ])

  const NAMESPACE_PAGE_SIZE = 50
  const namespaceTotalPages = Math.max(
    1,
    Math.ceil(filteredNamespaces.length / NAMESPACE_PAGE_SIZE)
  )
  const safeNamespacePage = Math.min(namespacePage, namespaceTotalPages - 1)
  const pagedNamespaces = useMemo(
    () =>
      filteredNamespaces.slice(
        safeNamespacePage * NAMESPACE_PAGE_SIZE,
        (safeNamespacePage + 1) * NAMESPACE_PAGE_SIZE
      ),
    [filteredNamespaces, safeNamespacePage]
  )
  const grantedNamespaceCount = allNamespacesGranted
    ? activeClusterNamespaces.length
    : activeClusterNamespaces.filter((name) => form.namespaces.includes(name))
        .length

  const formatValues = (values: string[]) => {
    if (values.length === 0) return '-'
    if (values.includes('*')) return t('common.values.all', 'All')
    return values.join(', ')
  }

  // Role names are globally unique on the backend. Detect the clash up front so
  // the user gets an inline hint instead of a raw DB constraint error.
  const { data: allRoles = [] } = useRoleList()
  const duplicateName = useMemo(() => {
    if (isSystem) return false
    const name = form.name.trim()
    if (!name) return false
    return allRoles.some(
      (existing) => existing.name.trim() === name && existing.id !== role?.id
    )
  }, [allRoles, form.name, isSystem, role?.id])

  const roleNameConflictMessage = t(
    'rbac.roleNameConflict',
    'A role with this name already exists. Role names must be unique.'
  )

  // ----- Role mutations -----

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Role>) => {
      const resp = await createRole(data)
      for (const subject of grantSubjects) {
        await assignRole(resp.role.id, {
          subjectType: subjectKind,
          subject,
        })
      }
      return resp
    },
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ['role-list'] })
      toast.success(
        t('common.messages.created', {
          resource: t('common.fields.role', 'Role'),
          defaultValue: 'Role created',
        })
      )
      setGrantSubjects([])
      setEditing(false)
      onSaved(resp.role)
    },
    onError: (err: Error) => {
      if (
        err instanceof ApiError &&
        (err.code === 'role_name_conflict' || err.status === 409)
      ) {
        return
      }
    },
  })

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<Role>) => {
      const resp = await updateRole(role!.id, data)
      for (const subject of grantSubjects) {
        await assignRole(role!.id, {
          subjectType: subjectKind,
          subject,
        })
      }
      return resp
    },
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ['role-list'] })
      toast.success(
        t('common.messages.updated', {
          resource: t('common.fields.role', 'Role'),
          defaultValue: 'Role updated',
        })
      )
      setGrantSubjects([])
      setEditing(false)
      onSaved(resp.role)
    },
    onError: (err: Error) => {
      if (
        err instanceof ApiError &&
        (err.code === 'role_name_conflict' || err.status === 409)
      ) {
        return
      }
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteRole(role!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-list'] })
      toast.success(
        t('common.messages.deleted', {
          resource: t('common.fields.role', 'Role'),
          defaultValue: 'Role deleted',
        })
      )
      onDeleted()
    },
  })

  // ----- Member management -----

  const loadUsers = useCallback(async () => {
    setUsersLoading(true)
    setUsersError(null)
    try {
      const collected: UserItem[] = []
      let page = 1
      for (;;) {
        const res = await fetchUserList(page, USER_PAGE_SIZE, '')
        collected.push(...(res.users || []))
        if (collected.length >= res.total || (res.users || []).length === 0) {
          break
        }
        page++
      }
      setUserOptions(collected)
    } catch (err) {
      setUserOptions([])
      setUsersError(translateError(err as Error, t))
    } finally {
      setUsersLoading(false)
    }
  }, [t])

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true)
    setGroupsError(null)
    try {
      const groups = await fetchKnownGroups()
      setGroupOptions(groups)
    } catch (err) {
      setGroupOptions([])
      setGroupsError(translateError(err as Error, t))
    } finally {
      setGroupsLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadUsers()
    void loadGroups()
  }, [loadUsers, loadGroups])

  const assignments = role?.assignments ?? []
  const currentUsers = assignments.filter((a) => a.subjectType === 'user')
  const currentGroups = assignments.filter((a) => a.subjectType === 'group')
  const assignedUsers = useMemo(
    () => new Set(currentUsers.map((a) => a.subject)),
    [currentUsers]
  )
  const assignedGroups = useMemo(
    () => new Set(currentGroups.map((a) => a.subject)),
    [currentGroups]
  )

  const userSuggestions = useMemo(
    () =>
      userOptions
        .filter((u) => !assignedUsers.has(u.username))
        .map((u) => u.username)
        .sort((a, b) => a.localeCompare(b)),
    [userOptions, assignedUsers]
  )
  const groupSuggestions = useMemo(
    () =>
      groupOptions
        .filter((g) => !assignedGroups.has(g))
        .sort((a, b) => a.localeCompare(b)),
    [groupOptions, assignedGroups]
  )

  const memberOptions =
    subjectKind === 'user' ? userSuggestions : groupSuggestions
  const memberOptionsLoading =
    subjectKind === 'user' ? usersLoading : groupsLoading
  const memberOptionsError = subjectKind === 'user' ? usersError : groupsError
  const retryMemberOptions = subjectKind === 'user' ? loadUsers : loadGroups

  const assignMutation = useMutation({
    mutationFn: ({
      subjectType: st,
      subject,
    }: {
      subjectType: 'user' | 'group'
      subject: string
    }) => assignRole(role!.id, { subjectType: st, subject }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['role-list'] }),
  })

  const unassignMutation = useMutation({
    mutationFn: ({
      subjectType: st,
      subject,
    }: {
      subjectType: 'user' | 'group'
      subject: string
    }) => unassignRole(role!.id, st, subject),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['role-list'] }),
  })

  const handleAddMembers = async (e: FormEvent) => {
    e.preventDefault()
    if (!role || selectedSubjects.length === 0 || isAssigning) return
    setIsAssigning(true)
    try {
      for (const subject of selectedSubjects) {
        await assignMutation.mutateAsync({ subjectType: subjectKind, subject })
      }
      setSelectedSubjects([])
      toast.success(t('common.messages.assigned', 'Assigned'))
    } catch (err: unknown) {
    } finally {
      setIsAssigning(false)
    }
  }

  const handleRemoveMember = (st: 'user' | 'group', subject: string) => {
    if (!role || isUnassigning) return
    if (st === 'user' && subject === currentUser?.username) {
      setPendingRemoval({ subjectType: st, subject })
      return
    }
    void confirmRemoveMember(st, subject)
  }

  const confirmRemoveMember = async (st: 'user' | 'group', subject: string) => {
    setIsUnassigning(true)
    try {
      await unassignMutation.mutateAsync({ subjectType: st, subject })
      toast.success(t('common.messages.unassigned', 'Unassigned'))
    } catch (err: unknown) {
    } finally {
      setIsUnassigning(false)
      setPendingRemoval(null)
    }
  }

  // ----- Form submit -----

  // Discards pending edits and returns to the read-only summary; when creating,
  // it also leaves the form and restores the previously selected role.
  const handleCancel = () => {
    setForm(buildFormState())
    setGrantSubjects([])
    setSelectedSubjects([])
    setEditing(false)
    if (!isEdit) onCancelForm?.()
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (isSystem) return
    if (duplicateName) {
      toast.error(roleNameConflictMessage)
      return
    }
    const data: Partial<Role> = {
      name: nameLocked
        ? form.name.trim()
        : normalizeRoleName(form.name, namePrefix),
      description: form.description,
      roleType: form.roleType,
      clusters: form.clusters,
      // Cluster-scoped-only flows hide the namespace picker; the resource is
      // cluster-wide, so the namespace list is irrelevant and pinned to "*".
      namespaces: hideNamespaces ? ['*'] : form.namespaces,
      resources: lockedResources?.length ? lockedResources : form.resources,
      verbs: form.verbs,
    }
    if (isEdit) {
      updateMutation.mutate(data)
    } else {
      createMutation.mutate(data)
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending

  const memberRows = [
    ...currentUsers.map((a) => ({
      key: `user-${a.id}`,
      subjectType: 'user' as const,
      subject: a.subject,
    })),
    ...currentGroups.map((a) => ({
      key: `group-${a.id}`,
      subjectType: 'group' as const,
      subject: a.subject,
    })),
  ]

  const checkboxClass = (checked: boolean) =>
    cn(
      'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
      checked
        ? 'bg-primary text-primary-foreground'
        : 'border-muted-foreground/30'
    )

  // Renders either action-oriented permission presets (e.g. the node page
  // buttons) or the raw verb list, depending on the caller.
  const permissionsPanel = (
    <PickerPanel
      title={
        effectivePermissionPanelTitle ||
        `${t('common.fields.actions', 'Actions')} / ${t('common.fields.verbs', 'Verbs')}`
      }
      search={verbSearch}
      onSearchChange={setVerbSearch}
      searchPlaceholder={t('common.placeholders.searchItems', 'Search...')}
    >
      <div className="py-1">
        {effectivePermissionPresets?.length ? (
          <>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-60"
              onClick={toggleVerbWildcard}
              disabled={isSystem}
            >
              <span className={checkboxClass(allVerbsGranted)}>
                {allVerbsGranted && (
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1 font-medium">
                {t('rbac.allPermissions', 'All permissions')}
              </span>
            </button>
            {filteredPermissionPresets.map((preset) => (
              <button
                key={preset.verb}
                type="button"
                className="flex w-full items-start gap-2.5 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent disabled:opacity-60"
                onClick={() => toggleVerb(preset.verb)}
                disabled={isSystem}
              >
                <span
                  className={cn(
                    'mt-0.5',
                    checkboxClass(verbGranted(preset.verb))
                  )}
                >
                  {verbGranted(preset.verb) && (
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {preset.label}
                  </span>
                  {preset.description && (
                    <span className="block text-xs text-muted-foreground">
                      {preset.description}
                    </span>
                  )}
                </span>
              </button>
            ))}
            {filteredPermissionPresets.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                {t('common.messages.noOptionsFound', 'No options found')}
              </div>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 border-b px-3 py-1.5 text-left text-sm hover:bg-accent"
              onClick={toggleVerbWildcard}
              disabled={isSystem}
            >
              <span className={checkboxClass(allVerbsGranted)}>
                {allVerbsGranted && (
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </span>
              <span className="truncate font-medium">
                {t('rbac.allVerbsWildcard', 'All verbs (*)')}
              </span>
            </button>
            {filteredVerbOptions.map((verb) => (
              <button
                key={verb}
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => toggleVerb(verb)}
                disabled={isSystem}
              >
                <span className={checkboxClass(verbGranted(verb))}>
                  {verbGranted(verb) && (
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 truncate">{verbLabel(verb)}</span>
              </button>
            ))}
            {filteredVerbOptions.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                {t('common.messages.noOptionsFound', 'No options found')}
              </div>
            )}
          </>
        )}
      </div>
    </PickerPanel>
  )

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        className={cn('space-y-6', !showEditForm && 'hidden')}
      >
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <IconShieldCheck className="h-5 w-5" />
                {isEdit ? role!.name : t('rbac.newRole', 'New Role')}
              </CardTitle>
              {isSystem && (
                <Badge variant="secondary">
                  {t('common.fields.system', 'System')}
                </Badge>
              )}
            </div>
            {isSystem && (
              <CardDescription>
                {t(
                  'rbac.systemRoleHint',
                  'System role is read-only. You can still manage its members.'
                )}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="role-name">
                  {t('common.fields.name', 'Name')} *
                </Label>
                <Input
                  id="role-name"
                  value={form.name}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      name: applyRoleNamePrefix(e.target.value, namePrefix),
                    }))
                  }
                  onBlur={() =>
                    setForm((prev) => ({
                      ...prev,
                      name: normalizeRoleName(prev.name, namePrefix),
                    }))
                  }
                  disabled={isSystem || nameLocked}
                  aria-invalid={duplicateName}
                  className={cn(duplicateName && 'border-destructive')}
                  required
                />
                {nameLocked && (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'rbac.nameFixedHint',
                      'Role names are fixed and cannot be changed.'
                    )}
                  </p>
                )}
                {namePrefix && !nameLocked && (
                  <p className="text-xs text-muted-foreground">
                    {t('rbac.namePrefixHint', {
                      prefix: namePrefix,
                      defaultValue:
                        'Role names start with "{{prefix}}" automatically.',
                    })}
                  </p>
                )}
                {duplicateName && (
                  <p className="text-xs text-destructive">
                    {roleNameConflictMessage}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="role-desc">
                  {t('common.fields.description', 'Description')}
                </Label>
                <Textarea
                  id="role-desc"
                  value={form.description}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  disabled={isSystem}
                  rows={1}
                  className="min-h-9 resize-y py-1.5"
                />
              </div>
            </div>

            <div
              className={cn(
                'grid grid-cols-1 gap-4',
                !isSystem && 'lg:grid-cols-2'
              )}
            >
              {!isSystem && (
                <div className="space-y-2">
                  <Label>{t('rbac.roleType', 'Role Type')}</Label>
                  <Select
                    value={form.roleType}
                    onValueChange={(v) =>
                      setForm((prev) => ({
                        ...prev,
                        roleType: v as 'user' | 'group',
                      }))
                    }
                    disabled={isSystem}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">
                        {t('rbac.roleTypeUser', 'User Role')}
                      </SelectItem>
                      <SelectItem value="group">
                        {t('rbac.roleTypeGroup', 'Group Role')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'rbac.roleTypeHint',
                      'A user role grants a single user; a group role grants one or more LDAP / OIDC groups.'
                    )}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label>
                  {subjectKind === 'user'
                    ? t('common.fields.users', 'Users')
                    : t('common.fields.oidcGroups', 'LDAP / OIDC Groups')}
                </Label>
                <MultiSelect
                  key={subjectKind}
                  value={grantSubjects}
                  onChange={setGrantSubjects}
                  options={
                    subjectKind === 'user'
                      ? userOptions.map((u) => u.username)
                      : groupOptions
                  }
                  max={subjectKind === 'user' ? 1 : undefined}
                  selectAllMode="all"
                  allowAdd={false}
                  disabled={isSystem || isSaving}
                  placeholder={
                    subjectKind === 'user'
                      ? t('common.placeholders.selectUser', 'Select user')
                      : t(
                          'common.placeholders.selectGroups',
                          'Select groups...'
                        )
                  }
                  emptyText={
                    subjectKind === 'user'
                      ? t('common.messages.noUsersFound', 'No users found')
                      : t('common.messages.noGroupsFound', 'No groups found')
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {subjectKind === 'user'
                    ? t(
                        'rbac.grantOnSaveUser',
                        'The selected user will be granted this role when saved.'
                      )
                    : t(
                        'rbac.grantOnSaveGroup',
                        'The selected groups will be granted this role when saved.'
                      )}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {t('rbac.permissionsSection', 'Permissions')}
                </span>
                {lockedResources?.length ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {t('common.fields.resources', 'Resources')}:
                    </span>
                    {lockedResources.map((resource) => (
                      <Badge key={resource} variant="outline">
                        {resource}
                      </Badge>
                    ))}
                  </>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">
                {hideNamespaces
                  ? t(
                      'rbac.clusterOnlyPermissionsHint',
                      'Select the clusters to grant. This role only manages cluster-scoped resources, so no namespace selection is needed.'
                    )
                  : t(
                      'rbac.permissionsHint',
                      'Pick clusters on the left, then grant namespaces on the right. Namespace options follow the selected cluster.'
                    )}
              </p>
              {effectivePermissionHint ? (
                <p className="text-xs text-muted-foreground">
                  {effectivePermissionHint}
                </p>
              ) : null}
            </div>

            <div
              className={cn(
                'grid grid-cols-1 gap-4 lg:items-start',
                (!hideNamespaces || !!lockedResources?.length) &&
                  'lg:grid-cols-2'
              )}
            >
              {/* Left pane: cluster list with grant checkboxes */}
              <PickerPanel
                title={t('common.fields.clusters', 'Clusters')}
                description={
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {allClustersGranted
                      ? t('rbac.allClustersGrantedInfo', 'All clusters granted')
                      : t('rbac.grantedClustersInfo', {
                          granted: form.clusters.length,
                          total: allClusterNames.length,
                          defaultValue:
                            '{{granted}}/{{total}} clusters granted',
                        })}
                  </span>
                }
                search={clusterSearch}
                onSearchChange={setClusterSearch}
                searchPlaceholder={t(
                  'common.placeholders.searchItems',
                  'Search...'
                )}
              >
                {allClusterNames.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {t('rbac.noClusters', 'No clusters configured.')}
                  </div>
                ) : (
                  <div className="py-1">
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-accent',
                        activeCluster === null && 'bg-accent'
                      )}
                      onClick={toggleClusterWildcard}
                    >
                      <span className={checkboxClass(allClustersGranted)}>
                        {allClustersGranted && (
                          <svg
                            className="h-3 w-3"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                          >
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        )}
                      </span>
                      <span className="min-w-0 truncate font-medium">
                        {t('rbac.allClustersWildcard', 'All clusters (*)')}
                      </span>
                    </button>
                    {filteredClusters.map((name) => (
                      <div
                        key={name}
                        role="button"
                        tabIndex={0}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-accent',
                          activeCluster === name && 'bg-accent'
                        )}
                        onClick={() => setActiveCluster(name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            inspectCluster(name)
                          }
                        }}
                      >
                        <button
                          type="button"
                          aria-label={`${t('rbac.grantCluster', 'Grant cluster')} ${name}`}
                          className={checkboxClass(clusterGranted(name))}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleCluster(name)
                          }}
                        >
                          {clusterGranted(name) && (
                            <svg
                              className="h-3 w-3"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                            >
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          )}
                        </button>
                        <span className="min-w-0 truncate" title={name}>
                          {name}
                        </span>
                      </div>
                    ))}
                    {filteredClusters.length === 0 && (
                      <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                        {t(
                          'common.messages.noOptionsFound',
                          'No options found'
                        )}
                      </div>
                    )}
                  </div>
                )}
              </PickerPanel>

              {/* Right pane: namespaces of the inspected cluster, or the
                  permission picker for cluster-scoped-only flows. */}
              {lockedResources?.length
                ? permissionsPanel
                : !hideNamespaces && (
                    <PickerPanel
                      title={t('common.fields.namespaces', 'Namespaces')}
                      description={
                        activeCluster ? (
                          <span
                            className="inline-flex max-w-48 shrink-0 items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-xs font-medium text-primary"
                            title={t('rbac.namespaceClusterHint', {
                              cluster: activeCluster,
                              defaultValue:
                                'Namespaces below belong to cluster {{cluster}}',
                            })}
                          >
                            <IconServer className="h-3 w-3 shrink-0" />
                            <span className="min-w-0 truncate">
                              {activeCluster}
                            </span>
                          </span>
                        ) : undefined
                      }
                      search={namespaceSearch}
                      onSearchChange={(v) => {
                        setNamespaceSearch(v)
                        setNamespacePage(0)
                      }}
                      searchPlaceholder={t(
                        'common.placeholders.searchItems',
                        'Search...'
                      )}
                      footer={
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span>
                              {t('rbac.namespaceTotalInfo', {
                                total: activeClusterNamespaces.length,
                                granted: grantedNamespaceCount,
                                defaultValue:
                                  '{{total}} namespaces · {{granted}} granted',
                              })}
                            </span>
                            {namespaceTotalPages > 1 && (
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  disabled={safeNamespacePage === 0}
                                  onClick={() =>
                                    setNamespacePage(safeNamespacePage - 1)
                                  }
                                  aria-label={t(
                                    'common.pagination.previous',
                                    'Previous'
                                  )}
                                >
                                  <svg
                                    className="h-3.5 w-3.5"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <path d="m15 18-6-6 6-6" />
                                  </svg>
                                </Button>
                                <span>
                                  {t('common.pagination.page', {
                                    current: safeNamespacePage + 1,
                                    total: namespaceTotalPages,
                                    defaultValue:
                                      'Page {{current}} of {{total}}',
                                  })}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  disabled={
                                    safeNamespacePage >= namespaceTotalPages - 1
                                  }
                                  onClick={() =>
                                    setNamespacePage(safeNamespacePage + 1)
                                  }
                                  aria-label={t(
                                    'common.pagination.next',
                                    'Next'
                                  )}
                                >
                                  <svg
                                    className="h-3.5 w-3.5"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <path d="m9 18 6-6-6-6" />
                                  </svg>
                                </Button>
                              </div>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t(
                              'rbac.namespaceScopeHint',
                              'Namespace restrictions apply only to namespaced resources. Cluster-scoped resources (nodes, persistent volumes, storage classes, CRDs, ...) are not limited by the namespace list.'
                            )}
                          </p>
                        </div>
                      }
                    >
                      {!activeCluster ? (
                        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                          {t(
                            'rbac.selectClusterHint',
                            'Select a cluster on the left to view its namespaces.'
                          )}
                        </div>
                      ) : activeNamespacesLoading ? (
                        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                          {t('common.messages.loading', 'Loading...')}
                        </div>
                      ) : (
                        <div>
                          {/* Wildcard select-all + quick grant filter */}
                          <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
                            <button
                              type="button"
                              className="flex min-w-0 items-center gap-2.5 text-left text-sm hover:text-foreground"
                              onClick={toggleNamespaceWildcard}
                            >
                              <span
                                className={checkboxClass(allNamespacesGranted)}
                              >
                                {allNamespacesGranted && (
                                  <svg
                                    className="h-3 w-3"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="3"
                                  >
                                    <path d="M20 6 9 17l-5-5" />
                                  </svg>
                                )}
                              </span>
                              <span className="truncate font-medium">
                                {t(
                                  'rbac.allNamespacesWildcard',
                                  'All namespaces (*)'
                                )}
                              </span>
                            </button>
                            <div className="flex shrink-0 items-center gap-1">
                              {(
                                [
                                  ['all', 'rbac.filterAll', 'All'],
                                  ['granted', 'rbac.filterGranted', 'Granted'],
                                  [
                                    'ungranted',
                                    'rbac.filterUngranted',
                                    'Not granted',
                                  ],
                                ] as const
                              ).map(([value, key, fallback]) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={() => {
                                    setNamespaceFilter(value)
                                    setNamespacePage(0)
                                  }}
                                  className={cn(
                                    'rounded-full px-2 py-0.5 text-xs transition-colors',
                                    namespaceFilter === value
                                      ? 'bg-primary text-primary-foreground'
                                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                                  )}
                                >
                                  {t(key, fallback)}
                                </button>
                              ))}
                            </div>
                          </div>
                          {/* Namespace table */}
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                            <span>
                              {t('common.fields.namespaces', 'Namespaces')}
                            </span>
                            <span>{t('rbac.grantStatus', 'Grant Status')}</span>
                          </div>
                          {pagedNamespaces.map((name) => (
                            <button
                              key={name}
                              type="button"
                              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b px-3 py-1.5 text-left text-sm last:border-b-0 hover:bg-accent"
                              onClick={() => toggleNamespace(name)}
                            >
                              <span className="flex min-w-0 items-center gap-2.5">
                                <span
                                  className={checkboxClass(
                                    namespaceGranted(name)
                                  )}
                                >
                                  {namespaceGranted(name) && (
                                    <svg
                                      className="h-3 w-3"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="3"
                                    >
                                      <path d="M20 6 9 17l-5-5" />
                                    </svg>
                                  )}
                                </span>
                                <span className="min-w-0 truncate" title={name}>
                                  {name}
                                </span>
                              </span>
                              {namespaceGranted(name) ? (
                                <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                                  <svg
                                    className="h-3 w-3"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="3"
                                  >
                                    <path d="M20 6 9 17l-5-5" />
                                  </svg>
                                  {t('rbac.granted', 'Granted')}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </button>
                          ))}
                          {filteredNamespaces.length === 0 && (
                            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                              {t(
                                'common.messages.noOptionsFound',
                                'No options found'
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </PickerPanel>
                  )}
            </div>

            {!lockedResources?.length && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
                <PickerPanel
                  title={t('common.fields.resources', 'Resources')}
                  search={resourceSearch}
                  onSearchChange={setResourceSearch}
                  searchPlaceholder={t(
                    'common.placeholders.searchItems',
                    'Search...'
                  )}
                  footer={
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'rbac.resourceHint',
                        'Built-in resources use plural names. For CRDs and custom resources enter the CRD name from the URL, e.g. widgets.example.com.'
                      )}
                    </p>
                  }
                >
                  <div className="py-1">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 border-b px-3 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={toggleResourceWildcard}
                      disabled={isSystem}
                    >
                      <span className={checkboxClass(allResourcesGranted)}>
                        {allResourcesGranted && (
                          <svg
                            className="h-3 w-3"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                          >
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        )}
                      </span>
                      <span className="truncate font-medium">
                        {t('rbac.allResourcesWildcard', 'All resources (*)')}
                      </span>
                    </button>
                    {namespacedResourceOptions.length > 0 && (
                      <>
                        <div className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground">
                          {t(
                            'rbac.namespacedResources',
                            'Namespaced resources'
                          )}
                        </div>
                        {namespacedResourceOptions.map(renderResourceOption)}
                      </>
                    )}
                    {visibleClusterScopedOptions.length > 0 && (
                      <>
                        <div className="border-t px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground">
                          {t(
                            'rbac.clusterScopedResources',
                            'Cluster-scoped resources'
                          )}
                        </div>
                        <p className="px-3 pb-1 text-xs text-muted-foreground">
                          {t(
                            'rbac.clusterScopedResourceHint',
                            'Cluster-scoped resources are not limited by the namespace list.'
                          )}
                        </p>
                        {visibleClusterScopedOptions.map(renderResourceOption)}
                      </>
                    )}
                    {namespaceRestricted ? (
                      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                        {t(
                          'rbac.clusterScopedNotSelectable',
                          'This role is limited to the selected namespaces, so cluster-scoped resources (nodes, persistent volumes, ...) are not offered here. Grant them with a role that applies to all namespaces.'
                        )}
                      </p>
                    ) : (
                      filteredResourceOptions.length === 0 && (
                        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                          {t(
                            'common.messages.noOptionsFound',
                            'No options found'
                          )}
                        </div>
                      )
                    )}
                  </div>
                </PickerPanel>
                {permissionsPanel}
              </div>
            )}

            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-1 font-medium">
                {t('rbac.permissionPreviewTitle', 'Permission Preview')}
              </div>
              <p className="text-pretty text-muted-foreground">
                {t(
                  'rbac.permissionPreview',
                  'Allows {{verbs}} on {{resources}} in namespaces {{namespaces}} on clusters {{clusters}}.',
                  {
                    verbs: formatValues(form.verbs),
                    resources: formatValues(form.resources),
                    namespaces: formatValues(form.namespaces),
                    clusters: formatValues(form.clusters),
                  }
                )}
              </p>
            </div>
          </CardContent>
          <CardFooter className="justify-between">
            {!isEdit || !isSystem ? (
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={isSaving || duplicateName}>
                  {isSaving
                    ? t('common.actions.saving', 'Saving...')
                    : isEdit
                      ? t('common.actions.save', 'Save')
                      : t('common.actions.create', 'Create')}
                </Button>
                {showCancelButton && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCancel}
                    disabled={isSaving}
                  >
                    {t('common.actions.cancel', 'Cancel')}
                  </Button>
                )}
              </div>
            ) : (
              <span />
            )}
            {isEdit && !isSystem && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => setShowDelete(true)}
                disabled={deleteMutation.isPending}
              >
                <IconTrash className="h-4 w-4" />
                {t('common.actions.delete', 'Delete')}
              </Button>
            )}
          </CardFooter>
        </Card>
      </form>

      {!showEditForm && role && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <IconShieldCheck className="h-5 w-5" />
                  <span className="truncate">{role.name}</span>
                  <Badge variant="outline">
                    {role.roleType === 'group'
                      ? t('rbac.roleTypeGroup', 'Group Role')
                      : t('rbac.roleTypeUser', 'User Role')}
                  </Badge>
                  {isSystem && (
                    <Badge variant="secondary">
                      {t('common.fields.system', 'System')}
                    </Badge>
                  )}
                </CardTitle>
                {role.description && (
                  <CardDescription>{role.description}</CardDescription>
                )}
              </div>
              {!isSystem && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button type="button" onClick={() => setEditing(true)}>
                    <IconPencil className="h-4 w-4" />
                    {t('common.actions.edit', 'Edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setShowDelete(true)}
                    disabled={deleteMutation.isPending}
                  >
                    <IconTrash className="h-4 w-4" />
                    {t('common.actions.delete', 'Delete')}
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ReadOnlyField label={t('common.fields.resources', 'Resources')}>
              {formatValues(
                lockedResources?.length ? lockedResources : form.resources
              )}
            </ReadOnlyField>
            <ReadOnlyField label={t('common.fields.clusters', 'Clusters')}>
              {formatValues(form.clusters)}
            </ReadOnlyField>
            <ReadOnlyField
              label={
                grantedPermissionLabels
                  ? t('rbac.permissionsSection', 'Permissions')
                  : t('common.fields.verbs', 'Verbs')
              }
            >
              {grantedPermissionLabels
                ? grantedPermissionLabels.length > 0
                  ? grantedPermissionLabels.join(', ')
                  : '-'
                : formatValues(form.verbs)}
            </ReadOnlyField>
            <ReadOnlyField label={t('rbac.membersTitle', 'Members')}>
              {role.assignments?.length ?? 0}
            </ReadOnlyField>
          </CardContent>
        </Card>
      )}

      {isEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconUsers className="h-5 w-5" />
              {t('rbac.membersTitle', 'Members')}
            </CardTitle>
            <CardDescription>
              {subjectKind === 'user'
                ? t('rbac.membersHintUser', 'Users assigned to this role.')
                : t(
                    'rbac.membersHintGroup',
                    'LDAP / OIDC groups assigned to this role.'
                  )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-hidden rounded-md border">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
                <span>{t('common.fields.username', 'Username')}</span>
                <span>{t('rbac.roleColumn', 'Role')}</span>
                <span />
              </div>
              {memberRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('rbac.noMembers', 'No members assigned yet.')}
                </div>
              ) : (
                memberRows.map((row) => (
                  <div
                    key={row.key}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem] items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {row.subjectType === 'user' ? (
                        <IconUser className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <IconUsers className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate" title={row.subject}>
                        {row.subject}
                      </span>
                    </div>
                    <span className="truncate text-muted-foreground">
                      {role!.name}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      disabled={isUnassigning}
                      aria-label={`${t('common.actions.remove', 'Remove')} ${row.subject}`}
                      onClick={() =>
                        handleRemoveMember(row.subjectType, row.subject)
                      }
                    >
                      <IconX className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>

            <form
              onSubmit={handleAddMembers}
              className="grid grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="space-y-2">
                <Label>
                  {subjectKind === 'user'
                    ? t('common.fields.users', 'Users')
                    : t('common.fields.oidcGroups', 'LDAP / OIDC Groups')}
                </Label>
                <MultiSelect
                  key={subjectKind}
                  value={selectedSubjects}
                  onChange={setSelectedSubjects}
                  options={memberOptions}
                  max={subjectKind === 'user' ? 1 : undefined}
                  selectAllMode="all"
                  allowAdd={false}
                  disabled={isAssigning || memberOptionsLoading}
                  placeholder={
                    memberOptionsLoading
                      ? t('common.messages.loading', 'Loading...')
                      : subjectKind === 'user'
                        ? t('common.placeholders.selectUser', 'Select user')
                        : t(
                            'common.placeholders.selectGroups',
                            'Select groups...'
                          )
                  }
                  emptyText={
                    subjectKind === 'user'
                      ? t('common.messages.noUsersFound', 'No users found')
                      : t('common.messages.noGroupsFound', 'No groups found')
                  }
                />
                {memberOptionsError && (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    <span className="min-w-0 break-words">
                      {memberOptionsError}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void retryMemberOptions()}
                      disabled={isAssigning}
                    >
                      {t('common.actions.retry', 'Retry')}
                    </Button>
                  </div>
                )}
              </div>

              <Button
                type="submit"
                className="mt-7"
                disabled={selectedSubjects.length === 0 || isAssigning}
              >
                <IconPlus className="h-4 w-4" />
                {isAssigning
                  ? t('common.actions.assigning', 'Assigning...')
                  : t('rbac.addMember', 'Add')}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <DeleteConfirmationDialog
        open={showDelete}
        onOpenChange={() => setShowDelete(false)}
        onConfirm={() => deleteMutation.mutate()}
        resourceName={role?.name || ''}
        resourceType="role"
        isDeleting={deleteMutation.isPending}
        additionalNote={
          currentUsers.some((a) => a.subject === currentUser?.username)
            ? t(
                'rbac.deleteOwnRoleWarning',
                'This role is assigned to your current user. Deleting it may affect your permissions.'
              )
            : undefined
        }
      />

      <Dialog
        open={!!pendingRemoval}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingRemoval(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div className="flex-1">
                <DialogTitle className="text-left">
                  {t('rbac.confirmRemoveOwnRoleTitle', 'Remove your role?')}
                </DialogTitle>
                <DialogDescription className="text-left">
                  {t(
                    'common.messages.confirmRemoveOwnRole',
                    'You are removing your own role assignment. This may affect your permissions. Are you sure?'
                  )}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingRemoval(null)}
              disabled={isUnassigning}
            >
              {t('common.actions.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() =>
                pendingRemoval &&
                void confirmRemoveMember(
                  pendingRemoval.subjectType,
                  pendingRemoval.subject
                )
              }
              disabled={isUnassigning}
            >
              {isUnassigning
                ? t('common.actions.removing', 'Removing...')
                : t('common.actions.remove', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default RBACRoleDetail
