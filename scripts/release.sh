#!/bin/bash

set -euo pipefail

# 发布脚本：bump Helm chart 版本号 → 提交 → 打 tag。
#
# 用法：scripts/release.sh <version> [chart-dir]
#   version    目标版本号（不带前缀，例如 1.0.0）
#   chart-dir  Helm chart 目录，默认 charts/aerolink
#
# 可用环境变量覆盖：CHART_DIR、TAG_PREFIX（默认 v）。

version="${1:-}"
CHART_DIR="${2:-${CHART_DIR:-charts/aerolink}}"
TAG_PREFIX="${TAG_PREFIX:-v}"

if [ -z "$version" ]; then
  echo "❌ 缺少版本号参数。"
  echo "用法：$0 <version> [chart-dir]"
  exit 1
fi

if [ ! -f "$CHART_DIR/Chart.yaml" ]; then
  echo "❌ 未找到 Chart 文件：$CHART_DIR/Chart.yaml"
  exit 1
fi

# 打 tag 前要求工作区干净，避免把无关改动混进 release 提交。
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 工作区不干净，请先提交或暂存改动。"
  git status --short
  exit 1
fi

current_version=$(grep '^version:' "$CHART_DIR/Chart.yaml" | awk '{print $2}')

echo "🚀 正在将 Helm Chart 版本 $current_version 发布为 $version..."

if command -v gsed >/dev/null 2>&1; then
  SED_CMD=gsed
else
  SED_CMD=sed
fi

$SED_CMD -i "s/$current_version/$version/g" "$CHART_DIR/Chart.yaml"
$SED_CMD -i "s/$current_version/$version/g" "$CHART_DIR/README.md"

git add "$CHART_DIR/Chart.yaml" "$CHART_DIR/README.md"
git commit -m "release $TAG_PREFIX$version"
git tag -a "$TAG_PREFIX$version" -m "version $version"
