# Environment Variables

AeroLink supports several environment variables by default to change the default values of some configuration items.

Note: the older `KITE_*` names are **no longer read** (the switch to `AEROLINK_*` was a hard cut with
no fallback). Existing deployments must rename every variable in their manifests, Secrets and env files,
otherwise the setting counts as unset.

- **AEROLINK_CONFIG_FILE**: Path to the configuration file. Available in AeroLink `v0.10.0` and later. When set, AeroLink loads cluster, OAuth, LDAP, RBAC, and super user settings from this file. See [Configuration File](/en/config/config-file) for details.
- **AEROLINK_USERNAME**: Legacy environment variable for the initial administrator username. It is only used for env-to-DB migration when `AEROLINK_CONFIG_FILE` is not set.
- **AEROLINK_PASSWORD**: Legacy environment variable for the initial administrator password. It is only used for env-to-DB migration when `AEROLINK_CONFIG_FILE` is not set.
- **KUBECONFIG**: Legacy kubeconfig environment variable used to import clusters when `AEROLINK_CONFIG_FILE` is not set.
- **ANONYMOUS_USER_ENABLED**: Enable anonymous user access, default value is `false`. When enabled, all access will no longer require authentication and will have the highest permissions by default.

- **JWT_SECRET**: Secret key used for signing and verifying JWT. If unset, a random secret is generated on first boot and stored in the database. Must be at least 32 bytes when set.
- **AEROLINK_ENCRYPT_KEY**: Secret key used for encrypting sensitive data, such as user passwords, OAuth clientSecret, kubeconfig, etc. **Required**: the server refuses to start without it unless `AEROLINK_ALLOW_INSECURE_SECRETS=true`. Rotating it makes existing stored credentials unreadable — re-save every credential after rotation.
- **AEROLINK_REQUIRE_ENCRYPT_KEY**: When `true`, `AEROLINK_ENCRYPT_KEY` must be set even if `AEROLINK_ALLOW_INSECURE_SECRETS=true`.
- **AEROLINK_ALLOW_INSECURE_SECRETS**: Development-only escape hatch (`true`/`false`). Allows the built-in keys and short JWT secrets. Never enable in production.

## Credential transport encryption

Passwords, one-time codes, password change / reset values, kubeconfigs and Secret payloads are encrypted
**in the browser** with the server's public key before they leave the client, and decrypted server-side.
The point is to keep plaintext credentials out of access logs, packet captures and proxy logs. It is
**not a replacement for HTTPS**: a man in the middle can still replay a valid ciphertext or tamper with
responses.

- **AEROLINK_TRANSPORT_KEY_PATH**: Path to the transport key (RSA private key, PEM). Defaults to
  `data/transport-key.pem` relative to the working directory (`/home/aerolink/data/transport-key.pem`
  in the official image) and is generated automatically (`0600`) when missing. **All replicas must read
  the same key** (shared volume, or the variable below injected from a Secret); otherwise requests landing
  on another replica fail with a sporadic `400 credential_decrypt_failed`.
- **AEROLINK_TRANSPORT_PRIVATE_KEY**: Inline PEM text of the same key, convenient for mounting from a
  Secret. Takes precedence over `AEROLINK_TRANSPORT_KEY_PATH`.
- **AEROLINK_REQUIRE_ENCRYPTED_CREDENTIALS**: When `true`, only encrypted credentials are accepted: a
  plaintext submission of any of the fields above returns `400` with `code` set to
  `encrypted_credential_required`. Defaults to `false` (both forms accepted) for compatibility with older
  pages and hand-written scripts.

Before enabling it, make sure no browser still has a previous page version open (the frontend is embedded
in the binary but a tab may be old) and that in-house scripts submit ciphertext. Turning it on during a
rolling upgrade makes old pages fail to log in. If `encrypted_credential_required` still shows up after
enabling, check first whether the client can reach `/api/v1/transport-key` (identical keys across
replicas, reverse proxy not blocking it) instead of switching the flag off.

- **HOST**: Used for generating OAuth 2.0 authorization callback addresses, default will be obtained from request headers. If you find the result not as expected, you can manually configure this environment variable.

- **TRUSTED_PROXIES**: Comma-separated list of reverse proxy, ingress, or load balancer IPs/CIDRs that AeroLink should trust when reading `X-Forwarded-For` / `X-Real-IP` to determine the client IP. By default, AeroLink trusts local/private network ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`) so common ingress deployments can report real client IPs. Set a narrower value such as `TRUSTED_PROXIES=10.42.0.0/16,192.168.1.10` for production, or `TRUSTED_PROXIES=none` to ignore all client-supplied forwarding headers.

- **KUBECTL_TERMINAL_IMAGE**: Docker image used for the kubectl terminal.

- **NODE_TERMINAL_IMAGE**: Docker image used for generating Node Terminal Agent. The agent pod is pinned to the target node, so **on arm64 nodes the same tag suffixed with `-arm64` is used automatically** (e.g. `busybox:latest` → `busybox:latest-arm64`). Names without a tag, `@sha256:` digest references and values already ending with `-arm64` are left as they are; amd64 nodes always keep the configured value.

- **CLUSTER_AGENT_IMAGE**: Docker image used when generating the Cluster Agent manifest for Cluster Agent clusters.

- **PORT**: Port on which AeroLink runs, default value is `8080`.

## Database

- **DB_TYPE**: Database type: `sqlite` (default), `mysql` or `postgres`.
- **DB_DSN**: Database DSN. Defaults to `dev.db` for SQLite.
- **AEROLINK_DB_MAX_OPEN_CONNS**: Maximum open database connections (default `100`).
- **AEROLINK_DB_MAX_IDLE_CONNS**: Maximum idle database connections (default `10`).
- **AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES**: Maximum connection lifetime in minutes (default `10`).
- **AEROLINK_DB_MIGRATE**: Set to `off` to skip automatic migration and backfills, leaving schema maintenance to an external process (`checkSchema` still runs). Use it when the application account has no DDL rights.
- **AEROLINK_DB_MIGRATE_STRICT**: Set to `true` to panic on migration errors; development and CI only.

Database creation, pool sizing and schema changes are covered in [Database Preparation](./database).

## Audit & Archive

Where audit records are stored is a **mutually exclusive choice of five**, decided at **startup**;
the settings page is read-only (changing the store requires a restart).

- **AEROLINK_AUDIT_SINK**: Destination for audit records. Accepted values:

  | Value | Description | Prerequisite (the server refuses to start without it) |
  | --- | --- | --- |
  | `database` (default — unset means this) | Database only, identical to not configuring it | — |
  | `parquet` | Local parquet files only, optionally with an S3 remote copy | An archive directory (`AEROLINK_AUDIT_ARCHIVE_DIR` or `auditArchive.localDir` in the config file) |
  | `elasticsearch` | Elasticsearch only | Node URLs first (the “Audit → Audit Settings → Elasticsearch” page, or `auditArchive.elasticsearch.urls`) |
  | `victorialogs` | VictoriaLogs only (**not** VictoriaMetrics — that is a time-series store and cannot hold audit field details) | Node URLs first (`auditArchive.victorialogs.urls`) |
  | `openobserve` | OpenObserve only | Node URLs first (`auditArchive.openobserve.urls`) |

  An invalid value makes the server **fail to start** (it never silently falls back to `database`).
  The same choice can live in the `auditSink` field of the config file (the config file wins), and
  both ways only honour the value present at startup.

  ```bash
  # Database only (default — just leave AEROLINK_AUDIT_SINK unset)

  # local parquet files (requires an archive directory)
  AEROLINK_AUDIT_SINK=parquet
  AEROLINK_AUDIT_ARCHIVE_DIR=/home/aerolink/data/archive   # default in the official image

  # Elasticsearch (fill in the node URLs on the page or in the config file first)
  AEROLINK_AUDIT_SINK=elasticsearch

  # VictoriaLogs (log store of the VictoriaMetrics family, default port 9428)
  AEROLINK_AUDIT_SINK=victorialogs

  # OpenObserve (default port 5080)
  AEROLINK_AUDIT_SINK=openobserve
  ```

  Addresses and credentials (OpenObserve username/password, S3 access key/secret key, …) belong on
  the “Audit → Audit Settings → Archive” page or in the `auditArchive` section of the config file (see
  `config.dev.yaml` at the repository root for a sample). Every replica of a multi-replica
  deployment must set the same `AEROLINK_AUDIT_SINK`, otherwise records scatter across stores.

  Note: with the `victorialogs` / `openobserve` sinks, expiry is the **server's** job (VictoriaLogs
  `-retentionPeriod`, the OpenObserve stream `data_retention`); the retention days configured in
  “Audit → Audit Settings” do not apply to them.

- **AEROLINK_AUDIT_ARCHIVE_DIR**: Local archive directory for audit/access logs (the startup
  fallback when `AEROLINK_AUDIT_SINK=parquet` and no `localDir` is configured on the page). In a
  multi-replica deployment (`replicaCount > 1`) it must point at **shared storage** (RWX PVC / NFS,
  …): each replica writes only the records it produced while queries read the local directory, so
  without sharing the results are incomplete.
- **AEROLINK_DUCKDB_EXTENSION_DIR**: Directory where DuckDB (parquet queries) installs extensions.
  Empty means a process-writable temp directory (`aerolink-duckdb-extensions` under the system temp
  dir): DuckDB installs into `~/.duckdb` by default, and `INSTALL httpfs` fails outright when `HOME`
  is not writable, which breaks archive queries against S3 (records older than the local retention
  window) — local parquet queries are unaffected. The official image runs as the `aerolink` user in
  its home directory (`/home/aerolink`, the working directory), so `HOME` is writable. For offline
  deployments, pre-install the `httpfs` extension in the image and point this variable at it.
- **AEROLINK_LOG_FILE**: Path where klog (system log) records are written. When set, the system log
  goes to the file only and no longer to stderr, which makes collection easier; it is equivalent to
  the command line `-log_file <path> -logtostderr=false` (the command line wins). The official image
  defaults to `/home/aerolink/data/aerolink.log` (under the run user's home directory); empty means
  stderr, so `kubectl logs` shows the system log directly. The directory is created when missing; if
  it is not writable the server only warns and falls back to stderr instead of refusing to start.

## Runtime & Operations

- **AEROLINK_BASE**: Base path when AeroLink is served behind a sub-path (e.g. `/aerolink`).
- **CORS_ALLOWED_ORIGINS**: Comma-separated list of origins allowed for CORS. Development only.
- **DISABLE_GZIP**: Set to `true` to disable gzip response compression (default: disabled).
- **NAMESPACE**: Kubernetes namespace where terminal/kubectl agent pods are created (default `kube-system`).
- **AEROLINK_METRICS_TOKEN**: Bearer token required to access `/metrics`. Unset leaves the endpoint unauthenticated.
- **AEROLINK_ENABLE_PPROF**: Set to `true` to expose pprof on `localhost:6060` (may leak secrets via heap dumps; opt-in only).
- **AEROLINK_DISABLE_CSP**: Set to `true` to disable the Content-Security-Policy header (development only).
- **AEROLINK_ALLOW_PRIVATE_REGISTRIES**: Set to `true` to allow the image tag lookup to reach private/loopback registry addresses.
- **AEROLINK_POD_METRICS_INTERVAL**: Refresh interval, in seconds, of the usage numbers (CPU /
  memory) pushed to the Pod list page; default `15`. The live (SSE) connection only emits an
  `event: metrics` message when usage **changes**, so raising this value makes the numbers refresh
  later without reducing the cost of the connection itself. A non-positive or invalid value falls
  back to the default.
- **AEROLINK_MAX_WATCH_PER_USER**: Number of concurrent resource watch (SSE) connections a single
  user may hold per cluster; default `8`. Extra connections receive `429` (with
  `"code": "watch_limit_exceeded"` in the body), and the UI then falls back to polling and
  periodically tries to reclaim the live connection. Every browser tab or open detail page holds one
  connection, so a limit that is too low keeps users stuck in polling mode; `0` or a negative value
  means unlimited (troubleshooting only). The counter is **per replica**, so in a multi-replica
  deployment one person can reach roughly “limit × replicas” connections — the limit is only
  accurate at that granularity.
