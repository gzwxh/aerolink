# Audit & Compliance

Audit records in AeroLink are **append-only**: no interface can modify or delete an individual
record (cleanup only expires whole batches according to the retention policy), and exported files
carry a server-side signature so they can be verified afterwards. This page covers what is recorded,
where to look, how long it is kept and how it is forwarded.

## Where to look

“System Settings → **Audit**” has six tabs:

| Tab | Content | Source |
| --- | --- | --- |
| Login Log | Every login attempt, successful or not | `login_records` table |
| Operation Log | Administrative operations and resource changes | `resource_histories` table |
| File Operations | Viewing, downloading and uploading files from the Pod file page | file operations inside `resource_histories` |
| Password Change Log | Password change records | `password_change_logs` table |
| Archive Search | Historical logs that have been archived (including records already expired locally) | see [Archive and search](#archive-and-search) |
| Audit Settings | Retention, archiving, forwarding | `audit_settings` table |

Two more entry points live elsewhere:

- **System Log**: “System Settings → System Log” controls archiving and output of the access log
  (HTTP access records). Access logs are much larger, so they are configured separately from the
  audit log and kept for a shorter time by default.
- **Resource History**: the change history of a single resource, on the “History” tab of the
  resource detail page — see [Resource History](./resource-history).

## What is recorded

### Login Log

Each record holds the time, username, login method (local password / LDAP / OAuth / API key), client
IP, User-Agent and result. **An empty result means the login succeeded**; anything else is a failure
code, translated in the UI:

| Result code | Meaning |
| --- | --- |
| `invalid_credentials` | Wrong username or password |
| `mfa_invalid` | Wrong one-time code |
| `captcha_invalid` | Wrong CAPTCHA |
| `ip_denied` | Source IP denied |
| `source_denied` | Source address not in the allowlist |
| `too_many_attempts` | Too many attempts; account or IP locked |
| `not_provisioned` | Directory user not provisioned in the console yet |
| `no_permission` | Account disabled or without any permission |
| `account_expired` | Account expired |

### Operation Log

Each record holds the actor, time, cluster, resource type / name / namespace, action type, source
(manual / scheduled task / AI tool), success or failure with the reason, client IP and User-Agent,
plus the YAML before and after the change.

Two conventions worth knowing:

- The **actor username is a snapshot taken at write time**. If the account is later deleted or
  renamed, the record still points at the original person: the foreign key is nulled on account
  deletion instead of cascading the record away.
- Writes that do not go through HTTP (scheduled tasks, AI tools) have no client IP or User-Agent;
  those columns are empty.

### File Operations

Three actions filtered out of the operation log: view file (`view-file`), download file
(`download-file`) and upload file (`upload-file`), including the container and file path. This is how
you answer “who downloaded that log”.

### Password Change Log

When and by whom a password was changed. Combine it with the password policy (“cannot reuse the
previous passwords”), see [Security Policy](../config/security-policy).

## Export and verification

Every list can be exported as CSV. The download response carries two fingerprints:

| Header | Meaning |
| --- | --- |
| `X-Audit-Content-SHA256` | SHA-256 of the file content (hex) |
| `X-Audit-Content-HMAC` | HMAC-SHA256 of the file content, keyed with the server secret |

To verify: run `sha256sum` on the file and compare it with the SHA-256 shown in the UI. The HMAC
proves the export really came from this server — a SHA-256 comparison alone can be satisfied by any
file paired with its own self-consistent hash.

## Storage backend (pick one of five)

Where audit records go is decided **at startup** and is read-only in the UI: set `auditSink` in the
configuration file or the `AEROLINK_AUDIT_SINK` environment variable to `database` (default),
`parquet`, `elasticsearch`, `victorialogs` or `openobserve` — they are mutually exclusive. An invalid
value, or a missing prerequisite for the chosen backend (e.g. `parquet` without an archive
directory, `elasticsearch` without node URLs), makes the server **refuse to start** instead of
silently falling back.

Multi-replica deployments must set the same value on every replica, otherwise records scatter across
stores. See [Environment Variables](../config/env) and [Configuration File](../config/config-file)
for the full list and prerequisites.

## Archive and search

Archiving is **best effort**: a failed archive write does not affect the local database write and
never slows down the request.

- **Local parquet**: a batch is flushed when any of three thresholds is reached (interval, record
  count, bytes), tunable in “Audit Settings → Archive”. By default the **resource YAML before/after
  is not written** (it would bloat the files); enable it when you need full traceability.
- **S3 remote copy**: optional. Copies archives to object storage; local files can be deleted once
  the upload is confirmed.
- **DuckDB (queries parquet directly)**: no extra component to deploy, the search reads the parquet
  files. Querying archives on S3 relies on the `httpfs` extension — see
  `AEROLINK_DUCKDB_EXTENSION_DIR` in [Environment Variables](../config/env).
- **Elasticsearch / VictoriaLogs / OpenObserve**: storage and expiry are handled by those services.

“Audit → Archive Search” lets you switch the search backend (it follows the configured sink) and
query three record kinds: operation history, login log and access log. Two caveats:

- **Archiving is asynchronous**: an operation that just happened may not be indexed yet; the page
  shows the query delay of the current sink.
- With the `database` sink (the default) there is nothing archived to search; the page tells you to
  change `auditSink` and restart.

## Retention

| Scope | Default | Notes |
| --- | --- | --- |
| Audit log (database) | Keep forever | Can be set to N days, minimum 30; `0` means forever |
| Archive files (local parquet / S3) | 7 days | `0` disables time-based cleanup; a size cap can also be set, oldest files removed first |
| Access log (archive) | 3 days | Configured separately from the audit log |
| Elasticsearch | Daily indices | Expired indices are deleted in bulk |
| VictoriaLogs / OpenObserve | Handled by the server | The retention days in “Audit Settings” do not apply: they are VictoriaLogs' `-retentionPeriod` and OpenObserve's stream `data_retention` |

Cleanup runs as a background job: database audit records every 24 hours (first run two minutes after
startup, batches deleted in chunks); local archive files every 6 hours.

## Forwarding

Besides the database, audit events can be shipped to a log platform:

| Method | Notes |
| --- | --- |
| Standard output | **Enabled by default**, one JSON object per line; collected by Filebeat / Fluent Bit. Only the operation / login / password-change kinds are emitted (the access log is already printed by the access-log middleware) |
| syslog | `udp` / `tcp` / `tls`, default APP-NAME `aerolink`, facility `13` (log audit); body format is key=value or JSON, and server certificate verification can be skipped for self-signed setups |
| Kafka | SASL and TLS supported |

Forwarding is one switch plus one method (syslog or Kafka, not both), configured in “Audit → Audit
Settings”. Secret fields are never echoed back.

## Compliance notes

- **Read-only audit trail**: records can only be viewed; neither the UI nor the API offers deletion.
- **Traceable to a person**: every record carries the actor, time and source (IP / User-Agent), and
  the actor name is a snapshot unaffected by later account changes.
- **Verifiable exports**: CSV exports carry both a SHA-256 and an HMAC-SHA256 fingerprint.
- **Separation of duties**: the audit administrator can only read the audit trail and cannot change
  settings; mutual exclusion and hard rejection are described in
  [Security Policy](../config/security-policy).

## Limitations

- **Resource-level change history requires the `database` sink**: `parquet` omits the resource YAML
  by default and Elasticsearch documents do not contain it, so neither can power a before/after
  comparison.
- **With multiple replicas, parquet must be on shared storage**: each replica writes only the records
  it produced while reading its local directory, so without sharing the search is incomplete.
- **Reading a Secret is not audited separately**: Secrets are ordinary resources in the operation log
  (writes are recorded), but there is no standalone “who read this Secret” record.