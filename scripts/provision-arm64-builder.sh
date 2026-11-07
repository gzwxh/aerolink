#!/usr/bin/env bash
# arm64（aarch64）构建机一键初始化。
#
# 用途：仓库默认的出镜像路径只产 amd64（`make image` / `make image-binary` 都在 x86 上跑），
# 而带内嵌 DuckDB 引擎的后端**必须原生编译**（`make cross-compile` 出的 bin/aerolink-arm64 是
# `-tags duckdb_cli` 纯 Go 产物，不含引擎）。所以要出 arm64 镜像，就得有一台 ARM 机器。
#
# 在**全新的公有云 ARM 机器**上以 root 执行（机器删除后按本脚本重建，不必重新踩坑）。
# 选机器的唯一硬指标是 glibc：构建机 glibc 必须**不高于**运行基座 openEuler 24.03-lts-sp4（2.38），
# 否则镜像起来报 GLIBC_2.xx not found。本轮用的是 TencentOS Server 4（aarch64 / glibc 2.38）。
#
# 口径、验证清单与踩坑说明见 docs/dev/plans/2026-11-02-ARM构建机与arm64镜像产出.md。
# 下面每一步都在 2026-11-02 实跑验证过；版本号与开发机逐一对齐（go 1.26.6 / node 24.21.0 /
# pnpm 12.3.4 / buildx 0.38.1）—— pnpm 版本不同会改写 lockfile 元数据，别随手升。
set -euo pipefail

GO_VER=1.26.6
NODE_VER=24.21.0
PNPM_VER=12.3.4
BUILDX_VER=0.38.1
SWR=swr.cn-south-1.myhuaweicloud.com
BASE_REPO=gzwxh/docker.io/openeuler/openeuler
BASE_TAG=24.03-lts-sp4-arm64
# 加速站只在 SWR 里还没有 arm64 基座时才用；这类域名失效得勤，不通就换一个试。
BASE_MIRROR=docker.m.daocloud.io/openeuler/openeuler:24.03-lts-sp4

[ "$(uname -m)" = aarch64 ] || { echo "本脚本只能在 aarch64 上执行" >&2; exit 1; }

echo '==> 1/6 工具链（moby 是发行版仓库里的 docker，不带 buildx 插件，第 4 步单独补）'
dnf -y install git gcc gcc-c++ make patch tar xz which moby
systemctl enable --now docker

echo '==> 2/6 Go 与 Node（mirrors.tencent.com / mirrors.huaweicloud.com 没有这些版本，'
echo '    go.dev 直连在这类机器上会 SSL 超时，只有 golang.google.cn 有带宽）'
mkdir -p /opt/dl && cd /opt/dl
curl -fSL --retry 3 -C - -o go.tar.gz "https://golang.google.cn/dl/go${GO_VER}.linux-arm64.tar.gz"
# go1.26.6.linux-arm64 的公布值：d0507e9e9d7fe012aae570108cbd76c15de879e17130ab8cb90d4d7445cb1f2e
curl -fSL --retry 3 -C - -o node.tar.gz \
  "https://registry.npmmirror.com/-/binary/node/v${NODE_VER}/node-v${NODE_VER}-linux-arm64.tar.gz"
tar -C /usr/local -xzf go.tar.gz
tar -C /usr/local -xzf node.tar.gz
mv -f "/usr/local/node-v${NODE_VER}-linux-arm64" /usr/local/node24

echo '==> 3/6 环境变量（写进 profile.d 还不够：构建命令多由 bash -c / ssh 非交互会话发起，'
echo '    不读 /etc/profile，所以调用方要显式 . /etc/profile.d/aerolink-build.sh）'
cat > /etc/profile.d/aerolink-build.sh <<PROF
export PATH=/usr/local/go/bin:/usr/local/node24/bin:\$PATH
export GOROOT=/usr/local/go
export GOPATH=/root/go
export GOPROXY=https://goproxy.cn,direct
PROF
# shellcheck disable=SC1091
. /etc/profile.d/aerolink-build.sh
npm config set registry https://registry.npmmirror.com
npm install -g "pnpm@${PNPM_VER}"

echo '==> 4/6 buildx 插件（缺它则 docker build 落到 legacy builder，本仓库必带的'
echo '    --provenance=false --sbom=false 会报 unknown flag: --provenance；发行版仓库没有这个包）'
mkdir -p /usr/lib/docker/cli-plugins
curl -fSL --retry 3 -o /usr/lib/docker/cli-plugins/docker-buildx \
  "https://github.com/docker/buildx/releases/download/v${BUILDX_VER}/buildx-v${BUILDX_VER}.linux-arm64"
chmod 0755 /usr/lib/docker/cli-plugins/docker-buildx

echo "==> 5/6 运行基座（SWR 里不带 -arm64 后缀的 ${BASE_REPO} tag 是单架构 amd64 manifest，"
echo '    加 --platform 也只会回落成 amd64 层，所以要么已推过 -arm64 tag，要么从加速站补一份）'
if docker pull --platform linux/arm64 "${SWR}/${BASE_REPO}:${BASE_TAG}" >/dev/null 2>&1; then
  echo "    SWR 已有 ${BASE_TAG}，无需补"
else
  docker pull --platform linux/arm64 "${BASE_MIRROR}"
  docker tag "${BASE_MIRROR}" "${SWR}/${BASE_REPO}:${BASE_TAG}"
  echo "    需先 docker login ${SWR}，再执行："
  echo "      docker push ${SWR}/${BASE_REPO}:${BASE_TAG}"
fi

echo '==> 6/6 自检'
go version
node -v
pnpm -v
gcc --version | head -1
docker buildx version
docker info --format 'docker={{.Server.Version}} arch={{.Server.Arch}}'
cat <<'NEXT'
✅ 构建机就绪。下一步（代码以内网开发机为准，构建机只留一份 rsync 工作副本）：

  # 开发机上（vendor/ 872M 必须带上，镜像与本机构建都靠它离线取依赖；约 1.0GB / 50 秒）
  rsync -a --whole-file \
    --exclude 'node_modules/' --exclude '.vite/' --exclude 'ui/dist/' \
    --exclude 'docs/node_modules/' --exclude 'docs/.vitepress/cache/' --exclude 'docs/.vitepress/dist/' \
    --exclude '/aerolink' --exclude '/aerolink.bak-*' --exclude '/dev.db*' --exclude '/data.txt' \
    --exclude '/dist/' --exclude '/bin/golangci-lint' --exclude 'e2e/test-results/' \
    --exclude 'e2e/playwright-report/' --exclude 'e2e/.auth/' --exclude '/Makefile.local' \
    ./ <构建机>:/root/aerolink

  # 构建机上（VERSION 要与 IMAGE 的 tag 对齐，否则界面版本与镜像名对不上）
  # 注：这条路只在**原生 ARM 机器**上成立（CGO + 内嵌 DuckDB 引擎）；
  # Dockerfile.binary 不再接受 RUNTIME_IMAGE 参数，基座默认解析到 SWR 那个单架构 amd64 tag，
  # 而 ARM 机器自带 qemu-user-static 能模拟 RUN 步，所以仍可用（已实测）。
  # 只想在 x86 上出 arm64（不带内嵌引擎）的话不需要这台机器，用 `make push-arm`。
  . /etc/profile.d/aerolink-build.sh && cd /root/aerolink
  make push-binary GOARCH=arm64 IMAGE=swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:<版本>-arm64

  # 机器不用了就删；删之前把 SWR 登录凭据从 /root/.docker/config.json 清掉，并轮换该密钥
NEXT
