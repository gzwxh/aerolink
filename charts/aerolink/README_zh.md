# aerolink

![Version: 1.0.0](https://img.shields.io/badge/Version-1.0.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: v1.0.0](https://img.shields.io/badge/AppVersion-v1.0.0-informational?style=flat-square)

Kubernetes Dashboard —— 鸢联 AeroLink 的 Helm Chart。

**中文** · [English](./README.md)

## 安装

### 方式一：从仓库内的 chart 安装

chart 的默认镜像就是公司 SWR 的 `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink`，直接安装即可：

```bash
# 推荐安装到 aerolink-system 命名空间
helm install aerolink charts/aerolink -n aerolink-system --create-namespace
```

### 方式二：使用本仓库的 chart 配合自建镜像

```bash
# 个人仓库镜像
helm upgrade --install aerolink charts/aerolink -n aerolink-system --create-namespace \
  -f charts/aerolink/examples/swr-gzwxh.yaml
```

镜像的构建与推送（含国内网络下的基础镜像、npm / Go 依赖源参数，以及 Docker Hub、gcr.io 不通时的处理）见[构建并推送鸢联 AeroLink 镜像](../../docs/guide/build-and-push-image.md)。

> **提示**：华为云 SWR 个人版不接受 Helm OCI 制品（`helm push` 会报 `manifest invalid: Invalid image, fail to parse 'manifest.json'`），因此自建 chart 建议直接从仓库目录安装（`helm install aerolink charts/aerolink`），或用 `helm package` 生成 tgz 后通过其它渠道分发。

### 升级

```bash
helm upgrade aerolink charts/aerolink -n aerolink-system
```

### 卸载

```bash
helm uninstall aerolink -n aerolink-system
```

## 常用配置

| 参数                                                       | 说明                                                     | 默认值                        |
| ---------------------------------------------------------- | -------------------------------------------------------- | ----------------------------- |
| `image.repository`                                         | 镜像仓库                                                 | `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink`       |
| `image.tag`                                                | 镜像标签，留空时使用 chart 的 `appVersion`               | `""`                          |
| `imagePullSecrets`                                         | 私有镜像仓库的拉取凭据                                   | `[]`                          |
| `replicaCount`                                             | 副本数（使用 SQLite 时请保持 1）                         | `1`                           |
| `encryptKey`                                               | 敏感数据加密密钥（加密密码、OAuth clientSecret、kubeconfig），生产环境必须修改 | 不安全的默认值 |
| `basePath`                                                 | 子路径部署，例如 `/aerolink`                                 | `""`                          |
| `service.type` / `service.port`                            | Service 类型与端口                                       | `ClusterIP` / `8080`          |
| `ingress.enabled` / `ingress.className` / `ingress.hosts`  | Ingress 开关、类名与域名                                 | `false` / `nginx` / `aerolink.gogdev.cn` |
| `gateway.enabled`                                          | 使用 Gateway API 暴露（需集群已安装 Gateway API CRD）    | `false`                       |
| `db.type`                                                  | 数据库类型：`sqlite` / `mysql` / `postgres`              | `sqlite`                      |
| `db.dsn`                                                   | MySQL / Postgres 的 DSN，`db.type` 非 sqlite 时必填      | `""`                          |
| `db.sqlite.persistence.pvc.enabled`                        | 为 SQLite 数据文件创建 PVC（生产建议开启）               | `false`                       |
| `db.sqlite.persistence.mountPath` / `filename`             | 容器内挂载路径与数据库文件名                             | `/data` / `aerolink.db`           |
| `config.enabled`                                           | 启用 YAML 配置文件模式（集群 / OAuth / LDAP / RBAC 由文件托管，界面中对应区块只读） | `false` |
| `config.existingSecret`                                    | 已有的 Secret 名称（内含 `config.yaml` 键），推荐使用     | `""`                          |
| `rbac.create`                                              | 创建 chart 自带的 RBAC 资源                              | `true`                        |
| `serviceAccount.create` / `serviceAccount.automount`       | 创建 ServiceAccount / 自动挂载 API 凭据                  | `true` / `true`               |

完整参数表见 [Chart Values](../../docs/config/chart-values.md)。

### 启用持久化（SQLite）

```yaml
db:
  sqlite:
    persistence:
      pvc:
        enabled: true
        size: 1Gi
```

> 使用 ReadWriteOnce 的 PVC 时，`deploymentStrategy.type` 需要设置为 `Recreate`，否则滚动更新会因多个 Pod 同时挂载同一卷而卡住。

### 配置文件模式与 LDAP 自动同步

`config.enabled=true` 时，集群、OAuth、LDAP、RBAC 均可由 `config.yaml` 托管：

```yaml
config:
  enabled: true
  ldap:
    enabled: true
    serverUrl: "ldaps://ldap.example.com:636"
    bindDn: "cn=svc-aerolink,ou=services,dc=example,dc=com"
    bindPassword: "bind-password"
    userBaseDn: "ou=users,dc=example,dc=com"
    groupBaseDn: "ou=groups,dc=example,dc=com"
    autoSync: true # 定期同步目录用户（默认开启）
    syncIntervalMinutes: 10 # 同步间隔（分钟，默认 10）
```

`config.ldap` 支持 `enabled`、`serverUrl`、`useStartTLS`、`bindDn`、`bindPassword`、`userBaseDn`、`userFilter`、`usernameAttribute`、`displayNameAttribute`、`groupBaseDn`、`groupFilter`、`groupNameAttribute`、`autoSync`、`syncIntervalMinutes`，字段含义见[配置文件](../../docs/config/config-file.md)。

### 私有仓库拉取凭据

```bash
kubectl create secret docker-registry swr-gzwxh -n aerolink-system \
  --docker-server=swr.cn-south-1.myhuaweicloud.com \
  --docker-username='cn-south-1@<AK>' \
  --docker-password='<SK>'
```

安装时引用：`--set imagePullSecrets[0].name=swr-gzwxh`。

## 本地校验与打包

```bash
helm lint charts/aerolink
helm template aerolink charts/aerolink -f charts/aerolink/examples/swr-gzwxh.yaml | head
helm package charts/aerolink -d dist
```

## 相关文档

- [安装指南](../../docs/guide/installation.md)
- [Chart Values 全量参数](../../docs/config/chart-values.md)
- [构建并推送鸢联 AeroLink 镜像](../../docs/guide/build-and-push-image.md)
- [配置文件（config.yaml）](../../docs/config/config-file.md)
- [环境变量](../../docs/config/env.md)
- [常见问题](../../docs/faq.md)

## 版本分发（当前：压缩包形式）

公司尚未搭建 Helm 仓库，当前版本以 **`.tgz` 压缩包** 形式分发，随仓库一起维护：

- 压缩包：`charts/aerolink-1.0.0.tgz`（由 `helm package charts/aerolink -d charts/` 生成）
- 镜像：`swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:v1.0.0`（chart 默认值已指向公司 SWR）

### 安装

```bash
helm install aerolink charts/aerolink-1.0.0.tgz \
  --namespace aerolink-system --create-namespace
```

如需覆盖镜像或配置：

```bash
helm install aerolink charts/aerolink-1.0.0.tgz \
  --namespace aerolink-system --create-namespace \
  -f my-values.yaml
```

### 后续切换到仓库托管

公司确定搭建 Helm 仓库（ChartMuseum / Harbor / SWR 的 OCI 能力）后：

1. `helm repo add <名称> <仓库地址> && helm repo update`；
2. `helm push charts/aerolink-1.0.0.tgz <名称>`（OCI 仓库用 `helm push charts/aerolink-1.0.0.tgz oci://<地址>/<命名空间>`）；
3. 安装方式改为 `helm install aerolink <名称>/aerolink --version 1.0.0`，并更新本文档。
