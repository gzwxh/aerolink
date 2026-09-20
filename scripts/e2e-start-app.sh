#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${KITE_E2E_PORT:-38080}"
if [ -n "${KITE_E2E_DB_PATH:-}" ]; then
  DB_PATH="${KITE_E2E_DB_PATH}"
else
  DB_PATH="$(mktemp "${TMPDIR:-/tmp}/kite-e2e.XXXXXX")"
fi

cd "${ROOT_DIR}"

rm -f "${DB_PATH}"

make build

export DB_TYPE=sqlite
export DB_DSN="${DB_PATH}"
# 服务端在 JWT secret 短于 32 字节时会拒绝启动，因此这里的 e2e 默认值
# 足够长，能通过启动检查。
export JWT_SECRET="${JWT_SECRET:-kite-e2e-jwt-secret-0123456789abcdef}"
export KITE_ENCRYPT_KEY="${KITE_ENCRYPT_KEY:-kite-e2e-encryption-key-0123456789abcdef}"
export PORT
export HOME="${KITE_E2E_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/kite-e2e-home.XXXXXX")}"
unset KITE_USERNAME
unset KITE_PASSWORD
unset KUBECONFIG

exec ./kite -v 3
