# Deployment and Operations

This page covers everything after installation: choosing a deployment shape, running the bare
process, upgrading and rolling back, what to back up and how to switch databases. For the first
install see [Getting Started](./installation); for database creation and sizing see
[Database Preparation](../config/database).

## Deployment shapes

Five shapes ship in the repository. Pick one and stay with it — do not mix them:

| Shape | Artifacts | When it fits |
| --- | --- | --- |
| Helm chart | `charts/aerolink` | Standard Kubernetes deployments that need persistence and templated configuration |
| Plain Kubernetes manifests | `deploy/install.yaml` (SQLite), `deploy/install-mysql.yaml`, `deploy/install-postgres.yaml` | Clusters without Helm; `kubectl apply` and go |
| Docker Compose (production) | `deploy/docker-compose.yaml` | Single-host container deployment |
| Docker Compose (local) | `deploy/docker-compose.local.yaml` + `deploy/config.yaml` | Trying it out locally, with bundled Postgres / rustfs |
| Bare process + systemd | `deploy/aerolink@.service` + `deploy/aerolink.env.example` + `deploy/nginx-aerolink.conf` | **The production shape here**: the binary runs directly on the host, replicas come from a template unit |

What the three manifests share: a ClusterRoleBinding to `cluster-admin` (the console manages whole
clusters, intranet use), both `livenessProbe` and `readinessProbe` hitting `/healthz`, requests
`100m/128Mi`, limits `1000m/512Mi`, and an image pointing at the internal SWR registry. They differ
in namespace and database:

| Manifest | Namespace | Database |
| --- | --- | --- |
| `install.yaml` | `kube-system` | SQLite (no `DB_TYPE` / `DB_DSN`, defaults apply) |
| `install-mysql.yaml` | `aerolink` | Explicit `DB_TYPE` / `DB_DSN`, plus a rolling update strategy |
| `install-postgres.yaml` | `aerolink` | Same, targeting PostgreSQL |

All three leave the volume **commented out**: `emptyDir` only survives the Pod, so audit archives and
logs need a PVC to outlive a rebuild. The image is distroless (uid `65532`) with no `curl`/`wget`
inside, which is why the compose file has no healthcheck — if you want one, rebuild with the
`RUNTIME_IMAGE` build arg pointing at a base image that has tools.

## Bare process (systemd)

Production runs the binary directly on the host, with replicas from a systemd template unit where
**the instance number is the port**:

```bash
sudo install -m 600 deploy/aerolink.env.example /etc/aerolink/aerolink.env
sudo vi /etc/aerolink/aerolink.env                  # replace every REPLACE-ME
sudo cp deploy/aerolink@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aerolink@8081           # one instance per replica: 8081, 8082, …
```

Configuration lives in `/etc/aerolink/aerolink.env` (mode 600), shared by every replica; only `PORT`
comes from the instance number. The example file already carries the PostgreSQL `DB_TYPE` / `DB_DSN`,
pool size, both secrets and `TRUSTED_PROXIES`. Four values you must set yourself:

| Item | Why it matters |
| --- | --- |
| `TimeZone` in `DB_DSN` | Omitting it does not error; UI and audit timestamps simply shift |
| `AEROLINK_DB_MAX_OPEN_CONNS` | The limit is **per replica** — check `max_connections` against the [capacity formula](../config/database#connection-pool-and-capacity) |
| `AEROLINK_ENCRYPT_KEY` / `JWT_SECRET` | Must match the existing database and be identical on every replica |
| `TRUSTED_PROXIES` | nginx runs on the host and must be covered; without it the server trusts every `X-Forwarded-For` and **audit source IPs can be forged** |

Two details that are easy to miss: the unit is already `After=docker.service` (for a containerised
database), and if the database is unreachable the process exits — `Restart=always` catches it. So
when “the service won't start”, read the DSN in the env file before suspecting the unit. A reverse
proxy example ships as `deploy/nginx-aerolink.conf`.

## Runtime parameters and probes

| Item | Value |
| --- | --- |
| Listen address | `:PORT`, default `8080`. Note that `HOST` does **not** affect listening — it only builds OAuth callback URLs |
| HTTP timeouts | 10 s to read headers, 120 s idle; after SIGTERM up to 5 s for in-flight requests |
| Upload limit | 512 MiB (Pod file uploads are capped by `MaxBytesReader`) |
| Health check | `GET /healthz` → `200 {"status":"ok"}`, excluded from the access log and metrics |
| Version | `GET /api/v1/version` |
| Metrics | `GET /metrics`; with `AEROLINK_METRICS_TOKEN` set a Bearer token is required, otherwise the endpoint is **unauthenticated** and logs a warning |
| Profiling | `AEROLINK_ENABLE_PPROF=true` exposes pprof on `localhost:6060` (heap dumps may contain secrets; off by default) |

There is no `/readyz` or `/livez` — point both probes at `/healthz`.

Logs come in two places: once `AEROLINK_LOG_FILE` is set, the system log (klog) goes to the file
only and **stderr keeps ERROR and above**. Do not troubleshoot from `journalctl` alone; business logs
are in the file. Audit and access logs are a separate pipeline, see
[Audit & Compliance](./audit-and-compliance).

## Startup order and failure behaviour

Knowing which failures are fatal saves a lot of time:

| Stage | Behaviour on failure |
| --- | --- |
| Reading secrets: `AEROLINK_ENCRYPT_KEY` missing, or `JWT_SECRET` shorter than 32 bytes | **Refuses to start** (unless `AEROLINK_ALLOW_INSECURE_SECRETS=true` for development) |
| Connecting to the database and running migrations | Connection failure panics |
| Checking whether the JWT secret is still the built-in default | **Refuses to start** |
| Applying the configuration file (`AEROLINK_CONFIG_FILE`) | Unreadable file → **refuses to start**; a failing section only logs an error and continues |
| Validating the audit sink and archive directory | Invalid value or missing prerequisite → **refuses to start** (fail-closed, no silent fallback) |
| Creating the superuser, importing clusters, notification templates, RBAC sync, config watcher | Failures only log warnings; startup continues |
| Binding the port | An occupied port exits the process |

**The `clusters` section of the configuration file overwrites the cluster list in the database**
(everything is deleted and re-inserted), so do not leave a one-off bootstrap file behind as the
long-term `AEROLINK_CONFIG_FILE`. Also note that once `AEROLINK_CONFIG_FILE` is set the program
**stops reading the environment-variable path**: automatic `KUBECONFIG` import and creating the
superuser from `AEROLINK_USERNAME`/`AEROLINK_PASSWORD` no longer work, and the superuser must go into
the `superUser` section. All three semantics are in [Configuration File](../config/config-file).

## Multiple replicas

Running several replicas is more than starting several processes — four hard constraints:

- **They must share one database.** SQLite is a single file with a single writer, so replicas require
  MySQL or PostgreSQL. Sessions, login failure counters and the leader lease (which keeps periodic
  global jobs on a single replica) all live in the database.
- **`AEROLINK_AUDIT_SINK` must be identical in every configuration file.** It is decided at startup
  and never changes at runtime; changing only the database value is ignored with a warning.
- **Do not assume session affinity at the ingress.** Session state can lag by about 60 seconds, so
  session takeover and single-device login decisions carry that much delay.
- **Setting changes propagate to all replicas within 30 seconds.** Security policy and audit settings
  are refreshed on the replica that saved them immediately; other replicas reload on a timer. Keep
  that in mind when verifying a policy change right after saving it.

`AEROLINK_ENCRYPT_KEY` and `JWT_SECRET` must be identical across replicas: a mismatched encryption
key makes credentials decrypt differently per replica, and a mismatched JWT secret makes requests
bounce between replicas as “not signed in”.

## Upgrading

Binaries and images are replaced wholesale; schema changes are a separate step. Full sequence:

1. **Back up**: database dump + both secrets + archive directory (next section). Do not skip this —
   schema changes have no automatic undo.
2. **Read the upgrade SQL in the release notes.** When `pkg/model/` changed, the release notes carry a
   dedicated section with the SQL to run beforehand (equivalent syntax for all three databases).
   **Run the SQL first, then replace the binary.**
3. **Replace the artifact**: swap the binary on bare metal, or change the image tag in Kubernetes
   (`helm upgrade`, or edit the `Deployment` image when using plain manifests).
4. **Restart**: `systemctl restart aerolink@8081 ...` on bare metal. In Kubernetes you must
   **restart explicitly** — `envFrom` only re-reads the Secret when a Pod is rebuilt:

   ```bash
   kubectl -n aerolink edit secret aerolink-secret      # only if you changed secrets/DSN
   kubectl -n aerolink rollout restart deploy/aerolink
   kubectl -n aerolink rollout status deploy/aerolink
   ```

5. **Verify**: look for the `checkSchema` verdict in the log (`库结构与模型一致` means the schema is
   complete; any listed difference means a SQL step was missed), confirm the version via
   `GET /api/v1/version`, then spot-check a login and pulling resources from one cluster.

Upgrading PostgreSQL itself across major versions (12 → 14/16/18 …) is a different exercise, see
[Database Preparation](../config/database#upgrading-postgresql-major-versions).

## Rollback

Rollback has two layers, and whether it works depends on whether the schema change is reversible:

| Scenario | Action |
| --- | --- |
| Only the binary / image changed | Put the previous tag or binary back and restart |
| The database was switched (DSN points at the new one) | **Point `DB_DSN` back at the old database** and run the old binary. This is why the old database must not be deleted before verification passes |
| Helm deployment | `helm rollback <release> <revision>` |
| systemd replicas | Stop the new instances (`systemctl disable --now aerolink@8082`) and keep one old-version instance |
| After a schema change | No automatic undo: upgrade SQL is not bidirectional. Reverting means restoring the pre-upgrade dump, and **everything written after the switch is lost** |

Keep the switch window short: anything colleagues write to the new database between cutover and
verification disappears on rollback. The checklist is under [switching databases](#switching-databases).

## Backup and restore

### What to back up

| Item | Location / notes |
| --- | --- |
| Database | `pg_dump` for PostgreSQL, `.backup` for SQLite, `mysqldump` or XtraBackup for MySQL (per your DBA) |
| `AEROLINK_ENCRYPT_KEY` | Every kubeconfig, LDAP / OAuth / SMTP password, AI key and MFA secret in the database depends on it. **Losing it invalidates all credentials** |
| `JWT_SECRET` | Losing it signs everyone out (recoverable, unlike the encryption key) |
| Archive and log directories | parquet archives under `AEROLINK_AUDIT_ARCHIVE_DIR` plus klog files under `/home/aerolink/data` — audit search needs them |
| Configuration | `/etc/aerolink/aerolink.env` and whatever `AEROLINK_CONFIG_FILE` points at |

The database and the two secrets must be backed up **as one set**: restoring a database while using a
different encryption key leaves every ciphertext unreadable, and backing up the key while restoring
an older database makes the more recent credentials unusable.

### Commands

```bash
# PostgreSQL: logical backup (small, restorable across versions)
pg_dump -h 127.0.0.1 -p 5433 -U aerolink -d aerolink -Fc -f /data/backup/aerolink-$(date +%F-%H%M).dump

# SQLite: online backup (never a half-written file; do not plain-cp a live database)
sqlite3 /home/aerolink/db/aerolink.db ".backup /data/backup/aerolink.db.$(date +%F-%H%M)"
```

Restore with `pg_restore` (for the `-Fc` format) or by swapping the SQLite file back, then start the
service with the matching secrets. The repository ships **no backup script or schedule**, so wire the
commands above into cron or a systemd timer — and actually restore one regularly; an unverified
backup is not a backup.

Schedule it away from operational peaks: `pg_dump` takes a database connection and reads the whole
database, and it fails outright when the pool has no headroom.

## Switching databases

Going from SQLite (or MySQL) to PostgreSQL uses the bundled `tools/dbmigrate`, a one-shot copier in
its own `package main` that is **not part of the release binary**. Overall order:

1. **Back up the source database** and confirm the two secrets (the run must use the same
   `AEROLINK_ENCRYPT_KEY` as the source).
2. **Create the target database and account** (see
   [Database Preparation](../config/database#creating-the-database)) and confirm encoding and
   collation.
3. **Dry run**: reads the source, prints a per-table row count comparison, touches nothing.

   ```bash
   cd /wxh/aerolink
   DB_TYPE=sqlite DB_DSN=dev.db \
     go run ./tools/dbmigrate -dry-run -target-type postgres -target-dsn '<target DSN>'
   ```

4. **Copy for real**:

   ```bash
   set -a; . /root/aerolink-secrets.env; set +a      # carries the source AEROLINK_ENCRYPT_KEY
   DB_TYPE=sqlite DB_DSN=dev.db \
     go run ./tools/dbmigrate -target-type postgres -target-dsn '<target DSN>'
   ```

   Any direction works — `sqlite` / `mysql` / `postgres` in any combination, with `-source-type` /
   `-source-dsn` naming the source explicitly; `-batch-size` defaults to 100. **A wrong key aborts
   with a decryption error before touching the target**, which is deliberate.
5. **Stop the old process, change the DSN, cut over** (`kill -TERM` or `systemctl stop`, edit
   `DB_TYPE` / `DB_DSN` in the env file, start again). Do not let the source keep taking writes during
   the copy: with containers, `docker stop` the source first.
6. **Verify**, see the table below.
7. **Confirm or roll back**: keep the old database (including the old SQLite file) until verification
   passes; rolling back means pointing the DSN at it again.

### Verification checklist

| Check | Expectation |
| --- | --- |
| Row counts | Match the source (the copier prints the comparison) |
| Login | Works, and the login log gains an entry |
| Permissions | Role / permission binding counts match the source |
| Clusters | Every cluster connects and **pulls resources** (this also proves kubeconfig decryption works) |
| MFA | An account with one-time codes enabled can verify a code (proves `mfa_secret` decrypts) |
| Notifications | SMTP and the notification settings page show no decryption errors |
| New records | Create a role or a bookmark and confirm no primary key collision (proves the sequence was fixed) |
| Time | UI and audit timestamps are local time (proves `TimeZone` in the DSN works) |

The startup log should contain no `AutoMigrate` error, no decryption error, and no
`DB_DSN does not set TimeZone` warning.

### Known pitfalls

| Symptom | Cause and fix |
| --- | --- |
| Primary key collisions on new records | PostgreSQL `bigserial` does not advance when IDs are inserted explicitly. `tools/dbmigrate` runs `setval` to `max(id)` per table; a hand-written migration script must do the same. MySQL / SQLite have no such issue, which is why it is easy to miss when coming from MySQL |
| Timestamps shifted | `TimeZone` (PostgreSQL) or `loc` (MySQL) missing from the DSN |
| The same search keyword returns different results | PostgreSQL `LIKE` is case-sensitive, SQLite / MySQL are not |
| `duplicate key ... user_sessions_pkey` in the log | A race in the session UPSERT under concurrent logins; by design, not corruption |
| The source cannot be read (missing columns) | The source must have been **started by the current version** so migrations have run |
| Test data appears in the target | The dry run only counts rows and never writes; confirm the target is empty or disposable before the real copy |

## Troubleshooting

| Symptom | Look here first |
| --- | --- |
| The service will not start | Secrets and DSN in `/etc/aerolink/aerolink.env`; missing keys, a default JWT secret or an invalid audit sink all refuse to start |
| Times are off by 8 hours | `TimeZone` in the DSN, plus `loc` for MySQL |
| Port already in use | `PORT` versus the systemd instance number (the instance number *is* the port) |
| Only ERROR lines in the log | `AEROLINK_LOG_FILE` is active: the full log is in the file, stderr keeps ERROR and above |
| Intermittent connection failures on resource pages | The pool versus `max_connections` capacity rule; idle connections still hold slots |
| Replicas behave differently | Whether `AEROLINK_AUDIT_SINK` and both secrets match across replicas, and whether 30 seconds have passed since the setting change |
| Audit source IPs look like the proxy, or can be forged | `TRUSTED_PROXIES` does not cover the reverse proxy network |
| Users get signed out | Session policy (600 min idle, 24 h maximum, expire on browser close), see [Security Policy](../config/security-policy) |

Building and pushing the image is in [Build and Push Image](./build-and-push-image); the full variable
list in [Environment Variables](../config/env); chart values in [Chart Values](../config/chart-values).