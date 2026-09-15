# Authentication

Kite supports interactive login through OAuth, password users, LDAP, and MFA, plus programmatic access through API keys. API keys authenticate as special users and follow the same RBAC model as interactive users.

## Interactive login

Password login uses:

```http
POST /api/auth/login/password
Content-Type: application/json
```

Request body:

```json
{
  "username": "alice",
  "password": "change-me",
  "mfa_code": "123456"
}
```

`mfa_code` is required only when MFA is enabled for the password user.

LDAP login uses the same request body at `POST /api/auth/login/ldap`.

## MFA

MFA is available for password users. Users manage MFA from account settings, or through these authenticated endpoints:

```http
POST /api/users/me/mfa/setup
POST /api/users/me/mfa/enable
POST /api/users/me/mfa/disable
```

Setup requires the current password:

```json
{
  "current_password": "change-me"
}
```

The setup response includes `secret`, `otpauth_url`, and `qr_code`. Enable or disable MFA by submitting a TOTP code:

```json
{
  "code": "123456"
}
```


## Authentication settings

Admins can enable or disable password login and MFA in **Settings -> Authentication**.

The same settings are available through:

```http
GET /api/v1/admin/general-setting/
PUT /api/v1/admin/general-setting/
```

Relevant request fields:

```json
{
  "passwordLoginDisabled": false,
  "enableMFA": true
}
```

## Login attempt blocking

Credential-based logins are temporarily blocked by client IP after repeated invalid password or MFA attempts. Kite allows up to 10 failures within 1 minute; the next failure blocks further credential login attempts from that client IP for 5 minutes.

When Kite runs behind an ingress or load balancer, the client IP used by this limiter depends on `TRUSTED_PROXIES`. See [Environment Variables](/config/env#environment-variables) for how to configure trusted proxy ranges.

## API key format

The full API key format is:

```text
kite<ID>-<SECRET>
```

Use the full value directly in the `Authorization` header. Do not prepend `Bearer`.

```http
Authorization: kite12-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Where to configure it

Users with the `admin` role can create API keys in **Settings -> API Keys**.

After creating a key, copy the full value and use it as the `Authorization` header for API requests.

## Permissions

API keys use the same RBAC model as regular users.

- Creating an API key does not automatically grant any resource permissions.
- Resource access under `/api/v1/...` is still checked by RBAC.
- Admin APIs under `/api/v1/admin/...` require the caller to have the `admin` role.
- Cluster resource APIs usually also require `x-cluster-name`.

## Authenticate requests

Example:

```bash
curl \
  -H "Authorization: kite12-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "x-cluster-name: demo-cluster" \
  https://kite.example.com/api/v1/pods/default
```

Notes:

- Resource endpoints under `/api/v1/...` usually also require `x-cluster-name`.
