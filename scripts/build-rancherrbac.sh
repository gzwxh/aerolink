#!/bin/bash
# 把授权迁移工具打成单个可执行文件，方便拷到别的环境里跑（目标机不需要 Go，也不需要本仓库）。
#
# 产物只依赖标准库与 gopkg.in/yaml.v3，CGO_ENABLED=0 静态链接，没有其它运行时依赖。
#
# 用法：
#   scripts/build-rancherrbac.sh                  # 只构建当前平台 → bin/rancherrbac
#   scripts/build-rancherrbac.sh -p linux-amd64   # 追加一个平台（可重复）
#   scripts/build-rancherrbac.sh -a               # 构建全部登记的平台并打包
#
# 环境变量：
#   BIN_DIR   产物目录，默认 <仓库>/bin
#   VERSION   版本号，写进二进制；默认取 git describe --tags --always
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${BIN_DIR:-${ROOT_DIR}/bin}"
OUT_NAME="rancherrbac"
VERSION="${VERSION:-$(cd "$ROOT_DIR" && git describe --tags --always 2>/dev/null || echo dev)}"

# 登记的平台与 Makefile 的 cross-compile 口径一致，覆盖典型 Linux 服务器与两种 Mac。
PLATFORMS=(
  "linux-amd64"
  "linux-arm64"
  "darwin-amd64"
  "darwin-arm64"
  "windows-amd64"
)

usage() {
  cat <<'EOF'
把授权迁移工具打成单个可执行文件。

用法：
  scripts/build-rancherrbac.sh                  # 只构建当前平台 → bin/rancherrbac
  scripts/build-rancherrbac.sh -p linux-amd64   # 追加一个平台（可重复）
  scripts/build-rancherrbac.sh -a               # 构建全部登记的平台并打包

环境变量：
  BIN_DIR   产物目录，默认 <仓库>/bin
  VERSION   版本号，写进二进制；默认取 git describe --tags --always
EOF
}

targets=()
package_all=false

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--platform)
      [ $# -ge 2 ] || { echo "❌ -p 后面要跟平台名，例如 linux-amd64" >&2; exit 1; }
      targets+=("$2")
      shift 2
      ;;
    -a|--all)
      package_all=true
      targets+=("${PLATFORMS[@]}")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ 未知参数：$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# 没指定平台时只构建当前平台。
if [ ${#targets[@]} -eq 0 ]; then
  targets=("$(go env GOOS)-$(go env GOARCH)")
fi

host_target="$(go env GOOS)-$(go env GOARCH)"
mkdir -p "$BIN_DIR"
# 统一成绝对路径：循环里会 cd 到仓库根目录构建，相对的 BIN_DIR 会算错位置。
BIN_DIR="$(cd "$BIN_DIR" && pwd)"

for target in "${targets[@]}"; do
  case "$target" in
    *-*) ;;
    *) echo "❌ 平台名要写成 <系统>-<架构>，例如 linux-amd64；收到：$target" >&2; exit 1 ;;
  esac

  goos="${target%%-*}"
  goarch="${target##*-}"

  # 当前平台的产物用不带平台后缀的名字（便于直接 ./rancherrbac 跑），其余的带后缀避免互相覆盖。
  if [ "$target" = "$host_target" ]; then
    output="${BIN_DIR}/${OUT_NAME}"
  else
    output="${BIN_DIR}/${OUT_NAME}-${goos}-${goarch}"
  fi
  # Windows 产物带 .exe，方便拷到目标机直接跑。
  if [ "$goos" = "windows" ]; then
    output="${output}.exe"
  fi

  echo "🏗️  构建 ${goos}/${goarch} → ${output}"
  cd "$ROOT_DIR"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w -X main.buildVersion=${VERSION}" \
      -o "$output" ./tools/rancherrbac
done

# 打包成「二进制 + 说明」的一个目录：拷过去解压、用 -init-config 生成配置就能跑。
if [ "$package_all" = true ]; then
  package_dir="rancherrbac-${VERSION}"
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  mkdir -p "${stage}/${package_dir}"

  for file in "${BIN_DIR}"/${OUT_NAME}*; do
    [ -f "$file" ] || continue
    case "$file" in
      *.tar.gz|*.zip) continue ;;
    esac
    cp "$file" "${stage}/${package_dir}/"
  done

  # 说明文档跟着产物走：目标机上没有本仓库，用法只能靠它。
  if [ -f "${ROOT_DIR}/tools/rancherrbac/README.md" ]; then
    cp "${ROOT_DIR}/tools/rancherrbac/README.md" "${stage}/${package_dir}/README.md"
  fi

  ( cd "$stage" && tar -czf "${BIN_DIR}/${package_dir}.tar.gz" "${package_dir}" )
  if command -v zip >/dev/null 2>&1; then
    ( cd "$stage" && zip -qr "${BIN_DIR}/${package_dir}.zip" "${package_dir}" )
  fi
  echo "📦 打包完成：${BIN_DIR}/${package_dir}.tar.gz"
fi

echo "✅ 完成。目标机上先跑 ./${OUT_NAME} -init-config rancherrbac.yaml 生成配置，再用 -config 使用。"
