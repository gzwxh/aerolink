# Database Preparation

AeroLink defaults to SQLite (a single file), so it runs out of the box; **production and
multi-replica deployments should use MySQL or PostgreSQL**. This page is the checklist for setting up
the database: DDL, required DSN parameters, how the connection pool translates into
`max_connections`, who applies schema changes, and upgrading PostgreSQL across major versions.
Deployment shapes (chart / manifests / compose / systemd) are covered in
[Deployment and Operations](../guide/operations).

## Choosing a database

| Database | Role | Version | Notes |
| --- | --- | --- | --- |
| SQLite | Default, single instance | none (pure Go driver, no CGO) | One file, one writer. **Unusable with multiple replicas** — two processes writing the same file will lock each other up or corrupt it |
| MySQL | Production / replicas | 5.7 / 8.x | SQL is written to stay clear of 5.7 reserved words (`key` / `read` / `groups` are never used as bare identifiers); 8.4 has been run in production |
| PostgreSQL | Production / replicas | **12 or later** | One binary verified against `12.12` / `12.22` / `13.23` / `18.6` |

The version floor is enforced, not assumed:

- The code only uses syntax that exists in PostgreSQL 9.5: there is no `server_version` branch and no
  `CREATE EXTENSION` (`gen_random_uuid()` is a forbidden construct — it needs `pgcrypto` on PG 12).
- `pg_version_floor_test.go` in the repository root scans every string literal in the tree and
  **fails the test** as soon as a 13+-only token appears, so nobody can quietly raise the floor.

**CI only runs SQLite**: the pipeline executes `go test ./...` against SQLite. Cross-database
differences therefore never fail CI, so any SQL change or database switch must be verified on the
real engines. The writing rules are in `docs/dev/cross-database-compatibility.md`.

## Creating the database

### PostgreSQL

Run as a superuser (the application never needs the right to create databases):

```sql
CREATE DATABASE aerolink ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8' TEMPLATE template0;
CREATE ROLE aerolink LOGIN PASSWORD 'your-password';
ALTER DATABASE aerolink OWNER TO aerolink;
```

Points to know:

- **The encoding must be `UTF8`.** It cannot be changed later; fixing it means recreating the
  database.
- **Collation `en_US.utf8`** comes from glibc. After a glibc upgrade on the host, run
  `ALTER DATABASE aerolink REFRESH COLLATION VERSION;` once, and `REINDEX` if text columns carry
  unique or ordering indexes.
- **Do not grant the application role `CREATEDB` / `CREATEROLE`.** It does not need them and
  granting them only widens the blast radius. The deployed role passes with `rolsuper`,
  `rolcreatedb` and `rolcreaterole` all `f`.
- Tables are created by `AutoMigrate` on first start, so the database owner must be the application
  role — otherwise adding a column during an upgrade is rejected by PostgreSQL (see
  [who applies schema changes](#who-applies-schema-changes)).

For a containerised PostgreSQL, the equivalent is three statements inside `psql -U postgres`.

### MySQL

```sql
CREATE DATABASE aerolink CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

`utf8mb4` is mandatory (the three-byte `utf8` cannot store emoji or some CJK code points). Create
the account and grants according to your DBA's conventions — the application only needs normal read,
write and DDL rights on that database.

## DSN

`DB_TYPE` is `sqlite` (default), `mysql` or `postgres`, and `DB_DSN` holds the connection string. An
invalid value makes the process **exit immediately**; there is no fallback.

```bash
# SQLite: a file path
DB_TYPE=sqlite
DB_DSN=/home/aerolink/db/aerolink.db

# PostgreSQL (key=value form)
DB_TYPE=postgres
DB_DSN="host=10.100.117.8 port=5433 user=aerolink password=<password> dbname=aerolink sslmode=disable TimeZone=Asia/Shanghai"

# PostgreSQL (URL form; escape special characters in the password)
DB_TYPE=postgres
DB_DSN="postgres://aerolink:%40pwd@10.100.117.8:5433/aerolink?sslmode=disable&TimeZone=Asia%2FShanghai"

# MySQL
DB_TYPE=mysql
DB_DSN="aerolink:<password>@tcp(10.100.117.8:3306)/aerolink?charset=utf8mb4&parseTime=true&loc=Asia%2FShanghai"
```

Required parameters and what happens without them:

| Parameter | Consequence of omitting it |
| --- | --- |
| PostgreSQL `TimeZone` | **No error** — the UI and audit timestamps simply shift (8 hours off, for instance). Startup logs a warning |
| MySQL `loc` | Same, and it must match the server's `time_zone` |
| MySQL `charset=utf8mb4` | Chinese text and emoji break |
| PostgreSQL `sslmode` | Use `disable` without TLS; `require` or `verify-full` with it |

`TimeZone` is the parameter we have actually been bitten by: it starts fine without it and is only
correct with it, so the post-migration checklist must include a timestamp check.

## Connection pool and capacity

| Variable | Default | Notes |
| --- | --- | --- |
| `AEROLINK_DB_MAX_OPEN_CONNS` | 100 | Maximum open connections (must be > 0) |
| `AEROLINK_DB_MAX_IDLE_CONNS` | 10 | Maximum idle connections (0 allowed) |
| `AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES` | 10 | Maximum connection lifetime in minutes (must be > 0) |

The capacity rule is a hard constraint:

```
replicas × AEROLINK_DB_MAX_OPEN_CONNS + 20 (admin / backup / monitoring headroom) ≤ max_connections
```

- **Idle connections still hold their slot** — pooled connections are not returned to the server
  while idle.
- `pg_dump`, `psql` and monitoring scrapers each take a connection too; do not consume the headroom
  down to zero.
- Reference sizing: the design target (300 users, up to 3 replicas) uses `max_connections=400` on
  PostgreSQL. Going to 4 replicas means either raising it to 500 or lowering the application side
  to 80.

Always run the formula before raising the pool, otherwise the symptom is “fine at rest, random
connection failures at peak”.

## Who applies schema changes

- **Tables are created on first start**: `AutoMigrate` creates tables and adds columns per model, and
  new tables appear automatically.
- **The application account is usually not the table owner** in production. PostgreSQL then rejects
  column additions (`must be owner of table ...`, SQLSTATE 42501) — this is **logged as a warning and
  startup continues**. So schema cannot be expected to “grow by itself”: every release lists the SQL
  to run beforehand in its own section (with the three-database equivalent syntax).
- **`AEROLINK_DB_MIGRATE=off`** skips automatic migration and backfills entirely, printing one
  explanatory line; schema is then maintained by an external process (DBA / release script).
  **`checkSchema` still runs** as a cross-check.
- **`AEROLINK_DB_MIGRATE_STRICT=true`** panics on migration errors; development and CI only, never
  production.

`checkSchema` compares the schema against the models table by table and column by column at startup.
The messages (verbatim from the system log):

| Case | Message |
| --- | --- |
| Missing table | `库结构缺少表 %s：相关功能会报错，请让 DBA 建表` |
| Missing column | `库表 %s 缺少列 %s：依赖它的接口会报错，请让 DBA 补上` |
| Matching | `库结构与模型一致` (Info) |
| Differences | `共发现 %d 处库结构差异（见上方清单）——补齐后重启即可；服务当前仍可启动` (Error) |

Post-upgrade verification is simply looking for these lines: a difference means a SQL step was
skipped — run it and restart.

## Renaming and credentials

Renaming a PostgreSQL database or role does not require moving data and takes seconds:

```sql
-- 1) After disconnecting every session, rename
ALTER DATABASE kite RENAME TO aerolink;
-- 2) Connect to the new database and hand over objects owned by the old role
REASSIGN OWNED BY kite TO aerolink;
-- 3) Update dbname= / user= in the DSN and restart
```

For a zero-downtime switch, grant the old role `GRANT ALL` on tables and sequences first, so
connections on either name keep working during the window.

If you intend to use SCRAM password authentication, you can switch now:

```sql
ALTER SYSTEM SET password_encryption='scram-sha-256';
SELECT pg_reload_conf();
ALTER ROLE aerolink PASSWORD '<same-password>';   -- must be re-set to be re-hashed
```

Confirm every client supports it first (pgx and `psql` 10+ do).

## Upgrading PostgreSQL major versions

| Case | Approach |
| --- | --- |
| Minor (12.12 → 12.22) | Swap the image tag and restart; the data directory layout is unchanged, no dump/restore needed |
| Major (12 → 14/15/16/17/18) | ① New container + `pg_dump` / `pg_restore`; ② new container + `tools/dbmigrate`; ③ `pg_upgrade` (needs the old binaries side by side). For containers, ①/② are recommended |

A major version can be skipped in one hop (12 → 18 has been migrated successfully), but read the
release notes of the intermediate versions. Three fixed follow-ups:

1. `ALTER DATABASE aerolink REFRESH COLLATION VERSION;` (plus `REINDEX` if `datcollate` changed).
2. Re-check `max_connections` against the pool formula above.
3. Note that from PG 18 on, `PGDATA` is `/var/lib/postgresql/18/docker` and the volume must be
   mounted at `/var/lib/postgresql` — copying the old volume path makes the data “disappear”.

A logical backup (`pg_dump`) is small, restorable across versions and is itself the upgrade fallback.
The rollback procedure and backup checklist for a database switch are in
[Deployment and Operations](../guide/operations#backup-and-restore).

## Related documentation

- [Environment Variables](./env): the full variable list, including the pool and
  `AEROLINK_DB_MIGRATE`.
- [Configuration File](./config-file): `AEROLINK_CONFIG_FILE` and what “config file takes over, UI is
  read-only” means.
- [Chart Values](./chart-values): `db.type` / `db.dsn` / `db.sqlite.options` and reusing an existing
  Secret.
- [FAQ](../faq): why SQLite on `hostPath` fails with `out of memory (14)` and the `_pragma` fix.