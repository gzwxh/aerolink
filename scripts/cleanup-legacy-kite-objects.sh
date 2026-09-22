#!/usr/bin/env bash
#
# 清理改名前的遗留 Kubernetes 对象（kite → aerolink）。
#
# 为什么需要它：产物改名后，新清单用 aerolink 这套名字与 NodePort 27862，而集群里
# 旧清单留下的对象还在——旧 Service 占着 27862，新清单 apply 会因端口被占而失败；
# 旧 Deployment 还挂着改名前的镜像在跑，容易被误当成新版本。两者都不会自动消失。
#
# 默认**只列不改**（dry-run）：先看清要删什么，确认后再加 -y 真删。
#
# 用法：
#   scripts/cleanup-legacy-kite-objects.sh                 # 看一眼 ns/kite 里的遗留对象
#   scripts/cleanup-legacy-kite-objects.sh -y               # 确认后真删
#   scripts/cleanup-legacy-kite-objects.sh -n aerolink -y   # 旧对象被 apply 到新命名空间时
#   scripts/cleanup-legacy-kite-objects.sh -y --with-pvc    # 连 PVC 一起删（会丢数据！）
#
# 不在本脚本范围内、需要手工处理的：
#   - systemd 单元：旧实例是 kite@<端口>，新单元是 aerolink@.service，两者可并存，
#     必须先把旧实例 disable 掉，否则两个进程会抢同一个端口。迁移步骤见
#     deploy/aerolink@.service 文件头的说明。
#   - 共享环境变量文件：从 /etc/kite/kite.env 迁到 /etc/aerolink/aerolink.env
#     （文件里的旧 KITE_* 变量名仍然生效，但建议换成 AEROLINK_*）。
#   - 本脚本不碰任何数据卷里的文件（parquet 归档、sqlite 库），也不碰数据库。
set -euo pipefail

NAMESPACE="kite"
ASSUME_YES=0
WITH_PVC=0

usage() {
  # 只打印文件头部的连续注释块（跳过 shebang），到第一条非注释行为止。
  awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--namespace)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "❌ -n 需要一个命名空间参数" >&2
        exit 2
      fi
      NAMESPACE="$2"
      shift 2
      ;;
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    --with-pvc)
      WITH_PVC=1
      shift
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      echo "❌ 未知参数：$1" >&2
      usage 2
      ;;
  esac
done

# 缺 kubectl 时直接失败，而不是"看起来删过了"。
if ! command -v kubectl >/dev/null 2>&1; then
  echo "❌ 找不到 kubectl，请先安装并配置好 kubeconfig" >&2
  exit 1
fi

# 旧清单（改名前的 deploy/install*.yaml 与 Helm release）创建的对象名。
LEGACY_OBJECTS=(
  "deployment/kite"
  "service/kite"
  "serviceaccount/kite"
  "secret/kite-secret"
  "secret/kite-config"
  "configmap/kite-config"
)
# 只在这些情况下才动：PVC 里是数据，默认一律不删。
LEGACY_PVCS=(
  "pvc/kite-storage"
  "pvc/kite-audit"
)

found=()
echo "🔍 检查命名空间 ${NAMESPACE} 中的遗留对象（dry-run=$([ "${ASSUME_YES}" -eq 1 ] && echo no || echo yes)）"
for obj in "${LEGACY_OBJECTS[@]}"; do
  # -o name 拿不到东西就是不存在；stderr 里的 NotFound 不必打扰使用者。
  if kubectl get -n "${NAMESPACE}" "${obj}" -o name >/dev/null 2>&1; then
    found+=("${obj}")
    echo "  • 存在：${obj}"
  fi
done

pvc_found=()
for obj in "${LEGACY_PVCS[@]}"; do
  if kubectl get -n "${NAMESPACE}" "${obj}" -o name >/dev/null 2>&1; then
    pvc_found+=("${obj}")
    echo "  • 存在：${obj}（默认保留，删了数据就没了）"
  fi
done

if [ "${#found[@]}" -eq 0 ]; then
  echo "✅ 没有需要清理的遗留对象。"
  exit 0
fi

echo
echo "ℹ️  删掉 service/kite 会一并释放它占用的 NodePort 27862，之后新清单才能 apply 成功。"
echo "ℹ️  删掉 deployment/kite 会停掉仍在跑的改名前的实例。"

if [ "${ASSUME_YES}" -ne 1 ]; then
  echo
  echo "🟡 dry-run：上面这些对象都**没有**被删除。确认无误后加 -y 重新执行。"
  if [ "${#pvc_found[@]}" -gt 0 ] && [ "${WITH_PVC}" -ne 1 ]; then
    echo "   （PVC 也保留着；确实要删再加 --with-pvc，卷内数据会一并丢失。）"
  fi
  exit 0
fi

echo
echo "🧹 开始删除…"
for obj in "${found[@]}"; do
  kubectl delete -n "${NAMESPACE}" "${obj}" --ignore-not-found
done

if [ "${WITH_PVC}" -eq 1 ] && [ "${#pvc_found[@]}" -gt 0 ]; then
  for obj in "${pvc_found[@]}"; do
    echo "⚠️  删除 ${obj}：卷内数据（sqlite 库 / parquet 归档）会一并丢失。"
    kubectl delete -n "${NAMESPACE}" "${obj}" --ignore-not-found
  done
elif [ "${#pvc_found[@]}" -gt 0 ]; then
  echo "ℹ️  PVC 已保留（未给 --with-pvc）：${pvc_found[*]}"
fi

echo
echo "✅ 清理完成。接下来："
echo "   1. kubectl apply -f deploy/install-postgres.yaml（或 install-mysql.yaml / install.yaml，三选一）"
echo "   2. 若宿主机上还跑着旧的 systemd 实例：systemctl disable --now 'kite@*'，"
echo "      再按 deploy/aerolink@.service 文件头的说明启用新单元（同端口）。"
