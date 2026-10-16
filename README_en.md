<div align="center">

<img src="./docs/assets/logo.svg" alt="AeroLink Logo" width="128" height="128">

# AeroLink (internal fork)

**All your clusters. One workspace.**

AeroLink is a lightweight, open-source Kubernetes workspace for multi-cluster operations, observability, access control, and AI-assisted troubleshooting.
This repository is the **company-internal fork** of the upstream project, currently at `v1.0.2`.

**English** · [中文](./README.md)

</div>

## About this repository

This repository is a customized fork of [kite-org/kite](https://github.com/kite-org/kite), maintained on the internal Gitea and for internal use only.

- Upstream project: <https://github.com/kite-org/kite> (docs: <https://kite.zzde.me>)
- Internal repository: `ssh://git@10.10.11.151:20222/teg/support-department/operation_rd_dept/aerolink.git` (web: <http://10.10.11.151:20216/teg/support-department/operation_rd_dept/aerolink>, branch `release/v1.0.0`)
- English docs: see [`docs/en/`](./docs/en/index.md)
- Chinese docs: see [`docs/`](./docs/index.md) and [`README.md`](./README.md)
- License: Apache-2.0 (inherited from upstream)

## Enhancements in this fork

- **Fine-grained RBAC**: new `view-file` / `download-file` / `upload-file` verbs for container files, assignable per role (decoupled from `exec`; existing roles keep working).
- **Container file auditing**: every preview / download / upload is recorded in the audit log (file path, container, operator, result).
- **Notification module**: SMTP mail, message templates, subscriptions and an in-app inbox; inactive-user disable reminders, remote-login alerts, password expiry reminders.
- **Login captcha** and a reorganized settings area (fully localized).
- **Build & release**: `make build` always rebuilds frontend and backend; `make image / make push` build and publish the Docker image to the company SWR.

## Build

```bash
make deps      # install frontend & backend dependencies
make build     # build the frontend (embedded into static/) and the ./aerolink binary
make run       # start the server (loads dev.env automatically, port 8080)
```

> Running `./aerolink` right after `make build` **refuses to start without secrets** — that is the intended startup check. For local debugging either:
> - `make run` / `make dev`, which load the bundled `dev.env` (already contains 32+ byte `AEROLINK_ENCRYPT_KEY` and `JWT_SECRET`) — recommended;
> - or set `AEROLINK_ALLOW_INSECURE_SECRETS=true` to fall back to the built-in keys (**local machines only**).

## Local development

The repository ships two ready-to-use defaults, so no manual environment setup is needed:

| File | Purpose |
| --- | --- |
| `dev.env` | Local variables: `PORT` / `DB_DSN` / `AEROLINK_ENCRYPT_KEY` / `JWT_SECRET` (32+ byte development values that satisfy the startup checks) / `AEROLINK_CONFIG_FILE` |
| `config.dev.yaml` | Config file: creates the administrator **admin / AdminPass!234** on first start and imports `~/.kube/config` when no cluster exists |

```bash
make dev    # backend (-v=5) + Vite dev server; loads dev.env automatically
make run    # backend only (embedded frontend assets); loads dev.env automatically
```

Under `make dev` the backend is supervised by `scripts/dev-backend.sh`, which watches `*.go`
**and `static/`** and rebuilds/restarts on any change. So after `make frontend` (or while
using Vite HMR on `:5173`), `:8080` restarts onto the new assets by itself — just refresh
the browser, no manual stop/start.

Both targets `source` `dev.env` when present. To customise, copy it and override a few variables:

```bash
cp dev.env dev.env.local
make dev DEV_ENV=dev.env.local
```

Without make:

```bash
set -a; . ./dev.env; set +a; ./aerolink
```

> ⚠️ The keys in `dev.env` are public development values — any real deployment needs `openssl rand -base64 32`.
> Frontend-only debugging: `cd ui && pnpm dev` (the proxy points at the backend `PORT`).

## Docker deployment

### 1. Build the image

```bash
make image     # build the image (default tag: see the IMAGE variable in the Makefile)
make push      # build and push to the company SWR registry
```

Behind a restricted network the mirror build args are preconfigured; on a direct connection use `make image DOCKER_BUILD_ARGS=`.

### 2. Run the container

> ⚠️ **Before upgrading or restarting**
> 1. **`AEROLINK_ENCRYPT_KEY` must be set** — otherwise the server **refuses to start** (data encrypted with the built-in key is effectively plaintext, so this is a deliberate hard failure).
>    - Automatic migration **only applies to a database that has been using the built-in default key**: upgrading from such an older build, add `AEROLINK_ENCRYPT_KEY="$(openssl rand -base64 32)"` and restart (the log shows `re-encrypted N stored secret(s)`). **If the database already uses another custom key you cannot switch directly** — startup is refused; see section 6 for the rotation steps.
>    - Local development only: `AEROLINK_ALLOW_INSECURE_SECRETS=true` falls back to the built-in key with a warning. **Never use it in production.** It does **not** rescue a database already encrypted with another key — startup is still refused.
> 2. **If `JWT_SECRET` is set explicitly it must be at least 32 bytes**, otherwise startup fails as well (when it is unset a random secret is generated and stored).
> 3. Both checks log their outcome — review the first startup log.

The workdir inside the container is `/app` and SQLite defaults to `dev.db` (`/app/dev.db`) — **mount a volume, otherwise all data is lost when the container is recreated**.

Local smoke test (**not for production** — security parameters omitted):

```bash
docker run -d --name aerolink -p 8080:8080 \
  -v aerolink-data:/app/data \
  -e DB_DSN=/app/data/aerolink.db \
  -e AEROLINK_ENCRYPT_KEY=dev-only-key \
  -e JWT_SECRET=dev-only-jwt-secret-0123456789abcdef \
  swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:v1.0.2
```

Production (generate secrets with `openssl rand -base64 32` and store them safely):

```bash
docker run -d --name aerolink --restart unless-stopped \
  -p 8080:8080 \
  -v /data/aerolink:/app/data \
  -e DB_DSN=/app/data/aerolink.db \
  -e AEROLINK_ENCRYPT_KEY="$(openssl rand -base64 32)" \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e HOST=https://aerolink.example.com \
  -e TRUSTED_PROXIES=10.0.0.0/8 \
  swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:v1.0.2
```

The first visit walks through creating the admin account; configure the remaining policies under Settings.

### 3. Environment variables

**Security related — set these as documented:**

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AEROLINK_ENCRYPT_KEY` | **yes in production** | hardcoded default | Encrypts every stored secret (SMTP/LDAP/OAuth passwords, cluster kubeconfigs, VM keys, AI keys). With the default value **anyone holding the database can decrypt all credentials**. Switching away from the built-in default re-encrypts the stored data automatically (see "Encryption key rotation"); later rotations require re-saving every credential first |
| `AEROLINK_ALLOW_INSECURE_SECRETS` | no | `false` | **Local development only**: allows the built-in keys; without it a missing `AEROLINK_ENCRYPT_KEY` (or a `JWT_SECRET` shorter than 32 bytes) makes the server **refuse to start**. Never set it in production |
| `JWT_SECRET` | **yes in production** | random per start | Session token signing key, ≥32 random bytes. Without it an ephemeral key is generated and **everyone is signed out on restart**; a value shorter than 32 bytes logs a warning |
| `TRUSTED_PROXIES` | per deployment | private ranges | Only these direct peer IPs may supply `X-Forwarded-For` / `X-Real-IP`. Affects login lockout, IP allow/deny lists, remote-login notices and audit logs. **Set `none` when the container is exposed directly**, otherwise clients can spoof their IP and bypass IP-based throttling; behind Nginx/SLB list the proxy CIDRs |
| `HOST` | yes when using HTTPS | empty | Public base URL (e.g. `https://aerolink.example.com`). Decides whether the session cookie gets the `Secure` flag — **without it an HTTPS deployment may send the cookie in clear text** |
| `ANONYMOUS_USER_ENABLED` | no | `false` | `true` allows unauthenticated (read-only) access and logs a warning. **Never enable in production** |
| `CORS_ALLOWED_ORIGINS` | no | empty (no CORS) | Comma separated allowed origins. Keep empty in production; only needed for the local Vite dev server, and logs a warning when set |

**Common runtime options:**

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | listen port (already `EXPOSE`d) |
| `DB_TYPE` | `sqlite` | `sqlite` / `mysql` / `postgres`; anything else aborts startup |
| `DB_DSN` | `dev.db` | connection string — see “Database options” below for MySQL/PostgreSQL examples |
| `AEROLINK_DB_MAX_OPEN_CONNS` | `100` | max open connections (raise for busy MySQL/PostgreSQL instances; invalid values are ignored with a warning) |
| `AEROLINK_DB_MAX_IDLE_CONNS` | `10` | idle connections; `0` keeps none |
| `AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES` | `10` | connection max lifetime in minutes |
| `AEROLINK_BASE` | empty | sub-path deployment (e.g. `/aerolink`) |
| `NAMESPACE` | empty | namespace for AeroLink's own agent/terminal pods |
| `DISABLE_GZIP` | `false` | `true` disables response compression (proxy troubleshooting) |
| `KUBECONFIG` / `AEROLINK_CONFIG_FILE` | empty | external kubeconfig / config file path |
| `NODE_TERMINAL_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/busybox:latest` | node terminal image (company SWR) |
| `KUBECTL_TERMINAL_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/kubectl:latest` | kubectl terminal image (company SWR) |
| `CLUSTER_AGENT_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:latest` | cluster agent image, same repository as the app (company SWR) |
| `AEROLINK_KUBE_API_QPS` / `AEROLINK_KUBE_API_BURST` | built-in | Kubernetes API rate limits |
| `AEROLINK_CACHE_SYNC_TIMEOUT` | built-in | cluster cache sync timeout |
| `DISABLE_CACHE` | no | `true` disables the resource cache (debugging) |

### 4. Database options

SQLite (the default) is fine for a single instance; **multi-replica deployments must use MySQL or PostgreSQL**, otherwise every replica writes its own database. Switching only requires `DB_TYPE` + `DB_DSN`; tables are created/migrated automatically on startup.

```bash
# SQLite (default)
-e DB_TYPE=sqlite -e DB_DSN=/app/data/aerolink.db

# MySQL / MariaDB (charset=utf8mb4 is required for non-ASCII text)
-e DB_TYPE=mysql \
-e DB_DSN="aerolink:password@tcp(10.0.0.5:3306)/aerolink?charset=utf8mb4&parseTime=true&loc=Local"
# a mysql:// URL is also accepted; charset / parseTime / loc / timeout are
# defaulted by the app when absent (charset=utf8mb4, parseTime=true, loc=Local,
# timeout=5s) and anything set in the DSN wins

# PostgreSQL
-e DB_TYPE=postgres \
-e DB_DSN="host=10.0.0.5 user=aerolink password=password dbname=aerolink port=5432 sslmode=disable"
# or: postgres://aerolink:password@10.0.0.5:5432/aerolink?sslmode=disable
```

Pool size is configurable via `AEROLINK_DB_MAX_OPEN_CONNS` / `AEROLINK_DB_MAX_IDLE_CONNS` / `AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES` (see the table above).

> Note: the session idle/lifetime limits (security settings) live in **process memory** and reset on restart; with multiple replicas each replica counts its own state — use MySQL/PostgreSQL and keep JWT/cookie lifetimes tight. Single-device login relies on the same in-memory state and therefore applies across replicas only for sign-ins handled by that replica.

### 5. Reverse proxy and TLS

1. Always expose over **HTTPS** and forward `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`;
2. Set both `HOST=https://your.domain` (so the cookie is `Secure`) and `TRUSTED_PROXIES=<proxy CIDRs>`;
3. When exposed directly without a proxy, set `TRUSTED_PROXIES=none`;
4. WebSocket upgrades must be allowed (terminals, pod exec, log following) on the same origin as the page.

### 6. Encryption key rotation (AEROLINK_ENCRYPT_KEY)

Stored values are ciphertext, so switching the key without care makes cluster kubeconfigs and LDAP/SMTP/OAuth passwords unreadable:

| Scenario | What to do |
|---|---|
| **Upgrading from the built-in default** | Set `AEROLINK_ENCRYPT_KEY=<new key>` and restart: every stored secret is re-encrypted automatically. Look for `re-encrypted N stored secret(s)` in the log |
| **Rotating an existing custom key** | Start with the **old** key → re-save every credential in the UI (clusters, LDAP, OAuth, SMTP, AI) → then switch to the new key |
| **Key configured by mistake** | The log reports `Stored secrets are unchanged and readable with the previously configured key`; nothing is corrupted (rotation is transactional) — restore the previous key |
| **Production guard rail** | Set `AEROLINK_REQUIRE_ENCRYPT_KEY=true` so a missing `AEROLINK_ENCRYPT_KEY` fails the startup |

> The rotation decides from the actual ciphertext (not just a stored fingerprint), so databases created before this mechanism existed are migrated as well.

### 7. Security settings after first login

Container startup is only the beginning — configure these under Settings (no restart required): captcha, global MFA policy (disabled / all users / admins only), third-party MFA, OTP validity; login limits (fail counts, lockout, IP allow/deny lists, single-device login, existing-users-only, login source restriction); password policy (length/complexity/history/expiry); session limits (idle/max/expire-on-close); inactive-account auto-disable; plus SMTP-backed notifications (remote login, password expiry).

## Syncing with upstream

```bash
git remote add upstream https://github.com/kite-org/kite
git fetch upstream
git merge upstream/main
```

## License

[Apache-2.0](./LICENSE)

## Acknowledgement

This repository is a customized fork of [kite-org/kite](https://github.com/kite-org/kite). Third-party assets and their provenance are listed in [`NOTICE`](./NOTICE); licence texts are in [`LICENSE`](./LICENSE) and [`licenses/`](./licenses/). See [`SECURITY.md`](./SECURITY.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the security policy and contribution guide.
