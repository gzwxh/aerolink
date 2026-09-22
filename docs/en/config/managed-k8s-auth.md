---
title: Managed Kubernetes Cluster Configuration
---

# Managed Kubernetes Cluster Configuration

## Problem Description

Managed Kubernetes clusters like AKS (Azure Kubernetes Service), EKS (Amazon Elastic Kubernetes Service), etc., typically use `exec` plugins in their default kubeconfig to dynamically obtain authentication credentials. For example:

- **AKS** uses the `kubelogin` command
- **EKS** uses the `aws` CLI
- **GKE** uses the `gcloud` command

This authentication method works well in local client environments, but fails in server-side environments like AeroLink because:

1. These CLI tools may not be installed on the server
2. Even if installed, the server environment may not have the corresponding authentication configuration
3. Managing different user credentials in multi-tenant scenarios is difficult

### Using Service Account Token

Create a dedicated Service Account for AeroLink and use its token for authentication.

AeroLink ships a helper script, `scripts/generate-aerolink-kubeconfig.sh` (self-contained, it only needs `kubectl`, so you can copy it to the target machine):

```sh
chmod +x scripts/generate-aerolink-kubeconfig.sh
./scripts/generate-aerolink-kubeconfig.sh
```

It creates `kube-system/aerolink-admin` (the ServiceAccount and the ClusterRoleBinding share the name), the `aerolink-admin-token` Secret, and writes `aerolink-kubeconfig.yaml`. The namespace and names can be overridden with `NAMESPACE` / `SA_NAME` / `SECRET_NAME` / `OUTPUT_FILE`; the `cleanup` subcommand removes everything it created.

#### Steps:

1. Create Service Account and necessary RBAC permissions:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: aerolink-admin
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: aerolink-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: aerolink-admin
    namespace: kube-system
```

2. Create Long-lived Token Secret (Kubernetes 1.24+):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: aerolink-admin-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: aerolink-admin
type: kubernetes.io/service-account-token
```

3. Get token and cluster information:

```bash
# Get token
TOKEN=$(kubectl get secret aerolink-admin-token -n kube-system -o jsonpath='{.data.token}' | base64 -d)

# Get CA certificate
CA_CERT=$(kubectl get secret aerolink-admin-token -n kube-system -o jsonpath='{.data.ca\.crt}')

# Get API Server address
API_SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
```

4. Generate kubeconfig:

```bash
cat > aerolink-kubeconfig.yaml <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${CA_CERT}
    server: ${API_SERVER}
  name: aerolink-cluster
contexts:
- context:
    cluster: aerolink-cluster
    user: aerolink-admin
  name: aerolink-context
current-context: aerolink-context
users:
- name: aerolink-admin
  user:
    token: ${TOKEN}
EOF
```

## Related Documentation

- [Kubernetes Service Account Tokens](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/)
- [AKS Authentication](https://learn.microsoft.com/en-us/azure/aks/control-kubeconfig-access)
- [EKS Authentication](https://docs.aws.amazon.com/eks/latest/userguide/cluster-auth.html)
- [GKE Authentication](https://cloud.google.com/kubernetes-engine/docs/how-to/api-server-authentication)
