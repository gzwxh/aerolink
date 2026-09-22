# User Management

User management APIs are under `/api/v1/admin/users/`.

These endpoints require an authenticated admin user, or an API key with the `admin` role, unless noted otherwise.

## Bootstrap the first super user

This route is intended for first-time setup and is available before admin authentication is established.

```http
POST /api/v1/admin/users/create_super_user
Content-Type: application/json
```

Request body:

```json
{
  "username": "admin",
  "password": "change-me",
  "name": "Administrator"
}
```

It only succeeds when the system has no users yet.

## List users

```http
GET /api/v1/admin/users/
```

Supported query parameters:

- `page`
- `size`
- `search`
- `role`
- `sortBy`
- `sortOrder`

Example:

```bash
curl \
  -H "Authorization: aerolink1-adminsecret" \
  "https://aerolink.example.com/api/v1/admin/users/?page=1&size=20&search=alice&sortOrder=desc"
```

Response example:

```json
{
  "users": [
    {
      "id": 12,
      "username": "alice",
      "provider": "password",
      "name": "Alice",
      "enabled": true,
      "lastLoginAt": "2026-04-20T08:30:00Z",
      "roles": [
        {
          "id": 2,
          "name": "viewer"
        }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "size": 20
}
```

## Create a password user

```http
POST /api/v1/admin/users/
Content-Type: application/json
```

Request body:

```json
{
  "username": "alice",
  "password": "change-me",
  "name": "Alice"
}
```

Example:

```bash
curl \
  -X POST \
  -H "Authorization: aerolink1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"change-me","name":"Alice"}' \
  https://aerolink.example.com/api/v1/admin/users/
```

## Update a user

```http
PUT /api/v1/admin/users/:id
Content-Type: application/json
```

Request body (every field is optional; only the fields present in the request are
applied, and an explicit empty value clears that field):

```json
{
  "name": "Alice Zhang",
  "avatar_url": "https://example.com/avatar.png",
  "email": "alice@example.com",
  "phone": "13800000000",
  "remark": "Contractor account",
  "groups": ["dev", "sre"]
}
```

Example:

```bash
curl \
  -X PUT \
  -H "Authorization: aerolink1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice Zhang"}' \
  https://aerolink.example.com/api/v1/admin/users/12
```

Which fields apply to which account:

- **Local (password) accounts**: `name`, `avatar_url`, `email`, `phone`, `remark` and
  `groups` are all editable. `email` is validated like the self-service profile update
  (trim, length, address format) and an invalid value returns `400` without writing
  anything. `groups` is the full group list (an empty array leaves the user in no
  group) and feeds group-based RBAC.
- **Directory accounts (LDAP / OIDC)**: only `avatar_url` is honoured. `name`, `email`,
  `phone`, `remark` and `groups` are owned by the source system and are silently
  ignored rather than rejected. To add a local extra group for such an account, use the
  per-member endpoints below.

The password is not changed here; local accounts use the reset-password endpoint below.

## List a group's members

```http
GET /api/v1/admin/groups/:name/members
```

```json
{
  "members": [
    { "username": "alice", "name": "Alice", "provider": "password", "source": "local" },
    { "username": "bob", "name": "Bob", "provider": "ldap", "source": "local" },
    { "username": "carol", "name": "Carol", "provider": "ldap", "source": "ldap" }
  ]
}
```

`source` is the origin of the membership row, not of the account:

- `local` — added in the console. Directory sync never removes it.
- `ldap` / `oidc` — brought in by the directory; it is removed there.

## Add a group member

```http
POST /api/v1/admin/groups/:name/members
Content-Type: application/json

{ "username": "bob" }
```

Any account can be added, including LDAP / OIDC accounts. The membership is
recorded as a **local addition**: the directory keeps owning the account's own
groups, and the next sync will not remove the group added here. The user
therefore also gets every role granted to this group.

## Remove a group member

```http
DELETE /api/v1/admin/groups/:name/members/:username
```

Only local additions can be removed here. Removing a directory-managed
membership is rejected with `409` and code `group_member_directory_managed`,
because the next sync would bring it right back.

## Delete a user

```http
DELETE /api/v1/admin/users/:id
```

Example:

```bash
curl \
  -X DELETE \
  -H "Authorization: aerolink1-adminsecret" \
  https://aerolink.example.com/api/v1/admin/users/12
```

Response example:

```json
{
  "success": true
}
```

The built-in super administrator can **never** be deleted: the request is rejected
with `400` and code `user_super_admin_not_deletable`. Disable the account instead
(see below) — it is the reversible way to take the account out of service.

For every other account the deletion is refused (`400`, code
`user_last_administrator`) when it would leave the console with no enabled account
holding the administrator role.

## Reset a user's password

```http
POST /api/v1/admin/users/:id/reset_password
Content-Type: application/json
```

Request body:

```json
{
  "password": "new-password"
}
```

## List the accounts disabled by the inactivity policy

```http
GET /api/v1/admin/users/disabled
```

Lists the accounts the inactivity policy switched off, newest first, so an
administrator can restore them with the endpoint below. The response is
`{"users": [...]}`.

This used to live at `GET /api/v1/admin/notification-setting/disabled-users`.
It moved under `users` because it returns user data and because the console panel
that shows it restores accounts through `POST /users/:id/enable`: keeping the read
and the write in the same settings section is what stops an account that may only
touch one section from seeing an empty panel or a button that fails on click.

## Enable or disable a user

```http
POST /api/v1/admin/users/:id/enable
Content-Type: application/json
```

Request body:

```json
{
  "enabled": false
}
```

Response example:

```json
{
  "success": true
}
```

The built-in super administrator can be disabled, but only while another enabled
account holds the administrator role — directly, through one of its user groups,
or through a global-scope permission binding group. A plain security or audit
administrator is **not** enough: they can open their own pages but cannot take
over the administrator's job. Otherwise the request is rejected with `400` and
code `user_last_administrator`. Deleting the account is never allowed.
