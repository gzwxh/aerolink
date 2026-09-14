<div align="center">

<img src="./docs/assets/logo.svg" alt="Kite Logo" width="128" height="128">

# Kite (internal fork)

**All your clusters. One workspace.**

Kite is a lightweight, open-source Kubernetes workspace for multi-cluster operations, observability, access control, and AI-assisted troubleshooting.
This repository is the **company-internal fork** of the upstream project, currently at `v1.0.0`.

**English** · [中文](./README.md)

</div>

## About this repository

This repository is a customized fork of [kite-org/kite](https://github.com/kite-org/kite) (mirror: [gitee.com/gzwxh/kite](https://gitee.com/gzwxh/kite)), maintained on the internal GitLab and for internal use only.

- Upstream project: <https://github.com/kite-org/kite> (docs: <https://kite.zzde.me>)
- Upstream mirror: <https://gitee.com/gzwxh/kite>
- Internal repository: `ssh://git@10.10.11.151:20222/teg/support-department/operation_rd_dept/kite.git` (branch `release/v1.0.0`)
- Chinese docs: see [`docsCN/`](./docsCN/index.md) and [`README.md`](./README.md)
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
make build     # build the frontend (embedded into static/) and the ./kite binary
./kite         # start the server on port 8080
```

## Docker image

```bash
make image     # build the image (default tag: see the IMAGE variable in the Makefile)
make push      # build and push to the company SWR registry
```

Behind a restricted network the mirror build args are preconfigured; on a direct connection use `make image DOCKER_BUILD_ARGS=`.

## Running

| Environment variable | Description |
| --- | --- |
| `KITE_ENCRYPT_KEY` | data encryption key, **required in production**, must match existing data |
| `PORT` | server port, default `8080` |
| `DB_DSN` | database connection (SQLite by default) |

## Syncing with upstream

```bash
git remote add upstream https://github.com/kite-org/kite
git fetch upstream
git merge upstream/main
```

## License

[Apache-2.0](./LICENSE)
