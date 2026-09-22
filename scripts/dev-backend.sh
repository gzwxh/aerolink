#!/usr/bin/env bash
#
# 后端热重载：轮询 Go 源码与已构建的前端产物，发现改动就重新编译并重启服务。
#
# 为什么要轮询：inotifywait / fswatch / entr / air 都需要额外安装系统工具，而开发环境
# （WSL、macOS、容器）不一定有。轮询没有依赖，代价是改动后约 1 秒生效（可用
# AEROLINK_DEV_WATCH_INTERVAL 调整）。前端的热更新由 vite 负责，这里只管后端。
#
# 为什么也盯 static/：前端资源是通过 //go:embed 编进二进制的，跑在 :8080 上的服务
# 不会自动看到 `make frontend` 的产物。把 static/ 纳入监听后，构建完前端（约 1 秒）
# 后端就会自己重启，浏览器刷新即可，不必手动停起进程。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

BINARY_NAME="${BINARY_NAME:-aerolink}"
INTERVAL="${AEROLINK_DEV_WATCH_INTERVAL:-1}"
read -r -a RUN_ARGS <<< "${AEROLINK_DEV_RUN_ARGS:--v=5}"

# 本地开发环境变量（存在时）：与 Makefile 的 LOAD_DEV_ENV 行为一致。
DEV_ENV="${DEV_ENV:-dev.env}"
if [ -f "${DEV_ENV}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${DEV_ENV}"
  set +a
fi

log() { printf '\033[36m[dev-backend]\033[0m %s\n' "$*"; }

backend_pid=""
stamp=""

stop_backend() {
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
    wait "${backend_pid}" 2>/dev/null || true
  fi
  backend_pid=""
}

cleanup() {
  stop_backend
  if [ -n "${stamp}" ]; then
    rm -f "${stamp}"
  fi
}
trap cleanup EXIT INT TERM

start_backend() {
  # 编译到 bin/（已被 .gitignore 忽略）再 mv 到位：
  #   - 直接写同名文件时，正在运行的旧进程会让 go build 撞上 ETXTBSY；
  #   - rename(2) 只替换目录项，旧 inode 继续被运行中的进程持有，
  #     因此可以先编译再停服务，停机时间就是一次进程启动。
  if ! make --no-print-directory backend BINARY_NAME=bin/"${BINARY_NAME}"-dev; then
    log "编译失败，等待下一次改动…"
    return 1
  fi
  mv -f bin/"${BINARY_NAME}"-dev "${BINARY_NAME}"
  stop_backend
  ./"${BINARY_NAME}" "${RUN_ARGS[@]}" &
  backend_pid=$!
  log "后端已重启（pid ${backend_pid}）"
}

# 变更检测用「比标记文件更新」的语义（POSIX find 的 -newer），比逐文件比对
# 内容或哈希便宜得多，也不需要 GNU 的 -printf。
stamp="$(mktemp)"
touch "${stamp}"

start_backend

log "监听 Go 源码与 static/ 产物改动（每 ${INTERVAL}s 检查一次）…"
while true; do
  sleep "${INTERVAL}"
  changed="$(find . -type f \
    \( -name '*.go' -o -path './static/*' \) \
    -not -path './vendor/*' \
    -not -path './ui/*' \
    -not -path './bin/*' \
    -not -path './e2e/*' \
    -not -path './.git/*' \
    -newer "${stamp}" -print -quit)"
  if [ -n "${changed}" ]; then
    touch "${stamp}"
    log "检测到改动：${changed}"
    start_backend || true
  fi
done
