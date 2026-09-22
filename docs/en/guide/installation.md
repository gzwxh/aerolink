# Installation Guide

This guide provides detailed instructions for installing AeroLink in a Kubernetes environment.

## Prerequisites

- `kubectl` with cluster administrator privileges
- Helm v3.8+ (or v4)
- MySQL/PostgreSQL database, or local storage for sqlite

## Installation Methods

### Method 1: Helm Chart (Recommended)

Using Helm provides flexibility for configuration and upgrades. The in-repo chart already points its default image at the company SWR, so a plain install is enough:

```bash
helm install kite charts/kite -n kite-system --create-namespace
```

#### Custom Installation

You can adjust installation parameters by customizing the values file:

For complete configuration, refer to [Chart Values](../config/chart-values).

Install with custom values:

```bash
helm install kite charts/kite -n kite-system -f values.yaml
```

### Method 2: YAML Manifest

For quick deployment, you can directly apply the installation YAML from the repository:

::: warning
This method is not suitable for production environments, as it does not include any configuration related to persistence. You need to manually mount the persistence volume and set the environment variable `DB_DSN=/data/db.sqlite` to ensure that data is not lost. Alternatively, you can use an external database.

see [Persistence Issues](../faq#persistence-issues) for more details.
:::

```bash
kubectl apply -f deploy/install.yaml
```

This method will install AeroLink with default configuration. For advanced customization, it's recommended to use the Helm Chart.

## Accessing AeroLink

### Port Forwarding (Testing Environment)

During testing, you can quickly access AeroLink through port forwarding:

```bash
kubectl port-forward -n kite-system svc/kite 8080:8080
```

### LoadBalancer Service

If the cluster supports LoadBalancer, you can directly expose the AeroLink service:

```bash
kubectl patch svc kite -n kite-system -p '{"spec": {"type": "LoadBalancer"}}'
```

Get the assigned IP:

```bash
kubectl get svc kite -n kite-system
```

### Ingress (Recommended for Production)

For production environments, it's recommended to expose AeroLink through an Ingress controller with TLS enabled:

::: warning
AeroLink's log and web terminal features require websocket support.
Some Ingress controllers may require additional configuration to handle websockets correctly.
:::

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: kite
  namespace: kite-system
spec:
  ingressClassName: nginx
  rules:
    - host: aerolink.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: kite
                port:
                  number: 8080
  tls:
    - hosts:
        - aerolink.example.com
      secretName: aerolink-tls
```

## Serving under a subpath (basePath)

If you want to serve AeroLink under a subpath (for example `https://example.com/kite`), use the Helm chart `basePath` value.

How to set it:

- In `values.yaml`:

```yaml
basePath: "/kite"
```

- Or with Helm CLI:

```bash
helm install kite charts/kite -n kite-system --create-namespace --set basePath="/kite"
```

Important notes:

- Ingress configuration: make sure your Ingress `paths` match the subpath and use a matching pathType (e.g., `Prefix`). Example:

```yaml
ingress:
  enabled: true
  hosts:
    - host: aerolink.example.com
      paths:
        - path: /kite
          pathType: Prefix
```

- OAuth / redirects: if you enable OAuth (or any external redirect flows), update the redirect URLs in your OAuth provider to include the base path, e.g. `https://aerolink.example.com/kite/oauth/callback`.
- Environment overrides: if you provide environment variables via `extraEnvs` or an existing secret, ensure `AEROLINK_BASE` is set consistently with the `basePath` value (otherwise behavior may differ).

## Verifying Installation

After installation, you can access the dashboard to verify that AeroLink is deployed successfully. The expected interface is as follows:

::: tip
If you need to configure AeroLink through environment variables, please refer to [Environment Variables](../config/env).
:::

![setup](../../screenshots/setup.png)

![setup](../../screenshots/setup2.png)

You can complete cluster setup according to the page prompts.

### Quick Setup with In-Cluster Mode

For the simplest setup, select **`in-cluster`** as the cluster type. This option automatically uses the service account credentials that AeroLink is running with inside the cluster, requiring no additional configuration:

- **No kubeconfig needed**: AeroLink will use its own service account to access the Kubernetes API
- **Automatic authentication**: Works out of the box with the default RBAC permissions
- **Ideal for single-cluster deployments**: Perfect when AeroLink is managing the same cluster it's running in

This is the recommended option for getting started quickly, especially in development or when AeroLink only needs to manage its own cluster.

## Uninstalling AeroLink

### Helm Uninstall

```bash
helm uninstall kite -n kite-system
```

### YAML Uninstall

```bash
kubectl delete -f deploy/install.yaml
```

## Next Steps

After AeroLink installation is complete, you can continue with:

- [Adding Users](../config/user-management)
- [Configuring RBAC](../config/rbac-config)
- [Configuring OAuth Authentication](../config/oauth-setup)
- [Setting up Prometheus Monitoring](../config/prometheus-setup)
