# Security Policy

Accounts, authentication sources, password rules, sessions and login restrictions all live in
“System Settings → **Security**”, split into five tabs: Authentication, Login Restrictions, Password
Security, Session Security and Auth Providers. The policy is stored in a single JSON column
(`security_settings.data`) and takes effect immediately (some parts are cached for 30 seconds, so up
to half a minute of lag).

This page covers the policies themselves. For creating accounts and assigning roles see
[User Management](./user-management); for section permissions and permission bindings see
[RBAC Configuration](./rbac-config).

## Authentication

### Login CAPTCHA

“Enable login CAPTCHA” is **off** by default. When enabled, every client must solve a graphical
CAPTCHA to log in, which breaks scripted logins (`curl`, logins from CI). Keep that in mind for
automation on the intranet.

### Automatic disabling of inactive users

“Disable long-inactive users” defaults to **999 days** (effectively off). With a positive value,
accounts without a login for that many days are **disabled**; the check runs daily, and the “User
status” card on the same page can run it immediately or restore the automatically disabled accounts
in bulk.

### Remote login notifications

**On** by default. A login is flagged when the IP is not in the account's usual login cities; the
account holder and anyone subscribed to the event are notified, see
[Notifications & Announcements](../guide/notification-and-announcements).

### Multi-factor authentication (one-time codes)

| Setting | Values | Default |
| --- | --- | --- |
| Require one-time codes | Never / All users / Administrators only | Never |
| Require for third-party users | Directory (LDAP, …) accounts must bind as well | On |
| Require for sensitive actions | Re-verify before delete actions and interactive terminals | On |
| Verification validity | How long one verification is reused (seconds) | 60 |
| OTP issuer name | Name shown in the authenticator app | 鸢联 AeroLink |
| Accepted windows | How many 30-second windows are accepted (clock skew) | 2 |

Implementation details:

- Standard TOTP: SHA-1, 30-second step, 6 digits; binding uses a QR code (`otpauth://` link).
- When the policy applies, enforcement is **per request**: the account may only call the binding
  endpoints, everything else is rejected until binding is complete.
- Self-service binding lives in “Profile → Security”. Local password accounts and LDAP accounts can
  bind themselves; OIDC accounts cannot (the IdP handles authentication). Binding requires a
  re-authentication within the last 5 minutes; LDAP accounts have no local password and confirm with
  the directory password instead.
- An administrator can “Reset one-time code” from the user detail page; the user enters the binding
  flow again at the next login.
- Viewing a kubeconfig also requires a one-time code.
- If the global one-time-code switch under “System Settings → General” is turned off, binding is
  impossible — check that first when troubleshooting.

### Step-up for sensitive actions

When enabled, delete actions and opening an interactive terminal (web terminal, Pod terminal, kubectl
terminal) ask for a fresh one-time code; the verification is then reused for the configured validity
window.

## Login restrictions

### Failure lockout

| Setting | Default | Notes |
| --- | --- | --- |
| Failed attempts per user | 7 | The account is then locked |
| User lock duration | 30 minutes | Unlocks automatically |
| Failed attempts per IP | 5 | The source IP is then locked |
| IP lock duration | 30 minutes | Unlocks automatically |

While locked, even the correct password cannot log in and the login log records
`too_many_attempts`. Two cards — “Locked IPs” and “Locked users” — list current lockouts, allow
unlocking immediately and allow blacklisting an IP manually. A manual blacklist entry is persisted in
the database, survives a restart and stays until it expires or is removed.

### IP allowlist and blocklist

- **Allowlist**: source IPs on this list are **exempt from failure lockout** (the backend skips the
  counter). Two intranet addresses are preconfigured (`10.100.117.5`, `10.100.240.93`) — change them
  to your own operations subnet during deployment.
- **Blocklist**: rejected outright, logged as `ip_denied`.
- Both accept single IPs, CIDR blocks and ranges, and work with IPv6.

### Login sources and account matching

| Setting | Default | Notes |
| --- | --- | --- |
| Only existing users may log in | Off | When a third-party (OIDC) login returns a username that matches no local account, it is rejected instead of provisioned (`not_provisioned`) |
| Only logins from given sources | Off | Enabling it requires filling the allowlist — an **empty list cannot be saved**. Sources outside the list are rejected (`source_denied`; behind a reverse proxy the decision uses the real client IP derived from `TRUSTED_PROXIES`) |
| Single-device login | Off | A new login from another device signs the other sessions out |

Multi-replica caveat: single-device login depends on shared session state across replicas, so the
decision may lag when replicas disagree.

## Password security

### Password rules

| Setting | Default | Notes |
| --- | --- | --- |
| Minimum length | 8 | Applies to user password changes and administrator resets |
| Administrator minimum length | 8 | Separate lower bound for administrator accounts |
| Required character classes | 3 | 0–4; `0` means “all four switches below are required” |
| Uppercase / lowercase / digits / special | all on | Used together with the setting above |

The maximum password length is fixed at **30** and is not configurable. The page can also store a
“common weak passwords” dictionary (deduplicated, sorted); matching passwords are rejected.

### Expiry and history

| Setting | Default | Notes |
| --- | --- | --- |
| Password expiry | 900 days | Daily reminders before expiry; after expiry a change is required to continue |
| Forbidden password reuse | 5 | A new password may not match any of the most recent old ones |

After a successful change, all previously issued tokens for the account **become invalid
immediately** and a new login is required. When an administrator resets a password, the account
holder is notified (a mandatory event), see
[Notifications & Announcements](../guide/notification-and-announcements).

Every password change is recorded in the Password Change Log, see
[Audit & Compliance](../guide/audit-and-compliance).

## Session security

| Setting | Default | Notes |
| --- | --- | --- |
| Expire when the browser closes | On | The session cookie is not persistent; closing the browser signs you out |
| Maximum idle time | 600 minutes | No activity for that long signs you out |
| Maximum session lifetime | 24 hours | Re-login required when reached, active or not |

Related behaviour:

- The access token lifetime is fixed at 24 hours, aligned with the maximum session lifetime; the
  session cookie lives twice as long to support token rotation.
- Being replaced by another login produces an in-app notification, and the page tells you the account
  signed in elsewhere.
- Three or more replacements within 24 hours trigger an email to the account holder (possible
  credential leak); multi-device logins beyond the single-device setting can also trigger it.

## Auth providers

The “Auth Providers” tab manages the sources:

- **Local accounts**: username and password, the default.
- **LDAP**: connection parameters, sync mode (immediate plus periodic, 10 minutes by default) and
  user import. Directory users are provisioned on their first login, or rejected when “Only existing
  users may log in” is enabled.
- **OAuth / OIDC**: add, edit, enable and delete multiple providers (configured per client). Binding
  rules: an existing account is matched by the provider's `sub` first; when the `sub` is new but the
  username already exists, the first login binds them; conflicting bindings across providers are
  rejected and must be resolved by an administrator.

The full OAuth walkthrough is in [OAuth Setup](./oauth-setup); delegating cluster authentication is
covered in [Managed K8s Auth](./managed-k8s-auth).

## Separation of duties and permissions

The built-in roles map to four responsibilities:

| Role | Responsibility |
| --- | --- |
| System administrator | Clusters and resources, day-to-day operations |
| Security administrator | Users, roles, security policy and auth providers |
| Audit administrator | Read-only access to audit and access logs, no configuration changes |
| Read-only administrator | Read-only across the whole platform |

Rules and how they are enforced:

- **Mutual exclusion**: the system, security and audit administrator roles may not be combined on one
  account. When they are, that account is **rejected as a whole** on the admin surface (not just for
  individual endpoints) until an administrator resolves the conflict.
- Creating accounts and changing roles runs a pre-check that rejects conflicting combinations; a
  “Role conflicts” list helps find existing conflicts.
- **Settings are granted per section**: `settings.*` permissions are granted section by section, and
  a broad `settings.*` wildcard does **not** cover the settings family — every section must be
  checked explicitly. Sections without a grant are hidden in the UI and rejected by the API.
- **Permission bindings** bundle cluster + namespace scoped permissions for a group of users, which
  suits delegated operations across many clusters.

The full configuration walkthrough (roles, permission bindings, section grants) is in
[RBAC Configuration](./rbac-config).

## API keys

API keys are for calling the platform API from automation (issuing deployments from CI, for example):

- Created and revoked in the personal settings; the full key is shown exactly once, at creation.
- A key **inherits the roles and permissions of its creator** and has no separate scope field — to
  narrow it down, give a dedicated account a minimal role and create the key with that account.
- Keys are sensitive values and are encrypted with `AEROLINK_ENCRYPT_KEY` like other sensitive
  configuration, see [Environment Variables](./env).
- Calls made with a key are recorded in the login log (method: API key).

## Related environment variables

| Variable | Notes |
| --- | --- |
| `AEROLINK_ENCRYPT_KEY` | **Required.** Encrypts sensitive values (API keys, SMTP password, OAuth/LDAP credentials, …). Rotating or losing it makes existing values undecryptable |
| `JWT_SECRET` | Signing key for access tokens; must be stable and identical across replicas |
| `TRUSTED_PROXIES` | IP / CIDR list of reverse proxies; determines the real client IP, which drives the IP blocklist, source restrictions and recorded audit IPs |
| `ANONYMOUS_USER_ENABLED` | Anonymous access for demo environments only; do not enable in production |

See [Environment Variables](./env) and [Chart Values](./chart-values) for the full list. Egress HTTPS
and CSP headers are controlled at deployment time, see
[Build and Push Image](../guide/build-and-push-image).