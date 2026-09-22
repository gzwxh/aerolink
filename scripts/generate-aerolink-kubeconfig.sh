#!/bin/bash

set -e

NAMESPACE="${NAMESPACE:-kube-system}"
SA_NAME="${SA_NAME:-aerolink-admin}"
SECRET_NAME="${SECRET_NAME:-${SA_NAME}-token}"
OUTPUT_FILE="${OUTPUT_FILE:-aerolink-kubeconfig.yaml}"

cleanup() {
    echo "======================================"
    echo "鸢联 AeroLink 资源清理"
    echo "======================================"
    echo ""
    echo "将删除以下资源："
    echo "  - ClusterRoleBinding: $SA_NAME"
    echo "  - Secret: $SECRET_NAME (namespace: $NAMESPACE)"
    echo "  - ServiceAccount: $SA_NAME (namespace: $NAMESPACE)"
    echo ""
    read -p "是否继续？(y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi

    echo ""
    echo "正在删除 ClusterRoleBinding..."
    kubectl delete clusterrolebinding "$SA_NAME" --ignore-not-found=true

    echo "正在删除 Secret..."
    kubectl delete secret "$SECRET_NAME" -n "$NAMESPACE" --ignore-not-found=true

    echo "正在删除 ServiceAccount..."
    kubectl delete sa "$SA_NAME" -n "$NAMESPACE" --ignore-not-found=true

    echo ""
    echo "======================================"
    echo "✅ 清理完成！"
    echo "======================================"
    echo ""
}

create() {
    echo "======================================"
    echo "鸢联 AeroLink Kubeconfig 生成器"
    echo "======================================"
    echo ""
    echo "本脚本会创建一个 Service Account，并生成一份可供鸢联 AeroLink 使用的"
    echo "kubeconfig（无需 exec 插件）。"
    echo ""
    echo "配置："
    echo "  命名空间：    $NAMESPACE"
    echo "  SA 名称：     $SA_NAME"
    echo "  Secret 名称： $SECRET_NAME"
    echo "  输出文件：    $OUTPUT_FILE"
    echo ""
    read -p "是否继续？(y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi

echo ""
echo "步骤 1：正在创建 Service Account..."
kubectl create sa "$SA_NAME" -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo "步骤 2：正在创建 ClusterRoleBinding..."
cat <<EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: $SA_NAME
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: $SA_NAME
  namespace: $NAMESPACE
EOF

echo "步骤 3：正在创建长期有效的 Token Secret..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: $SECRET_NAME
  namespace: $NAMESPACE
  annotations:
    kubernetes.io/service-account.name: $SA_NAME
type: kubernetes.io/service-account-token
EOF

echo "步骤 4：正在等待 token 写入..."
for i in {1..30}; do
    if kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" -o jsonpath='{.data.token}' 2>/dev/null | grep -q .; then
        break
    fi
    if [ $i -eq 30 ]; then
        echo "错误：30 秒后 secret 中的 token 仍未写入"
        exit 1
    fi
    sleep 1
done

echo "步骤 5：正在提取凭据..."
TOKEN=$(kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" -o jsonpath='{.data.token}' | base64 -d)
CA_CERT=$(kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" -o jsonpath='{.data.ca\.crt}')
API_SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CLUSTER_NAME=$(kubectl config view --minify -o jsonpath='{.clusters[0].name}')

if [ -z "$API_SERVER" ]; then
    echo "错误：无法从当前上下文确定 API server 地址"
    exit 1
fi

echo "步骤 6：正在生成 kubeconfig..."
cat > "$OUTPUT_FILE" <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${CA_CERT}
    server: ${API_SERVER}
  name: ${CLUSTER_NAME}
contexts:
- context:
    cluster: ${CLUSTER_NAME}
    user: ${SA_NAME}
  name: ${SA_NAME}@${CLUSTER_NAME}
current-context: ${SA_NAME}@${CLUSTER_NAME}
users:
- name: ${SA_NAME}
  user:
    token: ${TOKEN}
EOF

echo ""
echo "======================================"
echo "✅ 成功！"
echo "======================================"
echo ""
echo "kubeconfig 已保存到：$OUTPUT_FILE"
echo ""
echo "现在可以用该文件把集群添加到鸢联 AeroLink："
echo "  1. 复制 $OUTPUT_FILE 的内容"
echo "  2. 在鸢联 AeroLink 界面中进入「系统设置 → 集群管理 → 添加集群」"
echo "  3. 粘贴 kubeconfig 内容"
echo ""
echo "验证 kubeconfig："
echo "  kubectl --kubeconfig=$OUTPUT_FILE get nodes"
echo ""
}

show_usage() {
    cat <<EOF
用法：$0 [COMMAND]

命令：
  create    创建 Service Account 并生成 kubeconfig（默认）
  cleanup   删除已创建的全部资源（SA、Secret、ClusterRoleBinding）
  help      显示本帮助信息

环境变量：
  NAMESPACE     Kubernetes 命名空间（默认：kube-system）
  SA_NAME       Service Account 名称（默认：aerolink-admin）
  SECRET_NAME   Secret 名称（默认：aerolink-admin-token）
  OUTPUT_FILE   输出的 kubeconfig 文件（默认：aerolink-kubeconfig.yaml）

示例：
  # 使用默认值创建资源
  $0 create

  # 使用自定义命名空间创建
  NAMESPACE=my-namespace $0 create

  # 清理资源
  $0 cleanup

  # 使用自定义名称清理
  SA_NAME=my-sa NAMESPACE=my-namespace $0 cleanup

EOF
}

COMMAND="${1:-create}"

case "$COMMAND" in
    create)
        create
        ;;
    cleanup)
        cleanup
        ;;
    help|--help|-h)
        show_usage
        ;;
    *)
        echo "错误：未知命令 '$COMMAND'"
        echo ""
        show_usage
        exit 1
        ;;
esac
