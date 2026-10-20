# 配置概览

鸢联 AeroLink 的配置按四类拆开：账号怎么进得来、权限怎么划、监控怎么接、部署参数怎么调。第一次部署建议按这个顺序读，遇到具体问题再跳单页。

## 账号与认证

- [用户管理](./user-management.md)：建账号、改密码、分配角色
- [OAuth 设置](./oauth-setup.md)：接公司统一登录
- [托管 K8s 认证](./managed-k8s-auth.md)：托管集群的身份怎么委托给 AeroLink

## 权限与安全

- [RBAC 配置](./rbac-config.md)：角色、权限绑定组、章节授权
- [安全策略](./security-policy.md)：密码策略、MFA、登录限制

## 监控接入

- [Prometheus 设置](./prometheus-setup.md)：接入指标，让集群与 Pod 的用量图有数据

## 部署参数

- [环境变量](./env.md)
- [配置文件](./config-file.md)
- [数据库准备](./database.md)
- [Chart Values](./chart-values.md)
