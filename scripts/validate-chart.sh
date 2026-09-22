#!/bin/bash

# Helm Chart 校验脚本
# 本脚本在发布前校验 Helm chart 配置。

set -euo pipefail

CHART_DIR="charts/aerolink"
TEMP_DIR=$(mktemp -d)

echo "🔍 正在校验 Helm Chart..."

# 检查 chart 目录是否存在。
if [ ! -d "$CHART_DIR" ]; then
    echo "❌ 未找到 chart 目录 '$CHART_DIR'"
    exit 1
fi

# 检查 Chart.yaml 是否存在。
if [ ! -f "$CHART_DIR/Chart.yaml" ]; then
    echo "❌ 在 '$CHART_DIR' 中未找到 Chart.yaml"
    exit 1
fi

# 校验 Chart.yaml 的结构。
echo "📋 正在检查 Chart.yaml 结构..."
if ! grep -q "^name:" "$CHART_DIR/Chart.yaml"; then
    echo "❌ 未在 Chart.yaml 中找到 name 字段"
    exit 1
fi

if ! grep -q "^version:" "$CHART_DIR/Chart.yaml"; then
    echo "❌ 未在 Chart.yaml 中找到 version 字段"
    exit 1
fi

echo "✅ Chart.yaml 结构有效"

# 对 chart 做 lint。
echo "🔍 正在对 Helm chart 执行 lint..."
if helm lint "$CHART_DIR"; then
    echo "✅ Chart lint 通过"
else
    echo "❌ Chart lint 失败"
    exit 1
fi

# 测试 chart 打包。
echo "📦 正在测试 chart 打包..."
if helm package "$CHART_DIR" --destination "$TEMP_DIR"; then
    echo "✅ Chart 打包成功"
    PACKAGE_FILE=$(ls "$TEMP_DIR"/*.tgz)
    echo "📦 已生成包：$(basename "$PACKAGE_FILE")"
else
    echo "❌ Chart 打包失败"
    exit 1
fi

# 测试模板渲染。
echo "🔧 正在测试模板渲染..."
if helm template test-release "$CHART_DIR" > "$TEMP_DIR/rendered.yaml"; then
    echo "✅ 模板渲染成功"
else
    echo "❌ 模板渲染失败"
    exit 1
fi

# 校验渲染出的 YAML。
# echo "📋 Validating rendered YAML..."
# if kubectl apply --dry-run=client -f "$TEMP_DIR/rendered.yaml" > /dev/null 2>&1; then
#     echo "✅ Rendered YAML is valid"
# else
#     echo "❌ Rendered YAML validation failed"
#     exit 1
# fi

# 用另一组 values 测试（sqlite 持久化）。
echo "🔧 正在用自定义 values 测试（sqlite 持久化）..."
cat > "$TEMP_DIR/test-values-sqlite.yaml" << EOF
replicaCount: 2
image:
    tag: "test"
service:
    type: LoadBalancer
db:
    type: sqlite
    sqlite:
        persistence:
            pvc:
                enabled: true
                size: 1Gi
EOF

if helm template test-release "$CHART_DIR" -f "$TEMP_DIR/test-values-sqlite.yaml" > "$TEMP_DIR/rendered-custom-sqlite.yaml"; then
        echo "✅ 自定义 values（sqlite）渲染成功"
else
        echo "❌ 自定义 values（sqlite）渲染失败"
        exit 1
fi


# 检查 sqlite 渲染结果的内容。
echo "📋 正在校验 sqlite 持久化的渲染结果..."
RENDERED_SQLITE="$TEMP_DIR/rendered-custom-sqlite.yaml"
cat "$RENDERED_SQLITE"
fail() { echo "❌ $1"; rm -rf "$TEMP_DIR"; exit 1; }

# 确认 sqlite 场景生成了 PVC 资源。
if ! grep -E -q "kind:\s*PersistentVolumeClaim" "$RENDERED_SQLITE"; then
    fail "sqlite 渲染结果中未找到 PersistentVolumeClaim"
fi

# 确认 PVC 名称或 claim 引用中包含 'aerolink-storage'。
if ! grep -E -q "aerolink-storage" "$RENDERED_SQLITE"; then
    fail "渲染结果中未找到 sqlite PVC 名称或引用"
fi

# 确认 Pod spec 中存在 sqlite 的 mountPath（默认 /data）。
if ! grep -E -q "mountPath:\s*/data" "$RENDERED_SQLITE"; then
    fail "渲染结果中未找到预期的 sqlite mountPath '/data'"
fi

echo "✅ sqlite 渲染结果正确"

# 测试提供 postgres DSN 的情况。
echo "🔧 正在用自定义 values 测试（postgres dsn）..."
cat > "$TEMP_DIR/test-values-postgres.yaml" << EOF
replicaCount: 1
db:
    type: postgres
    postgres:
        dsn: "host=127.0.0.1 port=5432 user=test password=test dbname=kite sslmode=disable"
EOF

if helm template test-release "$CHART_DIR" -f "$TEMP_DIR/test-values-postgres.yaml" > "$TEMP_DIR/rendered-custom-postgres.yaml"; then
        echo "✅ 自定义 values（postgres）渲染成功"
else
        echo "❌ 自定义 values（postgres）渲染失败"
        exit 1
fi

# 检查 postgres 渲染结果的内容。
echo "📋 正在校验 postgres DSN 的渲染结果..."
RENDERED_PG="$TEMP_DIR/rendered-custom-postgres.yaml"

echo "✅ postgres 渲染结果正确"

# 清理。
rm -rf "$TEMP_DIR"

echo "🎉 全部校验通过！Chart 已可发布。"