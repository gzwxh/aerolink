# RBAC Management

RBAC management APIs are under `/api/v1/admin/roles/`.

These endpoints require an authenticated admin user, or an API key with the `admin` role.

## List roles

```http
GET /api/v1/admin/roles/
```

Example:

```bash
curl \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/roles/
```

Response example:

```json
{
  "roles": [
    {
      "id": 2,
      "name": "viewer",
      "description": "Viewer role with read-only access",
      "isSystem": true,
      "clusters": ["*"],
      "namespaces": ["*"],
      "resources": ["*"],
      "verbs": ["get", "log"],
      "assignments": []
    }
  ]
}
```

## Get a single role

```http
GET /api/v1/admin/roles/:id
```

## Create a role

```http
POST /api/v1/admin/roles/
Content-Type: application/json
```

Request body:

```json
{
  "name": "namespace-editor",
  "displayName": "Namespace Editor",
  "description": "Edit workloads in dev",
  "namespaces": ["dev"],
  "resources": ["deployments", "pods", "services"],
  "verbs": ["get", "create", "update", "delete", "log"]
}
```

A role carries no cluster attribute: roles are global and only define *what* may
be done (resources and verbs). *Where* it applies — which cluster and which
namespaces — is defined by the permission binding group that binds the role to a
subject. The legacy `namespaces` field is kept for compatibility but no longer
drives authorization either.

The group's namespace list only narrows rules that name specific resources (a
role that only grants `pods`, for example). A rule that uses the bare `*` resource
wildcard (permission IDs such as `k8s:*:get`) names every resource of the
cluster, so it applies to the whole cluster: the group's namespace list does not
narrow it, and cluster-scoped resources (nodes, persistent volumes, ...) plus
cross-namespace requests are granted as well.

`name` is the role ID: it is globally unique and is what permission bindings and
authorization are evaluated against, and the console no longer offers a way to
change it after creation. `displayName` is an optional display-only label — it
never affects authorization. When it is empty (or an empty string) a built-in
role shows its built-in name in the console language, and a custom role shows
`name`.

Example:

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"namespace-editor",
    "description":"Edit workloads in dev",
    "namespaces":["dev"],
    "resources":["deployments","pods","services"],
    "verbs":["get","create","update","delete","log"]
  }' \
  https://kite.example.com/api/v1/admin/roles/
```

## Update a role

```http
PUT /api/v1/admin/roles/:id
Content-Type: application/json
```

Request body uses the same fields as create.

`roleType` and `namespaces` are optional. The role editor defines a role by
resources and verbs; cluster and namespace scope are defined by the permission
binding group that binds the role to a subject. A request that omits `namespaces`
creates a user role without a namespace restriction, while an update leaves the
stored values unchanged. `clusters` is accepted but ignored: roles are always
global.

`grants` is the authoritative per-resource form:
`[{"resource": "nodes", "verbs": ["get", "exec"]}, {"resource": "pods",
"verbs": ["get"]}]`. Each resource carries its own verbs, so one role can grant
different operations on different resources (for example node terminal access
without pod terminal access). `resources` and `verbs` are the derived union of
`grants` and are kept for clients that only understand the flat form. A role
stored without `grants` keeps the legacy semantics, where the verbs apply to every
listed resource.

The three separation-of-duties roles and the read-only administrator are
read-only in the console. `admin`, `security-admin` and `auditor` answer `403`
with `{"code": "protected_role_immutable"}`: their permission sets _are_ the
separation of duties. `viewer` (read-only administrator) is protected the same
way — its rules are maintained in code and must not be edited away from the
built-in definition — so for all four roles the only supported change is
`POST /roles/:id/restore_defaults`.

Creating a role under, or renaming one to, a reserved name answers `409` with
`{"code": "role_name_reserved"}`. The reserved names are `admin`, the only
highest-privilege role, and the retired `super-admin`, so a custom role can never
be mistaken for the built-in administrator entry.

## Console settings permissions

Console settings are authorised **per section**. Each section of the settings
area is a synthetic resource named `settings.<section>`, not backed by a
Kubernetes API, and the bare `settings` resource covers every section. The
sections are `general`, `clusters`, `notification`, `templates`, `apikeys`,
`authentication`, `users`, `rbac`, `security` and `audit`.

Each resource has two verbs:

- `get` — read that section (the page loads and its read APIs answer);
- `update` — change it (create, edit, delete). A role with `update` may read as
  well.

```json
{
  "grants": [
    { "resource": "settings.clusters", "verbs": ["update"] },
    { "resource": "settings.audit", "verbs": ["get"] }
  ]
}
```

The example above describes an operator who maintains clusters and may read the
audit trail — the shape used for separation of duties, where the security and
audit duties are delegated as sections of their own:

| Built-in role | Console settings sections |
| --- | --- |
| `admin` (system administrator) | all sections (through the parent `settings`) |
| `security-admin` | `authentication`, `users`, `rbac`, `security` |
| `auditor` | `audit` (`get` and `update`; `update` only configures the retention policy and syslog forwarding, the records themselves stay read-only) |
| `viewer` | none |

`admin` holding every section, security policy and audit log included, is a
deliberate departure from the original 等保三级 (Classified Protection Level 3)
separation-of-duties layout, which kept the system administrator out of the
security policy and the audit log. It is recorded in
`等保三级-三权分立权限方案.md` and has to be re-evaluated against the new
compliance plan; `security-admin` and `auditor` still exist so that security
authorization and audit can be delegated to someone else.

Two rules matter here:

- **The `*` resource wildcard does NOT cover the settings resources.** They have
  to be granted explicitly, so a role holding `resources: ["*"]` cannot
  accidentally collect the configuration, authorization and audit sections and
  merge the three administrative duties into one account. `admin` is the only
  role meant to reach every section, and it does so by holding the parent
  `settings` resource beside the wildcard.
- **A section grant does not imply the parent.** Granting `settings.audit` does
  not grant `settings`; grant the parent (or every section) if a role needs the
  whole settings area.

Reaching `/api/v1/admin/*` at all requires at least one `settings.<section>`
permission (or the `admin` role), which is how the security and audit
administrators use their own pages without being handed a full administrator
role.

## Separation of duties

The three administrative duties must be held by different people, so the built-in
roles `admin`, `security-admin` and `auditor` are mutually exclusive. An account
that ends up holding more than one of them is rejected on every administration
surface with `403` and `{"code": "role_conflict", "roles": [...]}`; assigning
such a combination is rejected with `409 role_conflict`. Cluster resource access
is deliberately unaffected, because group membership may come from an external
directory.

Change the system role defaults

```http
POST /api/v1/admin/roles/:id/restore_defaults
```

Resets a built-in system role to the definition shipped with this release and
answers with the updated role. Only `isSystem` roles have defaults; custom roles
answer `400 not_a_system_role`. This is the way back when a built-in role's rules
were edited into something that no longer matches the built-in duties; for the
four protected roles it is the only permitted change.

## Delete a role

```http
DELETE /api/v1/admin/roles/:id
```

Deleting a role also removes its references: direct role assignments and
permission binding group members are deleted in the same transaction, so no
row is left pointing at a role id that no longer exists.

The four protected roles (`admin`, `security-admin`, `auditor` and `viewer`)
answer `403` with `{"code": "protected_role_immutable"}`.

`super-admin` is no longer a role to delete at all: generation 3 of the built-in
role rules merged it into `admin` and retired it. The stored role row, its
assignments and its permission binding group members are removed by a one-way
migration, and the role is not created again — not on restart and not by a
role-rules upgrade. The first migration records the
`general_settings.super_role_removed` marker, so it only runs once. "Super
administrator" is therefore an account-level concept only: the
`users.is_super_admin` flag together with the protected, global-scope super
permission binding group, which is what the account created by the setup wizard
holds.

Example:

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/roles/3
```

Response example:

```json
{
  "success": true
}
```

## Assign a role

```http
POST /api/v1/admin/roles/:id/assign
Content-Type: application/json
```

Request body:

```json
{
  "subjectType": "user",
  "subject": "alice"
}
```

Supported `subjectType` values in the current server implementation:

- `user`
- `group`

Example:

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{"subjectType":"group","subject":"platform-team"}' \
  https://kite.example.com/api/v1/admin/roles/3/assign
```

## Unassign a role

```http
DELETE /api/v1/admin/roles/:id/assign?subjectType=user&subject=alice
```

Example:

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  "https://kite.example.com/api/v1/admin/roles/3/assign?subjectType=group&subject=platform-team"
```
