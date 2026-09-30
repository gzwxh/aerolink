import { describe, expect, it } from 'vitest'

import {
  roleCanAccess,
  roleCanAccessAnyNamespace,
  roleCanAccessAnySettingsSection,
  roleCanManageSettingsSection,
  roleCanViewSettingsSection,
  separationOfDutiesConflict,
  SETTINGS_SECTIONS,
  settingsSectionResource,
  SYSTEM_SETTINGS_RESOURCE,
  type AccessRole,
} from './rbac-permissions'

const role = (overrides: Partial<AccessRole> = {}): AccessRole => ({
  name: 'test-role',
  clusters: ['*'],
  resources: ['*'],
  namespaces: ['*'],
  verbs: ['*'],
  ...overrides,
})

describe('roleCanAccess', () => {
  it('grants namespaced resources inside the granted namespace only', () => {
    const roles = [role({ namespaces: ['dev'] })]
    expect(roleCanAccess(roles, 'pods', 'get', { namespace: 'dev' })).toBe(true)
    expect(roleCanAccess(roles, 'pods', 'get', { namespace: 'prod' })).toBe(
      false
    )
  })

  it('does not let a wildcard grant reach cluster-scoped resources for namespace-restricted roles', () => {
    const roles = [role({ namespaces: ['dev'] })]
    expect(roleCanAccess(roles, 'nodes', 'get')).toBe(false)
    expect(roleCanAccess(roles, 'persistentvolumes', 'get')).toBe(false)
  })

  it('honours an explicit cluster-scoped grant in a namespace-restricted role', () => {
    const roles = [role({ namespaces: ['dev'], resources: ['nodes'] })]
    expect(roleCanAccess(roles, 'nodes', 'get')).toBe(true)
  })

  it('keeps wildcard access to cluster-scoped resources for cluster-wide roles', () => {
    const roles = [role({ namespaces: ['*'] })]
    expect(roleCanAccess(roles, 'nodes', 'get')).toBe(true)
  })

  it('respects cluster and verb filters', () => {
    const roles = [role({ clusters: ['dev'], verbs: ['get'] })]
    expect(roleCanAccess(roles, 'nodes', 'get', { cluster: 'dev' })).toBe(true)
    expect(roleCanAccess(roles, 'nodes', 'get', { cluster: 'prod' })).toBe(
      false
    )
    expect(roleCanAccess(roles, 'nodes', 'delete')).toBe(false)
  })

  it('denies everything without roles', () => {
    expect(roleCanAccess([], 'pods', 'get')).toBe(false)
    expect(roleCanAccess(undefined, 'pods', 'get')).toBe(false)
  })
})

describe('roleCanAccessAnyNamespace', () => {
  it('grants a namespaced verb as soon as one namespace is covered', () => {
    const roles = [role({ namespaces: ['dev'] })]
    expect(roleCanAccessAnyNamespace(roles, 'configmaps', 'create')).toBe(true)
    expect(
      roleCanAccess(roles, 'configmaps', 'create', { namespace: 'prod' })
    ).toBe(false)
  })

  it('treats an empty namespace list as unconstrained, but not a deny-only one', () => {
    // 镜像 pkg/rbac/rbac.go 的 CanAccess：角色不再携带命名空间字段，
    // 列表为空表示不约束（命名空间范围由权限绑定组圈定）。
    expect(
      roleCanAccessAnyNamespace(
        [role({ namespaces: [] })],
        'configmaps',
        'create'
      )
    ).toBe(true)
    expect(
      roleCanAccess([role({ namespaces: [] })], 'configmaps', 'create', {
        namespace: 'prod',
      })
    ).toBe(true)
    expect(
      roleCanAccessAnyNamespace(
        [role({ namespaces: ['!kube-system'] })],
        'configmaps',
        'create'
      )
    ).toBe(false)
  })

  it('still filters cluster, resource and verb', () => {
    const roles = [
      role({ clusters: ['dev'], resources: ['configmaps'], verbs: ['get'] }),
    ]
    expect(
      roleCanAccessAnyNamespace(roles, 'configmaps', 'get', { cluster: 'dev' })
    ).toBe(true)
    expect(
      roleCanAccessAnyNamespace(roles, 'configmaps', 'get', { cluster: 'prod' })
    ).toBe(false)
    expect(roleCanAccessAnyNamespace(roles, 'configmaps', 'delete')).toBe(false)
    expect(roleCanAccessAnyNamespace(roles, 'secrets', 'get')).toBe(false)
  })

  it('keeps cluster-scoped resources behind an explicit grant', () => {
    expect(
      roleCanAccessAnyNamespace(
        [role({ namespaces: ['dev'] })],
        'nodes',
        'update'
      )
    ).toBe(false)
    expect(
      roleCanAccessAnyNamespace(
        [role({ namespaces: ['dev'], resources: ['nodes'] })],
        'nodes',
        'update'
      )
    ).toBe(true)
  })

  it('denies everything without roles', () => {
    expect(roleCanAccessAnyNamespace([], 'configmaps', 'create')).toBe(false)
    expect(roleCanAccessAnyNamespace(undefined, 'configmaps', 'create')).toBe(
      false
    )
  })
})

// 「创建命名空间」是管理员专属动作，不通过角色 / 权限绑定组下发（见
// docs/dev/plans/2026-09-20-创建命名空间只归管理员.md）；其余操作仍按哨兵值
// （集群级请求为 _all）匹配角色的命名空间列表。
describe('namespaces resource', () => {
  it('needs the cluster-wide sentinel for list and delete', () => {
    const wildcard = [role({ namespaces: ['*'] })]
    expect(roleCanAccess(wildcard, 'namespaces', 'get')).toBe(true)
    expect(roleCanAccessAnyNamespace(wildcard, 'namespaces', 'get')).toBe(true)
    expect(roleCanAccess(wildcard, 'namespaces', 'delete')).toBe(true)

    const restricted = [role({ namespaces: ['dev'] })]
    expect(roleCanAccess(restricted, 'namespaces', 'get')).toBe(false)
    expect(roleCanAccessAnyNamespace(restricted, 'namespaces', 'get')).toBe(
      false
    )
  })

  it('never grants creation through roles, however the role is written', () => {
    const candidates = [
      [role({ namespaces: ['dev'], resources: ['namespaces'] })],
      [role({ namespaces: ['*'], resources: ['namespaces'] })],
      // resources: ['*'] 是默认值：通配资源同样不算。
      [role({ namespaces: ['dev'] })],
      [
        role({
          resources: [],
          grants: [{ resource: 'namespaces', verbs: ['create'] }],
        }),
      ],
    ]
    for (const roles of candidates) {
      expect(roleCanAccess(roles, 'namespaces', 'create')).toBe(false)
      expect(roleCanAccessAnyNamespace(roles, 'namespaces', 'create')).toBe(
        false
      )
    }
  })

  it('grants creation to administrators only', () => {
    const admin = [role({ resources: ['namespaces'], verbs: ['create'] })]
    expect(
      roleCanAccess(admin, 'namespaces', 'create', { isAdmin: true })
    ).toBe(true)
    expect(
      roleCanAccessAnyNamespace(admin, 'namespaces', 'create', {
        isAdmin: true,
      })
    ).toBe(true)
    // 没有管理员标记（普通账号）一律拒绝，即便角色里写着 create。
    expect(roleCanAccess(admin, 'namespaces', 'create')).toBe(false)
    expect(roleCanAccessAnyNamespace(admin, 'namespaces', 'create', {})).toBe(
      false
    )
  })

  it('does not let the creation rule widen other namespace operations', () => {
    const roles = [role({ namespaces: ['dev'], resources: ['namespaces'] })]
    expect(
      roleCanAccess(roles, 'namespaces', 'delete', { namespace: 'dev' })
    ).toBe(true)
    expect(
      roleCanAccess(roles, 'namespaces', 'delete', { namespace: 'prod' })
    ).toBe(false)
    expect(roleCanAccessAnyNamespace(roles, 'namespaces', 'delete')).toBe(false)
    // 管理员身份也不放宽创建之外的操作。
    expect(
      roleCanAccess(roles, 'namespaces', 'delete', {
        namespace: 'prod',
        isAdmin: true,
      })
    ).toBe(false)
  })

  it('matches the concrete namespace for single-namespace checks', () => {
    const roles = [role({ namespaces: ['dev'] })]
    expect(
      roleCanAccess(roles, 'namespaces', 'get', { namespace: 'dev' })
    ).toBe(true)
    expect(
      roleCanAccess(roles, 'namespaces', 'get', { namespace: 'prod' })
    ).toBe(false)
  })
})

// 控制台设置按章节授权：通配 * 不覆盖它们，父级 settings 覆盖全部章节，
// 章节规则不反向覆盖父级。镜像后端 settingsRoleAllows。
describe('console settings sections', () => {
  const auditResource = settingsSectionResource('audit')

  it('is not covered by the resource wildcard', () => {
    const wildcard = [role()]
    expect(roleCanViewSettingsSection(wildcard, 'audit')).toBe(false)
    expect(roleCanViewSettingsSection(wildcard, 'users')).toBe(false)
    expect(roleCanManageSettingsSection(wildcard, 'audit')).toBe(false)
    expect(roleCanAccessAnySettingsSection(wildcard)).toBe(false)
  })

  it('grants one section without the others', () => {
    const auditor = [
      role({
        resources: [],
        verbs: ['get'],
        grants: [{ resource: auditResource, verbs: ['get'] }],
      }),
    ]
    expect(roleCanViewSettingsSection(auditor, 'audit')).toBe(true)
    expect(roleCanManageSettingsSection(auditor, 'audit')).toBe(false)
    expect(roleCanViewSettingsSection(auditor, 'users')).toBe(false)
    expect(roleCanAccessAnySettingsSection(auditor)).toBe(true)
  })

  it('lets the parent resource cover every section, but not the other way round', () => {
    const parent = [role({ resources: [SYSTEM_SETTINGS_RESOURCE] })]
    expect(roleCanViewSettingsSection(parent, 'audit')).toBe(true)
    expect(roleCanViewSettingsSection(parent, 'users')).toBe(true)

    const sectionOnly = [
      role({
        resources: [],
        verbs: ['get'],
        grants: [{ resource: auditResource, verbs: ['get'] }],
      }),
    ]
    expect(roleCanManageSettingsSection(sectionOnly, '', 'get')).toBe(false)
  })

  it('treats the manage verb as read access and keeps them separate otherwise', () => {
    const manageOnly = [
      role({
        resources: [],
        verbs: [],
        grants: [{ resource: auditResource, verbs: ['update'] }],
      }),
    ]
    expect(roleCanViewSettingsSection(manageOnly, 'audit')).toBe(true)
    expect(roleCanManageSettingsSection(manageOnly, 'audit')).toBe(true)
  })

  // 内置最高权限角色的真实形状（resources: ['*', 'settings']，没有 grants，来自 bootstrap
  // 接口）：它必须对每个章节都可写，否则整个设置界面会对超级管理员变成只读。
  // 代次 3 起这个角色就是系统管理员（admin），超级角色已并入它。
  it('keeps the built-in administrator role writable on every section', () => {
    const admin = [
      role({ name: 'admin', resources: ['*', 'settings'], verbs: ['*'] }),
    ]
    for (const section of SETTINGS_SECTIONS) {
      expect(roleCanManageSettingsSection(admin, section)).toBe(true)
      expect(roleCanViewSettingsSection(admin, section)).toBe(true)
    }
    expect(roleCanAccessAnySettingsSection(admin)).toBe(true)
  })
})

// 三员互斥：职责分离的客户端镜像。
describe('separationOfDutiesConflict', () => {
  const names = (...list: string[]): AccessRole[] =>
    list.map((name) => role({ name }))

  it('reports the three administrator roles as mutually exclusive', () => {
    expect(separationOfDutiesConflict(names('admin')).conflict).toBe(false)
    expect(separationOfDutiesConflict(names('auditor')).conflict).toBe(false)

    const conflict = separationOfDutiesConflict(names('admin', 'auditor'))
    expect(conflict.conflict).toBe(true)
    expect(conflict.roles).toEqual(['admin', 'auditor'])

    expect(
      separationOfDutiesConflict(names('security-admin', 'auditor')).conflict
    ).toBe(true)
  })

  it('does not constrain the read-only role', () => {
    expect(separationOfDutiesConflict(names('viewer')).conflict).toBe(false)
    expect(separationOfDutiesConflict(names('viewer', 'admin')).conflict).toBe(
      false
    )
  })
})
