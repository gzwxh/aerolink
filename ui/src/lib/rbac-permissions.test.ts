import { describe, expect, it } from 'vitest'

import {
  roleCanAccess,
  roleCanAccessAnyNamespace,
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

  it('needs a positive namespace pattern, not an empty or deny-only list', () => {
    expect(
      roleCanAccessAnyNamespace(
        [role({ namespaces: [] })],
        'configmaps',
        'create'
      )
    ).toBe(false)
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

describe('namespaces resource', () => {
  it('needs the cluster-wide sentinel for list / create / delete', () => {
    const wildcard = [role({ namespaces: ['*'] })]
    expect(roleCanAccess(wildcard, 'namespaces', 'create')).toBe(true)
    expect(roleCanAccessAnyNamespace(wildcard, 'namespaces', 'create')).toBe(
      true
    )

    const restricted = [role({ namespaces: ['dev'] })]
    expect(roleCanAccess(restricted, 'namespaces', 'create')).toBe(false)
    expect(roleCanAccessAnyNamespace(restricted, 'namespaces', 'create')).toBe(
      false
    )
  })

  it('is not widened by naming the resource explicitly', () => {
    const roles = [role({ namespaces: ['dev'], resources: ['namespaces'] })]
    expect(roleCanAccess(roles, 'namespaces', 'create')).toBe(false)
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
