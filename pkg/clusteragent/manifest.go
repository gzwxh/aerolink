package clusteragent

import (
	"fmt"
	"strings"
)

// GenerateManifest 构造用于在目标集群中部署 Cluster Agent 的
// Kubernetes manifest（Secret、ServiceAccount、
// ClusterRoleBinding、Deployment）。镜像与服务器 URL 会被注入，
// 因此 manifest 始终与平台配置保持一致。
func GenerateManifest(serverURL, token, publicKey, image string) string {
	serverURL = strings.TrimSpace(serverURL)
	token = strings.TrimSpace(token)
	publicKey = strings.TrimSpace(publicKey)
	image = strings.TrimSpace(image)
	// 对字符串值做 JSON 编码，这样无论是否含特殊字符，
	// YAML 都始终合法。
	tokenJSON := fmt.Sprintf("%q", token)
	publicKeyJSON := fmt.Sprintf("%q", publicKey)
	serverJSON := fmt.Sprintf("%q", serverURL)
	imageJSON := fmt.Sprintf("%q", image)
	tokenHashJSON := fmt.Sprintf("%q", tokenHash(token))
	return fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: aerolink-cluster-agent-token
  namespace: kube-system
type: Opaque
stringData:
  token: %s
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: aerolink-cluster-agent
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: aerolink-cluster-agent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: aerolink-cluster-agent
    namespace: kube-system
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aerolink-cluster-agent
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: aerolink-cluster-agent
  template:
    metadata:
      annotations:
        aerolink.kubernetes.io/cluster-agent-token-hash: %s
      labels:
        app.kubernetes.io/name: aerolink-cluster-agent
    spec:
      serviceAccountName: aerolink-cluster-agent
      containers:
        - name: cluster-agent
          image: %s
          command:
            - /app/aerolink
          args:
            - cluster-agent
            - --server=$(AEROLINK_SERVER)
            - --token=$(CLUSTER_AGENT_TOKEN)
            - --public-key=$(CLUSTER_AGENT_PUBLIC_KEY)
          env:
            - name: AEROLINK_SERVER
              value: %s
            - name: CLUSTER_AGENT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: aerolink-cluster-agent-token
                  key: token
            - name: CLUSTER_AGENT_PUBLIC_KEY
              value: %s
`, tokenJSON, tokenHashJSON, imageJSON, serverJSON, publicKeyJSON)
}
