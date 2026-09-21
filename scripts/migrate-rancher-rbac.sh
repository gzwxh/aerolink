#!/bin/bash
# 把 Rancher 的项目 / 集群授权迁移成 Kite 的权限绑定组。
#
# 这个脚本只是入口，真正的实现是 tools/rancherrbac（Go），优先用编译好的二进制，
# 找不到才回退到 go run（开发机）。默认只读（dry-run），打印计划不写库；确认无误后加 -apply。
#
# 推荐用配置文件（可拷到别的环境单独跑，不依赖本仓库）：
#   rancherrbac -init-config rancherrbac.yaml     # 生成模板，填好地址与密钥
#   rancherrbac -config rancherrbac.yaml          # 看计划
#   rancherrbac -config rancherrbac.yaml -apply   # 落库
#
# 也可以全部走命令行 / 环境变量：
#   export RANCHER_URL=https://rancher.example.com
#   export RANCHER_TOKEN='token-xxxxx:yyyyy'
#   export KITE_URL=https://kite.example.com
#   export KITE_TOKEN='kite1-xxxxxxxx'
#
#   scripts/migrate-rancher-rbac.sh -cluster-map c-m-abc123=prod        # 看计划
#   scripts/migrate-rancher-rbac.sh -cluster-map c-m-abc123=prod -apply # 落库
#   scripts/migrate-rancher-rbac.sh -help                              # 全部参数
#
# 取值优先级：命令行 > 环境变量 > 配置文件 > 默认值。
# 编译独立可执行文件：scripts/build-rancherrbac.sh（见 tools/rancherrbac/README.md）。
# 迁移口径与取舍见 docs/dev/plans/2026-09-21-rancher-rbac-migration.md。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 已经编译好的二进制优先：这样在没装 Go、甚至没有本仓库的环境里也能用（把二进制和
# 配置文件放一起即可）。RANCHERRBAC_BIN 可以显式指定路径。
BINARY="${RANCHERRBAC_BIN:-}"
if [ -z "$BINARY" ]; then
  for candidate in "${ROOT_DIR}/bin/rancherrbac" "${ROOT_DIR}/tools/rancherrbac/rancherrbac"; do
    if [ -x "$candidate" ]; then
      BINARY="$candidate"
      break
    fi
  done
fi

if [ -n "$BINARY" ]; then
  exec "$BINARY" "$@"
fi

if ! command -v go >/dev/null 2>&1; then
  echo "❌ 既没有编译好的 ${ROOT_DIR}/bin/rancherrbac，也没有 go 命令。" >&2
  echo "   先跑 scripts/build-rancherrbac.sh 生成二进制，或用 RANCHERRBAC_BIN 指定路径。" >&2
  exit 1
fi

exec go run "${ROOT_DIR}/tools/rancherrbac" "$@"
