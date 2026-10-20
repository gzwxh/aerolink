# Build and Push the AeroLink Image

This page shows how to package the current source tree into a container image, push it to your own
registry, and deploy that self-built image with Helm. It targets secondary development, internal
private registries, and environments where Docker Hub / gcr.io are unreachable.

## Prerequisites

- Docker is installed and `docker version` shows a **Server** section (a Client-only output means the daemon is not running).
- A usable image registry: Docker Hub, Alibaba Cloud ACR, Tencent Cloud TCR, a self-hosted Harbor, etc.
- The source tree is available, with a `Dockerfile` at the repository root (multi-stage build: frontend node → backend golang → openEuler runtime) and `charts/aerolink`.

## 1. Build the Image

The simplest form (using the default upstream registries):

```bash
docker build -t aerolink:local .
```

Injecting version information is recommended so the UI shows a real version instead of `dev`(same mechanism as the Makefile):

```bash
VERSION=$(bash scripts/get-version.sh)          # e.g. v1.0.1-p9-82911d0
docker build \
  --build-arg VERSION="$VERSION" \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg COMMIT_ID="$(git rev-parse --short HEAD)" \
  -t aerolink:local .
```

:::: tip Pushing to registries that do not fully support OCI (Huawei Cloud SWR, etc.)
BuildKit attaches provenance / SBOM manifests by default, producing a manifest index that some
registries reject with `Invalid image, fail to parse 'manifest.json'`. Rebuild with these two
flags:

```bash
docker build --provenance=false --sbom=false --platform linux/amd64 -t aerolink:local .
```
::::

### When the build machine is outside the corporate network

The default base images all come from the corporate SWR (see the table below). If the build machine
cannot reach SWR, switch to public images and configure the dependency sources:

```bash
VERSION=$(bash scripts/get-version.sh)
docker build \
  --build-arg NODE_IMAGE=node:24-alpine \
  --build-arg GOLANG_IMAGE=golang:1.26.8 \
  --build-arg RUNTIME_IMAGE=alpine:3.23.2 \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg VERSION="$VERSION" \
  -t aerolink:local .
```

:::: tip A shorter path
Configure a registry mirror for Docker first (see the FAQ below). Then `node` / `golang` can be
pulled by their default names and you only need to override the runtime base image and the
dependency source.
::::

Build argument reference:

| Argument | Default | Description |
| --- | --- | --- |
| `NODE_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/node:24-alpine` | Frontend build base image (corporate SWR) |
| `GOLANG_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/golang:1.26.8` | Backend build base image (corporate SWR; must be the **Debian** variant, cgo needs gcc/g++) |
| `RUNTIME_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/openeuler/openeuler:24.03-lts-sp4` | Runtime base image (corporate SWR) |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | Frontend dependency source (Go dependencies come from the checked-in `vendor/`, so there is no GOPROXY argument) |
| `VERSION` / `BUILD_DATE` / `COMMIT_ID` | `v1.0.0` / `unknown` / `unknown` | Injected into `pkg/version` and shown in the UI |

### Help site image (optional)

The help site under `docs/` (VitePress) is not part of the application image (the root `.dockerignore` excludes `docs`); it ships as a separate nginx static image. The address is already set in the Makefile's `DOCS_IMAGE`:

```bash
make docs-image   # build only
make push-docs    # build and push (same shape as make push / make push-binary)
docker push swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink-docs:v1.0.2   # push an already built image
```

Equivalent manual command (the build context is `docs/`, not the repository root):

```bash
docker build --provenance=false --sbom=false -f docs/Dockerfile \
  -t swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink-docs:v1.0.2 docs/
```

When the build machine is outside the corporate network, add `--build-arg NODE_IMAGE=node:24-alpine --build-arg NGINX_IMAGE=nginx:alpine --build-arg NPM_REGISTRY=https://registry.npmmirror.com` (see the comments at the top of `docs/Dockerfile`).

After deploying it, put the URL into General Settings → Help documentation URL.

## 2. Verify the Image

```bash
docker run -d --name aerolink -p 8080:8080 \
  -v aerolink-data:/app/data \
  -e DB_DSN=/app/data/aerolink.db \
  -e AEROLINK_ENCRYPT_KEY="$(openssl rand -base64 32)" \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  aerolink:local

curl -I http://127.0.0.1:8080/        # expect HTTP 200
docker logs aerolink | head              # expect "AeroLink server started on port 8080"

docker rm -f aerolink
```

> Without `AEROLINK_ENCRYPT_KEY` the server refuses to start (production safety check). Keep the
> generated key safe: changing `AEROLINK_ENCRYPT_KEY` makes every stored credential undecryptable.

## 3. Push to a Registry

Log in according to your registry type (credential rules differ; prefer an access token over an
account password):

```bash
docker login                                      # Docker Hub
docker login registry.cn-hangzhou.aliyuncs.com    # Alibaba Cloud ACR
docker login ccr.ccs.tencentyun.com               # Tencent Cloud TCR
docker login harbor.example.com                   # self-hosted Harbor
```

Tag and push, replacing `<registry>/<namespace>` with your own repository:

```bash
VERSION=$(bash scripts/get-version.sh)

docker tag aerolink:local <registry>/<namespace>/aerolink:$VERSION
docker push <registry>/<namespace>/aerolink:$VERSION

# push a latest tag too if needed
docker tag aerolink:local <registry>/<namespace>/aerolink:latest
docker push <registry>/<namespace>/aerolink:latest
```

### Huawei Cloud SWR example

```bash
# the username is "<region>@<AK>" and the password is the matching SK (a temporary login, not an account password)
docker login -u cn-south-1@<your-AK> -p <your-SK> swr.cn-south-1.myhuaweicloud.com

VERSION=$(bash scripts/get-version.sh)
docker tag aerolink:local swr.cn-south-1.myhuaweicloud.com/<org-or-user>/aerolink:$VERSION
docker push swr.cn-south-1.myhuaweicloud.com/<org-or-user>/aerolink:$VERSION
```

If one SWR domain hosts several accounts (a personal repository and an organization repository,
for example), Docker stores credentials per domain, so a later login overwrites the previous
account. Use separate config directories:

```bash
docker --config ~/.docker-personal login -u cn-south-1@<AK1> -p <SK1> swr.cn-south-1.myhuaweicloud.com
docker --config ~/.docker-org      login -u cn-south-1@<AK2> -p <SK2> swr.cn-south-1.myhuaweicloud.com

docker --config ~/.docker-org push swr.cn-south-1.myhuaweicloud.com/<org>/aerolink:$VERSION
```

For multi-architecture builds (amd64 + arm64) use buildx:

```bash
docker buildx create --name aerolink-builder --use
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg RUNTIME_IMAGE=alpine:3.23.2 \
  -t <registry>/<namespace>/aerolink:$VERSION --push .
```

## 4. Deploy the Self-Built Image with Helm

`charts/aerolink` defaults to the image
`swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink`; override it with `--set`:

```bash
VERSION=$(bash scripts/get-version.sh)

helm upgrade --install aerolink charts/aerolink \
  -n aerolink-system --create-namespace \
  --set image.repository=<registry>/<namespace>/aerolink \
  --set image.tag=$VERSION \
  --set image.pullPolicy=IfNotPresent
```

Private registries need pull credentials:

```bash
kubectl create secret docker-registry aerolink-regcred -n aerolink-system \
  --docker-server=<registry> \
  --docker-username=<user> \
  --docker-password=<password>

helm upgrade --install aerolink charts/aerolink -n aerolink-system \
  --set image.repository=<registry>/<namespace>/aerolink \
  --set image.tag=$VERSION \
  --set imagePullSecrets[0].name=aerolink-regcred
```

### Ready-made values files in the repository

The repository ships a values file already written for a specific registry, so you can just point
`-f` at it:

```bash
# personal registry
helm upgrade --install aerolink charts/aerolink -n aerolink-system --create-namespace \
  -f charts/aerolink/examples/swr-gzwxh.yaml
```

### Publishing the chart (optional)

```bash
helm package charts/aerolink -d dist
helm push dist/aerolink-1.0.0.tgz oci://<registry>/<namespace>
```

:::: warning Huawei Cloud SWR personal edition does not accept Helm OCI artifacts
Pushing a chart to SWR fails with `manifest invalid: Invalid image, fail to parse 'manifest.json'`
(SWR only parses container image manifests). In that case install straight from the repository
directory: `helm install aerolink charts/aerolink`, or distribute the `helm package` tarball
through another channel.
::::

:::: warning Always set the encryption key in production
`AEROLINK_ENCRYPT_KEY` encrypts user passwords, OAuth clientSecrets, kubeconfigs and other
sensitive data; without it an unsafe default key is used. Inject it through
`--set env.AEROLINK_ENCRYPT_KEY=...` (or the matching values field), see
[Environment Variables](../config/env).
::::

More installation options (Ingress, sub-path deployment, port forwarding, uninstall, and so on)
are covered in the [installation guide](./installation); every configurable chart option is listed
in [Chart Values](../config/chart-values).

## 5. FAQ

**Pulling a base image fails: `dial tcp ... connection refused` / TLS timeout**

Configure a registry mirror and retry:

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run"
  ]
}
EOF
sudo systemctl restart docker
```

**The runtime base image cannot be pulled**

It comes from the corporate SWR by default
(`swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/openeuler/openeuler:24.03-lts-sp4`). If the
build machine is outside the corporate network, switch to a public image:
`--build-arg RUNTIME_IMAGE=alpine:3.23.2` (CA certificates and timezone data are copied from the
build image by the Dockerfile, so the base image does not need `ca-certificates` or `tzdata`).

**The build fails with `inconsistent vendoring`**

Backend dependencies come from the checked-in `vendor/` (the build does not download Go modules).
After changing `go.mod` or upgrading dependencies, run `make deps` locally (`go mod tidy` +
`go mod vendor`), commit the `vendor/` changes, then rebuild. This is a deliberate fail-closed:
an inconsistent vendor tree fails immediately instead of silently falling back to the network.

**pnpm fails with `ERR_PNPM_IGNORED_BUILDS: esbuild`**

The Dockerfile writes a `pnpm-workspace.yaml` stating that this dependency does not need build
scripts (esbuild ships prebuilt binaries). If a later pnpm version changes that behavior, use
`pnpm install --frozen-lockfile --dangerously-allow-all-builds` temporarily.

**Push fails with `Invalid image, fail to parse 'manifest.json'` (Huawei Cloud SWR)**

The registry rejects manifest indexes carrying attestations; add `--provenance=false --sbom=false`
to the build (see the tip in “1. Build the Image”).

**Login fails with `denied: Authenticate Error`**

The SWR username is `<region>@<AK>` and the password is the SK; AK/SK may also have been rotated.
Make sure you are not using an account password, and check that the AK has SWR permissions.

**The UI “About” dialog shows the version as `dev`**

Pass `--build-arg VERSION=$(bash scripts/get-version.sh)` during the build.

**Docker commands report `Cannot connect to the Docker daemon` in WSL**

Make sure systemd is enabled in WSL (`[boot]` / `systemd=true` in `/etc/wsl.conf`, then
`wsl --shutdown` to restart), and then:

```bash
sudo systemctl enable --now docker
docker version     # should show a Server section
```