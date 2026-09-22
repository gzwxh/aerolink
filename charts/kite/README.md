# kite

![Version: 1.0.0](https://img.shields.io/badge/Version-1.0.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: v1.0.0](https://img.shields.io/badge/AppVersion-v1.0.0-informational?style=flat-square)

A Helm chart for Kubernetes Dashboard - Kite

**English** · [中文](./README_zh.md)

## Installation

The chart's default image is the company SWR `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink`, so installing the in-repo chart is enough:

```bash
# Install in kite-system namespace (recommended)
helm install kite charts/kite -n kite-system --create-namespace
```

### Upgrade Chart

```bash
helm upgrade kite charts/kite -n kite-system
```

### Uninstall Chart

```bash
helm uninstall kite -n kube-system
```

### Chart Values

[Chart Values](../../docs/config/chart-values.md)
