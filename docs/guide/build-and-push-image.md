# 构建并推送鸢联 AeroLink 镜像

本篇介绍如何把当前源码打包成容器镜像、推送到自己的镜像仓库，再用 Helm 部署这套自建镜像。适合二次开发、内网私有仓库，以及 Docker Hub / gcr.io 访问受限的环境。

## 前提条件

- 已安装 Docker，`docker version` 能看到 **Server** 段（只有 Client 说明守护进程没起来）。
- 有一个可用的镜像仓库：Docker Hub、阿里云 ACR、腾讯云 TCR、自建 Harbor 等。
- 已获取源码，根目录存在 `Dockerfile`（多阶段构建：前端 node → 后端 golang → 运行时 openEuler）与 `charts/aerolink`。

## 一、构建镜像

最简方式（使用官方默认源）：

```bash
docker build -t aerolink:local .
```

推荐同时注入版本信息，界面上会显示真实版本而不是 `dev`（与 Makefile 的注入方式一致）：

```bash
VERSION=$(bash scripts/get-version.sh)          # 例如 v1.0.1-p9-82911d0
docker build \
  --build-arg VERSION="$VERSION" \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg COMMIT_ID="$(git rev-parse --short HEAD)" \
  -t aerolink:local .
```

::: tip 推送到不完全支持 OCI 的仓库时（华为云 SWR 等）
BuildKit 默认会给镜像附加 provenance / SBOM 清单，形成 manifest index，部分仓库会拒绝并报
`Invalid image, fail to parse 'manifest.json'`。此时用下面两个参数重新构建即可：

```bash
docker build --provenance=false --sbom=false --platform linux/amd64 -t aerolink:local .
```
:::

### 构建机不在公司网络内时

默认基础镜像全部取自公司 SWR（见下表）；若构建机拉不到 SWR，可换成公共镜像并配好依赖源：

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

::: tip 更省事的做法
先给 Docker 配镜像加速（见「常见问题」），这样 `node` / `golang` 可以直接用默认名字拉取，只替换基座与依赖源即可。
:::

构建参数速查：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/node:24-alpine` | 前端构建基础镜像（公司 SWR） |
| `GOLANG_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/golang:1.26.8` | 后端构建基础镜像（公司 SWR；必须是 **Debian 版**，cgo 编译需要 gcc/g++） |
| `RUNTIME_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/openeuler/openeuler:24.03-lts-sp4` | 运行时基础镜像（公司 SWR） |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | 前端依赖源（Go 依赖走仓库里的 `vendor/`，构建不下载模块，因此没有 GOPROXY 参数） |
| `VERSION` / `BUILD_DATE` / `COMMIT_ID` | `v1.0.3` / `unknown` / `unknown` | 注入 `pkg/version`，展示在界面上 |

### 帮助文档站镜像（可选）

`docs/` 下的帮助文档站（VitePress）不并入应用镜像（根 `.dockerignore` 排除 `docs`），单独出一个 nginx 静态镜像。地址已在 `Makefile` 的 `DOCS_IMAGE` 里给好，直接用：

```bash
make docs-image   # 只构建
make push-docs    # 构建并推送（与应用镜像的 make push / make push-binary 同一形状）
docker push swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink-docs:v1.0.3   # 只推送已构建的镜像
```

等价的手工命令（注意构建上下文是 `docs/`，不是仓库根）：

```bash
docker build --provenance=false --sbom=false -f docs/Dockerfile \
  -t swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink-docs:v1.0.3 docs/
```

构建机不在公司网络内时，另加 `--build-arg NODE_IMAGE=node:24-alpine --build-arg NGINX_IMAGE=nginx:alpine --build-arg NPM_REGISTRY=https://registry.npmmirror.com`（约束见 `docs/Dockerfile` 顶部注释）。

部署后把访问地址填进控制台「通用设置 → 帮助文档地址」，登录页与顶栏会出现「帮助文档」入口。

## 二、验证镜像

```bash
docker run -d --name aerolink -p 8080:8080 \
  -v aerolink-data:/app/data \
  -e DB_DSN=/app/data/aerolink.db \
  -e AEROLINK_ENCRYPT_KEY="$(openssl rand -base64 32)" \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  aerolink:local

curl -I http://127.0.0.1:8080/        # 期望 HTTP 200
docker logs aerolink | head              # 期望看到 AeroLink server started on port 8080

docker rm -f aerolink
```

> 缺少 `AEROLINK_ENCRYPT_KEY` 时服务会拒绝启动（生产安全检查）；请妥善保存生成的密钥，更换 `AEROLINK_ENCRYPT_KEY` 会使已保存的凭据无法解密。

## 三、推送到镜像仓库

按仓库类型登录（用户名/密码规则各不同，建议使用访问令牌而不是账号密码）：

```bash
docker login                                      # Docker Hub
docker login registry.cn-hangzhou.aliyuncs.com    # 阿里云 ACR
docker login ccr.ccs.tencentyun.com               # 腾讯云 TCR
docker login harbor.example.com                   # 自建 Harbor
```

打标签并推送，把 `<registry>/<namespace>` 换成自己的仓库地址：

```bash
VERSION=$(bash scripts/get-version.sh)

docker tag aerolink:local <registry>/<namespace>/aerolink:$VERSION
docker push <registry>/<namespace>/aerolink:$VERSION

# 需要 latest 时再推一个
docker tag aerolink:local <registry>/<namespace>/aerolink:latest
docker push <registry>/<namespace>/aerolink:latest
```

### 华为云 SWR 示例

```bash
# 用户名格式为「区域@AK」，密码为对应的 SK（是临时登录指令，不是账号密码）
docker login -u cn-south-1@<你的AK> -p <你的SK> swr.cn-south-1.myhuaweicloud.com

VERSION=$(bash scripts/get-version.sh)
docker tag aerolink:local swr.cn-south-1.myhuaweicloud.com/<组织或用户名>/aerolink:$VERSION
docker push swr.cn-south-1.myhuaweicloud.com/<组织或用户名>/aerolink:$VERSION
```

同一个 SWR 域名下如果有多个账号（例如个人仓库与组织仓库），由于 Docker 的凭据是按域名保存的，后登录会覆盖前一个账号。这时用独立的配置目录分别登录/推送：

```bash
docker --config ~/.docker-personal login -u cn-south-1@<AK1> -p <SK1> swr.cn-south-1.myhuaweicloud.com
docker --config ~/.docker-org      login -u cn-south-1@<AK2> -p <SK2> swr.cn-south-1.myhuaweicloud.com

docker --config ~/.docker-org push swr.cn-south-1.myhuaweicloud.com/<组织>/aerolink:$VERSION
```

需要多架构（amd64 + arm64）时用 buildx：

```bash
docker buildx create --name aerolink-builder --use
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg RUNTIME_IMAGE=alpine:3.23.2 \
  -t <registry>/<namespace>/aerolink:$VERSION --push .
```

## 四、用 Helm 部署自建镜像

`charts/aerolink` 默认镜像是 `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink`，用 `--set` 覆盖即可：

```bash
VERSION=$(bash scripts/get-version.sh)

helm upgrade --install aerolink charts/aerolink \
  -n aerolink-system --create-namespace \
  --set image.repository=<registry>/<namespace>/aerolink \
  --set image.tag=$VERSION \
  --set image.pullPolicy=IfNotPresent
```

私有仓库需要拉取凭据：

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

### 仓库内现成的 values 文件

仓库里已经放了一份按镜像仓库写好的 values，直接 `-f` 引用即可：

```bash
# 个人仓库
helm upgrade --install aerolink charts/aerolink -n aerolink-system --create-namespace \
  -f charts/aerolink/examples/swr-gzwxh.yaml
```

### 发布 chart（可选）

```bash
helm package charts/aerolink -d dist
helm push dist/aerolink-1.0.3.tgz oci://<registry>/<namespace>
```

::: warning 华为云 SWR 个人版不接受 Helm OCI 制品
向 SWR 推送 chart 会报 `manifest invalid: Invalid image, fail to parse 'manifest.json'`（SWR 只解析容器镜像清单）。这种情况下直接从仓库目录安装即可：`helm install aerolink charts/aerolink`，或把 `helm package` 生成的 tgz 通过其它渠道分发。
:::

::: warning 生产环境务必设置加密密钥
`AEROLINK_ENCRYPT_KEY` 用于加密用户密码、OAuth clientSecret、kubeconfig 等敏感数据，不设置会使用不安全的默认密钥。可通过 `--set env.AEROLINK_ENCRYPT_KEY=...`（或 chart 对应的 values 字段）注入，详见[环境变量](../config/env.md)。
:::

更多安装选项（Ingress、子路径部署、端口转发、卸载等）见[安装指南](./installation.md)；chart 的全部可配置项见 [Chart Values](../config/chart-values.md)。

## 五、常见问题

**拉取基础镜像失败：`dial tcp ... connection refused` / TLS 超时**

配置镜像加速后重试：

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

**运行时基础镜像拉不下来**

默认取自公司 SWR（`swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/openeuler/openeuler:24.03-lts-sp4`）。若构建机不在公司网络内，可换成公共镜像：
`--build-arg RUNTIME_IMAGE=alpine:3.23.2`（CA 证书与时区数据已由 Dockerfile 从构建镜像拷贝，基座里不需要再装 `ca-certificates`、`tzdata`）。

**构建报 `inconsistent vendoring`**

后端依赖走仓库里的 `vendor/`（构建过程不联网下载 Go 模块）。改过 `go.mod` / 升级依赖后，先在本机跑 `make deps`（`go mod tidy` + `go mod vendor`）并提交 `vendor/` 的变化，再构建即可。这是刻意留的 fail-closed：不一致时直接失败，而不是静默回源慢慢拉。

**pnpm 报 `ERR_PNPM_IGNORED_BUILDS: esbuild`**

Dockerfile 中已写入 `pnpm-workspace.yaml` 明确声明该依赖不需要执行构建脚本（esbuild 自带预编译二进制）。若 pnpm 后续版本改变行为，可临时改用 `pnpm install --frozen-lockfile --dangerously-allow-all-builds`。

**推送报 `Invalid image, fail to parse 'manifest.json'`（华为云 SWR）**

仓库不接受带 attestation 的 manifest index，构建时加上 `--provenance=false --sbom=false`（见「一、构建镜像」的提示）。

**登录报 `denied: Authenticate Error`**

SWR 的用户名是「区域@AK」、密码是 SK，且 AK/SK 可能已轮换；确认用的不是账号密码，并检查该 AK 是否有 SWR 权限。

**界面“关于”里的版本显示 `dev`**

构建时传入 `--build-arg VERSION=$(bash scripts/get-version.sh)`。

**WSL 中 Docker 命令报 `Cannot connect to the Docker daemon`**

确认 WSL 启用了 systemd（`/etc/wsl.conf` 中 `[boot]` 段 `systemd=true`，改完需 `wsl --shutdown` 重启），然后：

```bash
sudo systemctl enable --now docker
docker version     # 应能看到 Server 段
```
