# aerolink

![Version: 1.0.3](https://img.shields.io/badge/Version-1.0.3-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: v1.0.3](https://img.shields.io/badge/AppVersion-v1.0.3-informational?style=flat-square)

A Helm chart for the AeroLink Kubernetes Dashboard

**English** · [中文](./README_zh.md)

## Installation

The chart's default image is the company SWR `swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink`, so installing the in-repo chart is enough:

```bash
# Install in aerolink-system namespace (recommended)
helm install aerolink charts/aerolink -n aerolink-system --create-namespace
```

### Upgrade Chart

```bash
helm upgrade aerolink charts/aerolink -n aerolink-system
```

### Uninstall Chart

```bash
helm uninstall aerolink -n aerolink-system
```

### Chart Values

[Chart Values](../../docs/config/chart-values.md)
