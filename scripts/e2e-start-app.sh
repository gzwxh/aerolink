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
export DISABLE_VERSION_CHECK=true
# The server refuses to start with a JWT secret shorter than 32 bytes, so the
# e2e defaults are long enough to pass the startup checks.
export JWT_SECRET="${JWT_SECRET:-kite-e2e-jwt-secret-0123456789abcdef}"
export KITE_ENCRYPT_KEY="${KITE_ENCRYPT_KEY:-kite-e2e-encryption-key-0123456789abcdef}"
export PORT
export HOME="${KITE_E2E_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/kite-e2e-home.XXXXXX")}"
unset KITE_USERNAME
unset KITE_PASSWORD
unset KUBECONFIG

exec ./kite -v 3
