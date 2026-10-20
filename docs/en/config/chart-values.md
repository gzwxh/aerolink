# Chart Values

This document describes all available configuration options for the AeroLink Helm Chart.

## Basic Configuration

| Parameter          | Description                                                | Default                 |
| ------------------ | ---------------------------------------------------------- | ----------------------- |
| `replicaCount`     | Number of replicas                                         | `1`                     |
| `image.repository` | Container image repository                                 | `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink` |
| `image.pullPolicy` | Image pull policy                                          | `IfNotPresent`          |
| `image.tag`        | Image tag. If set, will override the chart's `appVersion`. | `""`                    |
| `imagePullSecrets` | Image pull secrets for private repositories                | `[]`                    |
| `nameOverride`     | Override chart name                                        | `""`                    |
| `fullnameOverride` | Override full name                                         | `""`                    |
| `debug`            | Enable debug mode                                          | `false`                 |
| `basePath`         | Base path where AeroLink is served. See notes below.           | `""`                    |

## Authentication & Security

| Parameter              | Description                                                                              | Default                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `anonymousUserEnabled` | Enable anonymous user access with full admin privileges. Use with caution in production. | `false`                                              |
| `jwtSecret`            | Secret key for signing JWT tokens. Auto-generated on first boot if empty.                | `""`                                                 |
| `encryptKey`           | Secret key used for encrypting sensitive data. Auto-generated with a random value on first install if empty (preserved across upgrades). Set this explicitly only if you manage the key yourself. | `""`                                                 |
| `host`                 | Hostname for the application                                                             | `""`                                                 |

## Database Configuration

| Parameter | Description                                                              | Default  |
| --------- | ------------------------------------------------------------------------ | -------- |
| `db.type` | Database type: `sqlite`, `postgres`, `mysql`                             | `sqlite` |
| `db.dsn`  | Full DSN string for MySQL/Postgres. Required when type is mysql/postgres | `""`     |

### SQLite Configuration

| Parameter                                 | Description                                               | Default             |
| ----------------------------------------- | --------------------------------------------------------- | ------------------- |
| `db.sqlite.persistence.pvc.enabled`       | Whether to create a PVC to store the sqlite database file | `false`             |
| `db.sqlite.persistence.pvc.existingClaim` | Use existing PVC                                          | `""`                |
| `db.sqlite.persistence.pvc.storageClass`  | StorageClass for PVC (optional)                           | `""`                |
| `db.sqlite.persistence.pvc.accessModes`   | Access modes for PVC                                      | `["ReadWriteOnce"]` |
| `db.sqlite.persistence.pvc.size`          | Requested storage size for PVC                            | `1Gi`               |
| `db.sqlite.persistence.hostPath.enabled`  | Whether to use hostPath storage                           | `false`             |
| `db.sqlite.persistence.hostPath.path`     | hostPath path                                             | `/path/to/host/dir` |
| `db.sqlite.persistence.hostPath.type`     | hostPath type                                             | `DirectoryOrCreate` |
| `db.sqlite.persistence.mountPath`         | Mount path inside container                               | `/home/aerolink/db` |
| `db.sqlite.persistence.filename`          | SQLite filename inside mountPath                          | `aerolink.db`       |
| `db.sqlite.options`                       | Extra connection options appended to the SQLite DSN. Only the pure Go driver's `_pragma=...` form works (mattn-style `_journal_mode=...` is silently ignored). | `""`                |

## Environment Variables

| Parameter   | Description                              | Default |
| ----------- | ---------------------------------------- | ------- |
| `extraEnvs` | List of additional environment variables | `[]`    |

## Outbound Requests

AeroLink makes no outbound requests at all: no update check, no telemetry. Instances only talk to the API servers of their own cluster (plus any cluster you add in the UI) and the configured database; `/api/v1/version` returns local build information only.

## Runtime & Operations

These values inject the matching environment variables; the semantics match [Environment Variables](./env).

| Parameter              | Description                                                                                                                                                                                                   | Default                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `logFile`              | Path where klog (system log) records are written. When set, the system log goes to that file only and no longer to stderr, which makes collection easier; empty means stderr (`kubectl logs` shows it directly). The directory is created when missing; if it is not writable the server only warns and falls back to stderr. | `/home/aerolink/data/aerolink.log` |
| `podMetricsInterval`   | Refresh interval (seconds) of the usage numbers (CPU / memory) pushed to the Pod list page. Empty means the default `15`.                                                                                      | `""`                               |
| `maxWatchPerUser`      | Concurrent resource watch (SSE) connections a single user may hold per cluster. Empty means the default `8`; extra connections get `429` and the UI falls back to polling. `0` disables the limit (troubleshooting only). | `""`                               |
| `clusterProbeInterval` | Interval (seconds) of the active API server probe for every cluster. Empty means the default `15`; `0` turns probing off.                                                                                       | `""`                               |
| `clusterStaleAfter`    | Threshold (seconds) after which cluster data is considered possibly stale. Empty means the default `45` (three probe intervals); `0` keeps only the “never connected” and watch-error signals.                  | `""`                               |

## Audit & Archive

Where audit records are stored (`database` by default, or `parquet` / `elasticsearch` / `victorialogs` / `openobserve` — mutually exclusive) is decided at **startup**: set `auditSink` in `config.yaml` or the `AEROLINK_AUDIT_SINK` environment variable; the settings page is read-only. Multi-replica deployments must set the same value on every replica, otherwise records scatter across stores.

| Parameter                                                             | Description                                                                                                                                                                                                                                                                                                                            | Default                       |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `auditArchiveDir`                                                     | Local archive directory (injected as `AEROLINK_AUDIT_ARCHIVE_DIR`). A startup fallback only: the effective value lives in “Audit → Audit Settings → Archive”, and **a local directory saved in the database wins over this value**. With `auditSink: parquet` it is the only destination; with `replicaCount > 1` and the parquet sink it must point at shared storage (RWX PVC / NFS), otherwise each replica writes only its own records and queries come back incomplete. | `/home/aerolink/data/archive` |
| `duckdbExtensionDir`                                                  | Directory where DuckDB (parquet queries) installs extensions (injected as `AEROLINK_DUCKDB_EXTENSION_DIR`). Empty means a process-writable temp directory: DuckDB installs into `~/.duckdb` by default and `INSTALL httpfs` fails when `HOME` is not writable, which breaks archive queries against S3 (local parquet queries are unaffected). Offline environments can pre-install httpfs and point this value at it. | `""`                          |
| `auditPersistence.enabled`                                            | Mount a persistent volume for archive parquet and klog files (without it a Pod rebuild loses them; recommended in production).                                                                                                                                                                                                          | `false`                       |
| `auditPersistence.mountPath`                                          | Mount path of that volume. Do not mount it at `/home/aerolink` itself, or it will shadow the binaries in the home directory.                                                                                                                                                                                                             | `/home/aerolink/data`         |
| `auditPersistence.pvc.enabled` / `auditPersistence.pvc.existingClaim` | Create a new PVC / use an existing one (empty falls back to `hostPath`, then `emptyDir`). Multi-replica deployments require an RWX shared volume, never `hostPath` or `emptyDir`.                                                                                                                                                        | `false` / `""`                |
| `auditPersistence.hostPath.enabled` / `.path` / `.type`               | Use hostPath storage (single replica only).                                                                                                                                                                                                                                                                                              | `false` / `/home/aerolink/data` / `DirectoryOrCreate` |

The accepted `auditSink` values and their prerequisites (the server refuses to start when a prerequisite is missing) are listed in [Configuration File](./config-file) and [Environment Variables](./env).

## Application Configuration

AeroLink supports loading cluster, OAuth/LDAP, and RBAC configuration from a YAML config file. When enabled, managed sections become read-only in the UI.

Available in AeroLink `v0.10.0` and later.

See [Configuration File](./config-file) for the full config file format, usage examples, and reference.

| Parameter               | Description                                                                    | Default |
| ----------------------- | ------------------------------------------------------------------------------ | ------- |
| `config.enabled`        | Enable configuration file mode                                                 | `false` |
| `config.existingSecret` | Name of an existing Secret containing a `config.yaml` key. Recommended approach. | `""`    |
| `config.superUser`      | Inline super user configuration (created on first startup only)                | `{}`    |
| `config.clusters`       | Inline cluster configurations (when no existingSecret)                         | `[]`    |
| `config.oauth`          | Inline OAuth provider configurations                                           | `[]`    |
| `config.ldap`           | Inline LDAP configuration                                                      | `{}`    |

`config.ldap` accepts `enabled`, `serverUrl`, `useStartTLS`, `bindDn`, `bindPassword`, `userBaseDn`, `userFilter`, `usernameAttribute`, `displayNameAttribute`, `groupBaseDn`, `groupFilter`, `groupNameAttribute`, `autoSync` and `syncIntervalMinutes`. `autoSync` / `syncIntervalMinutes` (defaults `true` / `10` minutes) control the periodic directory sync, see [config file](./config-file.md).
| `config.rbac.roles`     | Inline RBAC role definitions                                                   | `[]`    |
| `config.rbac.roleMapping` | Inline RBAC role mappings                                                    | `[]`    |

## Service Account Configuration

| Parameter                    | Description                                         | Default |
| ---------------------------- | --------------------------------------------------- | ------- |
| `serviceAccount.create`      | Whether to create a service account                 | `true`  |
| `serviceAccount.automount`   | Automatically mount service account API credentials | `true`  |
| `serviceAccount.annotations` | Annotations for service account                     | `{}`    |
| `serviceAccount.name`        | Name of service account to use                      | `""`    |

## RBAC Configuration

| Parameter     | Description                      | Default           |
| ------------- | -------------------------------- | ----------------- |
| `rbac.create` | Whether to create RBAC resources | `true`            |
| `rbac.rules`  | List of RBAC rules               | See example below |

### RBAC Rules Example

```yaml
rbac:
  rules:
    - apiGroups: ["*"]
      resources: ["*"]
      verbs: ["*"]
    - nonResourceURLs: ["*"]
      verbs: ["*"]
```

## Pod Configuration

| Parameter            | Description                    | Default |
| -------------------- | ------------------------------ | ------- |
| `podAnnotations`     | Kubernetes annotations for Pod | `{}`    |
| `podLabels`          | Kubernetes labels for Pod      | `{}`    |
| `podSecurityContext` | Pod security context           | `{}`    |
| `securityContext`    | Container security context     | `{}`    |

## Service Configuration

| Parameter      | Description  | Default     |
| -------------- | ------------ | ----------- |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `8080`      |

## Ingress Configuration

| Parameter             | Description                | Default           |
| --------------------- | -------------------------- | ----------------- |
| `ingress.enabled`     | Whether to enable Ingress  | `false`           |
| `ingress.className`   | Ingress class name         | `"nginx"`         |
| `ingress.annotations` | Ingress annotations        | `{}`              |
| `ingress.hosts`       | Ingress host configuration | See example below |
| `ingress.tls`         | TLS configuration          | `[]`              |

### Ingress Host Configuration Example

```yaml
ingress:
  hosts:
    - host: aerolink.gogdev.cn
      paths:
        - path: /
          pathType: ImplementationSpecific
```

## Gateway API

Expose AeroLink through Gateway / HTTPRoute instead of Ingress (both can coexist; pick one). The
cluster must already have the Gateway API CRDs installed.

| Parameter              | Description                                                                                                                    | Default                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `gateway.enabled`      | Whether to create Gateway API resources                                                                                        | `false`                                                        |
| `gateway.className`    | GatewayClass name; it must already exist in the cluster (`istio`, `cilium`, `nginx`, `envoy-gateway`, …)                        | `""`                                                           |
| `gateway.create`       | `true` to create a new Gateway, `false` to reference an existing one                                                            | `false`                                                        |
| `gateway.name`         | Gateway name (used both when creating and referencing)                                                                          | `""`                                                           |
| `gateway.namespace`    | Namespace of the existing Gateway, only used when `create=false`; defaults to the release namespace                              | `""`                                                           |
| `gateway.annotations`  | Annotations for the Gateway, only used when `create=true`                                                                       | `{}`                                                           |
| `gateway.listeners`    | Listener configuration (name, port, protocol, hostname, TLS, …), only used when `create=true`                                   | one `http` / `80` HTTP listener                                 |
| `gateway.httpRoutes`   | List of HTTPRoutes; each has `name`, `annotations`, `hostnames` and `rules` (`matches`, `timeouts`, …)                           | one `PathPrefix` route for `/` with a `120s` request timeout    |

Example (reference an existing Gateway and add a host-based route):

```yaml
gateway:
  enabled: true
  create: false
  name: shared-gateway
  className: nginx
  httpRoutes:
    - name: aerolink
      hostnames:
        - aerolink.gogdev.cn
      rules:
        - matches:
            - path:
                type: PathPrefix
                value: /
          timeouts:
            request: "120s"
```

## Resource Limits

| Parameter   | Description                            | Default |
| ----------- | -------------------------------------- | ------- |
| `resources` | Container resource limits and requests | `{}`    |

### Resource Limits Example

```yaml
resources:
  limits:
    cpu: 100m
    memory: 128Mi
  requests:
    cpu: 100m
    memory: 128Mi
```

## Health Checks

| Parameter        | Description                   | Default           |
| ---------------- | ----------------------------- | ----------------- |
| `livenessProbe`  | Liveness probe configuration  | See example below |
| `readinessProbe` | Readiness probe configuration | See example below |

### Health Check Example

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: http
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /healthz
    port: http
  initialDelaySeconds: 10
  periodSeconds: 10
```

## Storage Configuration

| Parameter      | Description                            | Default |
| -------------- | -------------------------------------- | ------- |
| `volumes`      | Additional volume configurations       | `[]`    |
| `volumeMounts` | Additional volume mount configurations | `[]`    |

## Scheduling Configuration

| Parameter      | Description               | Default |
| -------------- | ------------------------- | ------- |
| `nodeSelector` | Node selector             | `{}`    |
| `tolerations`  | Tolerations configuration | `[]`    |
| `affinity`     | Affinity configuration    | `{}`    |
