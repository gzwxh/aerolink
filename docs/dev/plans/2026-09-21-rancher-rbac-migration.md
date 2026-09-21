# Rancher 授权迁移脚本（Rancher → Kite 权限绑定组）

- 状态：**已在真实 Rancher 上跑通并写入内部 Kite**（2026-09-21，只读密钥），现场数据、
  权限复验与遗留项见 §6 / §7
- 触发：公司内网在用的 Rancher 上已经按项目 / 命名空间给用户与用户组授过权，切到 Kite
  后要由管理员把这批授权重配一遍。手工点一遍既慢又容易漏。
- 结论：加一个一次性迁移工具 `tools/rancherrbac`（入口脚本
  `scripts/migrate-rancher-rbac.sh`，用法说明 `tools/rancherrbac/README.md`），只读 Rancher，
  默认 dry-run 打印计划，`-apply` 才写入 Kite；支持配置文件，可打成单文件可执行文件
  （`scripts/build-rancherrbac.sh`）拷到别的环境单独使用。

## 1. 为什么要有一层「翻译」

两边的授权模型不是同名同构的：

| Rancher | Kite |
| --- | --- |
| 集群（cluster）→ 项目（project）→ 命名空间 | 集群 → 权限绑定组（`binding_groups`）→ 命名空间 |
| 角色模板（roleTemplate）承载 RBAC 规则（apiGroups × resources × verbs），全局 | 角色（`roles`）承载「资源 × 操作」授权，全局 |
| PRTB：主体 × 项目 × 角色模板 | 组成员：主体 × 组（含可选命名空间范围）× 角色 |
| CRTB：主体 × 集群 × 角色模板 | 没有对应物（权限绑定组按命名空间组织） |

映射选择：

- **一个 Rancher 项目 = 一个 Kite 权限绑定组**，组名直接用 Rancher 上的项目名（例：`技术预研`；
  无项目名时用 `p-xxxx`，同集群内重名时补项目 ID 尾段区分）。这样界面上的结构与 Rancher 一致，
  管理员一眼能对上。
  只要该集群有集群级绑定（CRTB），该集群里**每个拥有命名空间的项目**都会建组——
  否则集群级角色只会在「恰好有项目级成员」的那些项目的命名空间里生效。
- **一个 Rancher 角色模板 = 一个 Kite 角色**，名就是角色模板 ID（`project-owner` 等），
  与 Rancher 界面上看到的一致。不复用内置角色：`admin` 含控制台设置，`viewer` 排除 secrets，
  语义都不等价；Kite 内置角色（`IsSystem`）与保留名（`admin` / `super-admin`）会被跳过或拒建。
- **名称默认不带前缀**（需要避让时用 `-prefix`）。代价是与管理员手工建的角色 / 组可能同名，
  因此角色与组的描述里都带迁移标记 `由授权迁移导入`：清理时只删带标记的，同名手工对象跳过
  并报告，不覆盖。描述会显示在控制台上，所以标记里不含产品名。
  `-prefix` 非空时回到按前缀圈定范围的老口径（`-cleanup` 按前缀删）。
- **CRTB 分摊到该集群的每个项目组**：成员命名空间范围留空（= 整组），正好覆盖该集群的
  全部命名空间；资源通配 `*` 的角色按绑定组既有语义还能覆盖集群级资源。集群里没有项目
  （因此没有项目组）时，退化为建一个 `<集群>-集群级` 的组来承载。

## 2. 四条不能松的安全口径

1. **项目上下文的资源通配必须展开。** Kite 里 `grant.resource == "*"` 的语义是「集群里的
   一切资源」（见 `pkg/rbac/binding_group.go` 的 `bindingGroupAllowsClusterWide`），
   照搬 Rancher `project-view` 的 `*` 会把它放大成整个集群的只读权限。因此 project 上下文
   的 `*` 按 `pkg/common/resource.go` 的 Registry 展开成具体的**命名空间级**资源。
2. **只有 `apiGroups: ["*"]` + `resources: ["*"]` 才能变成 Kite 的资源通配。**
   Rancher 里 `resources: ["*"]` 常常只覆盖它自己声明的那个 API 组
   （现场数据里 `cluster-member` 就有 `apiGroups: [rke-machine-config.cattle.io],
   resources: ["*"]`）。这种规则照搬成 Kite 的 `*` 会把一条 Rancher 专有的只读规则
   放大成整个集群的读权限——这是实测真实数据时才发现的一个越权风险，已修。具体 API 组的
   通配按组展开；Kite 没收录该组就什么也不授。
3. **带 `resourceNames` 的规则默认跳过。** Kite 无法表达「只对某个具体对象」，
   放宽到整个资源类型等于提权。需要覆盖时用 `-widen-resource-names` 显式开启。
4. **集群级资源点名列出时只记录、不生效。** 权限绑定组授不出集群级资源（同一条注释），
   写进角色只会让界面显示「有权限」而实际被拒，因此在报告里说明而不是硬塞。
   推论：`cluster-member` 这种「只授集群级资源」的模板在绑定组里映射不出任何授权。

另外两条顺带的对齐（都是「不这么做迁移后必然退功能」）：

- 只读授权补 `pods` 的 `log`：Rancher 项目成员看得到容器日志，而 Kite 的 `log` 是独立操作
  （内置只读角色也是 `get + log`），不补就会 403。
- `pods/log`、`pods/exec`、`pods/attach`、`pods/portforward` 这类子资源规则映射到
  Kite 的 `log` / `exec` 操作；Rancher 侧它们用的是 `get` / `create`，不能拿映射后的
  动词去比对。
- `metrics.k8s.io` 的 `pods` / `nodes` 在 Kite 里叫 `podmetrics` / `nodemetrics`：
  资源别名按「API 组 + 资源名」查表，不能只看资源名。

## 3. 主体（用户 / 用户组）的对应

- 用户：以 Rancher 用户名为准（两边接同一个目录时一致），`principalId`（`local://u-xxx`、
  `openldap_user://...`）只用于回查用户名；`-user-map old=new` 可覆盖。
- 用户组：本地组（`local://g-xxx`）走 `/v3/groups` 的组名；AD / LDAP / OIDC 组从
  `principalId` 推导（`cn=devs,ou=groups,...` → `devs`），并在报告里提示可用
  `-group-map` 指定成控制台里的组名。
- 查不到名字的主体（多半是已删除的账号）**跳过并写在报告的「提示与跳过项」里**，
  不猜名字——猜错会给出真实的越权。

## 4. 读取 Rancher 的兜底

Norman（`/v3`）与 Steve（`/v1`）的字段名不一致且随版本漂移，所以：

- 命名空间归属优先读 Steve `/v1/namespaces`（注解 `field.cattle.io/projectId` 就是
  Norman 的项目 ID `c-xxx:p-xxx`，标签只有项目名，集群还能从 Steve id 前缀推出来），
  读不全时用 Norman `/v3/namespaces` 补齐或改写；`-namespaces-source` 可强制指定。
- 集群 / 项目的显示名依次取 `displayName`、`metadata.annotations["field.cattle.io/displayName"]`、
  `metadata.name`，再退到 ID。
- `-dump-dir <目录>` 把拉到的原始数据落盘，字段对不上时对着它改。

### 4.1 离线模式（`-from-dir`）

Rancher 的 API 密钥取不到（IP 白名单、密钥过期、代理改写 Authorization 等）时，可以让人在
能正常访问 Rancher 的地方把几个集合导出成 JSON，再让工具离线跑：

```bash
RANCHER_TOKEN='token-xxxxx:yyyyy'   # 任何能在浏览器里正常用的凭据
mkdir -p rancher-dump
for p in /v3/clusters /v3/projects /v1/namespaces /v3/roleTemplates \
         /v3/users /v3/groups /v3/projectRoleTemplateBindings /v3/clusterRoleTemplateBindings; do
  curl -s -u "$RANCHER_TOKEN" "https://<rancher>$p?limit=1000" \
    -o "rancher-dump/$(printf %s "$p" | sed 's#/#_#g;s#^_##').json"
done

scripts/migrate-rancher-rbac.sh -from-dir rancher-dump     # 不需要 -rancher-url / -rancher-token
```

- 文件名与 `-dump-dir` 写出的一致（`/v3/clusters` → `v3_clusters.json`），两者可以互相回灌；
  文件内容既可以是 Rancher 的原始响应（带 `data`），也可以直接是数组。
- 缺文件时直接列出该准备哪几个，不会静默少迁。
- 响应里出现 `pagination.next` 时说明还有下一页：对着该链接把 `data` 数组合并进同一个文件。
  采集到的数据与在线模式共用同一套归一化逻辑，两条路的计划文本逐字一致（有测试守住）。

## 5. 用法与验证

推荐用**配置文件**：它把地址、密钥、集群映射这些一次填好，可以连同二进制拷到别的环境
里反复用（用法、步骤与排错见 `tools/rancherrbac/README.md`）。

```bash
# 在开发机上打一个单文件可执行文件（目标机不需要 Go，也不需要本仓库）
scripts/build-rancherrbac.sh -a          # 全部登记平台 + 打包 → bin/rancherrbac-<version>.tar.gz
make rancherrbac ARGS=-a                 # 同上

# 目标机上
./rancherrbac -init-config rancherrbac.yaml   # 生成带注释的配置模板（权限 600）
vi rancherrbac.yaml                           # 填地址、密钥、clusterMap
./rancherrbac -config rancherrbac.yaml         # 看计划（只读）
./rancherrbac -config rancherrbac.yaml -apply  # 落库
./rancherrbac -config rancherrbac.yaml -apply  # 再跑一次：应当全部「无变化」（幂等）

# 回滚：先看会删什么（不加 -yes 只列清单，不动手），确认后再加 -yes
./rancherrbac -config rancherrbac.yaml -cleanup
./rancherrbac -config rancherrbac.yaml -cleanup -yes
```

也可以全部走环境变量 / 命令行（三者的优先级：命令行 > 环境变量 > 配置文件 > 默认值）：

```bash
export RANCHER_URL=https://rancher.example.com
export RANCHER_TOKEN='token-xxxxx:yyyyy'   # Rancher 的 Access Key:Secret Key
export KITE_URL=https://kite.example.com
export KITE_TOKEN='kite1-xxxxxxxx'         # Kite 控制台创建的 API key

scripts/migrate-rancher-rbac.sh -cluster-map c-m-abc123=prod          # 看计划（只读）
```

配置文件的几个取舍：

- 支持 YAML（`.yaml` / `.yml`）与 JSON（`.json`），键名与命令行参数一一对应；没给 `-config`
  时按 `$RANCHER_RBAC_CONFIG`、再按当前目录的 `rancherrbac.yaml` / `.yml` / `.json` 找。
- 键名写错直接报错（严格解析），不静默忽略：配置里的错别字最难发现，而漏掉一个
  `clusterMap` 会悄悄少迁一整个集群。
- `-config` 指的路径读不到时报错，不回退默认值（避免「以为在用某份配置」）。
- **写入类开关（`apply` / `cleanup` / `yes`）故意不支持写进配置文件**：配置文件会被反复
  复用，把「落库」写死在里面，之后每次想看看计划的执行都会变成真写。
- 文件里有密钥，`-init-config` 生成时就是 600 权限；本工具发现它同组/其他用户可读时会
  在 stderr 上提醒。

迁移本身的几条口径：

- 集群映射：默认按名字与 Kite 集群名匹配，匹配不上（或同名多个）的集群整体跳过并给出
  可执行的提示，必须显式 `-cluster-map` 才会迁移。
- 复跑幂等：角色按名复用、规则一致就不写；绑定组命名空间与成员默认与既有配置**取并集**
  （`-replace-members` / `-replace-namespaces` 才全量覆盖），因此不会抹掉管理员手工加的东西。
  注意：组名就是项目名，若管理员已有同名绑定组，成员默认是并入其中的（`-replace-members`
  会是整组覆盖）；`-apply` 时会把这种情况打印成警告，落库前先看一眼。
- `-cleanup` 只删描述里带迁移标记（`由授权迁移导入`）的对象，同名的手工角色 / 绑定组与
  内置角色、受保护的绑定组都会跳过并在报告里列出来；给了 `-prefix` 时改为按前缀圈定范围。
- 需要 `settings.rbac` 写权限（管理员的 API key）；读用户列表（仅用于「账号还没被 Kite 见过」
  的提醒）另需 `settings.users`，拿不到时只跳过这项检查。Kite 侧 401 / 403 会翻成具体原因，
  包括「账号开了 MFA 二次校验」这种删除类操作会被拦的情况（此时 `-cleanup` 得换账号或去控制台做）。

验证：

```bash
go test ./tools/rancherrbac/     # 规则映射、字段归一化、配置分层、桩服务端到端、幂等、清理范围、在线/离线一致
./bin/golangci-lint run ./tools/rancherrbac/...
```

## 6. 现场数据（rancher.gogdev.cn，2026-09-21 实测）

用只读 API 密钥拉到的实数与它们对迁移的影响：

| 项 | 数值 | 说明 |
| --- | --- | --- |
| 集群 | 2 | `local`（显示名 dev，← 映射到 Kite 的 `dev`）、`c-m-hrczlc8w`（显示名 bigdata-center，← Kite 的同名集群） |
| 项目 | 107 | `local` 94 个（其中 82 个拥有命名空间）、`c-m-hrczlc8w` 13 个（其中 12 个拥有命名空间） |
| 命名空间 | 552 | 聚合的 `/v1/namespaces` 只返回 `local` 的 504 条：`local` 项目下 246 个（全部覆盖）、
`c-dgt2x` 69 个（该集群已不在集群列表里）、**189 个没有 `field.cattle.io/projectId` 注解**
（不在任何项目里）→ 后两类不迁移。`c-m-hrczlc8w` 另有 48 条，只能按集群读
`/k8s/clusters/c-m-hrczlc8w/v1/namespaces`：其中 41 个有项目归属、7 个无 |
| 角色模板 | 42 | 都是内置的 Rancher 2.2 时代模板 |
| PRTB / CRTB | 387 / 17 | 全部是用户主体（没有用户组绑定）；模板只用 `project-member`(296)、
`project-owner`(89)、`read-only`(2) / `cluster-member`(11)、`cluster-owner`(6) |

**关键发现：Rancher 的权限有一半不在 roleTemplate 里。** `project-member`（32 条规则）与
`project-owner`（35 条）的规则清一色是 Rancher / KubeSphere / istio / monitoring 的 CRD、
集群级资源（nodes、PV、storageclasses、apiservices）与 `project.cattle.io apps`（Rancher 2.2
的「应用」工作负载入口），只有 `persistentvolumeclaims [*]` 与 `metrics.k8s.io pods [*]` 是
Kite 认得的。**只看这些规则会得出「项目成员在 Kite 里只能管 PVC」的错误结论**——
实际上 Rancher 还会在下游集群里再绑一个 Kubernetes 内置角色：

| Rancher 模板 | 额外绑定的内置角色（下游集群实测） |
| --- | --- |
| `project-owner` | `admin`（命名空间内全部权限，含 secrets / roles / rolebindings） |
| `project-member` | `edit`（除 roles / rolebindings 之外的读写，含 secrets） |
| `read-only` | `view`（只读，不含 secrets） |
| `cluster-member` | `view`（集群级，ClusterRoleBinding 名为 `<user>-view`） |

证据：Kite 代理到下游集群（`local`）看到命名空间里同时存在
`RoleBinding -> ClusterRole/project-owner` 与 `-> ClusterRole/admin`（member 则是 `edit`）；
集群级有 `ClusterRoleBinding -> ClusterRole/view`；下游还有 `project-member-promoted`
这类聚合角色。**工作负载权限就在这第二个绑定里**，不补就会迁移出一批“看得到命名空间、
干不了活”的账号。

因此工具用 `rancherBuiltinEquivalent` 表把这一半显式补齐（口径：admin = 全部命名空间级资源
× get/create/update/delete + Pod 的 log/exec/文件操作；edit 再扣掉 roles/rolebindings；
view = 全部命名空间级资源 get（排除 secrets）+ Pod 的 log；集群级 view 用资源通配 `*`
加否定模式 `!secrets` 表达）。

实测结果（真实数据写入本地 Kite 后用被授权账号复验）：

| 检查 | 结果 |
| --- | --- |
| project-member 在授权命名空间建 ConfigMap | 201 |
| project-member 读 secrets | 200（edit 含 secrets） |
| project-member 删 roles | 403（edit 不含 roles） |
| project-member 读未授权命名空间 | 403 |
| cluster-member 读 nodes（集群级） | 200 |
| cluster-member 读任意命名空间 pods | 200 |
| cluster-member 读 secrets | 403（view 不含 secrets） |
| cluster-member 删 configmaps | 403（只读） |

实际操作记录（2026-09-21，`local` → Kite `dev`，工具离线模式跑 `/tmp/rancher-live` 快照）：

- `-apply` 一次写全：5 个角色（`cluster-member` / `cluster-owner` / `project-member` /
  `project-owner` / `read-only`）、82 个绑定组（组名就是 Rancher 上的项目名：`Default`、
  `Doris`、`System`、`apifabu`、`运维开发`、`苗绣` …）、246 个命名空间、903 行成员，
  涉及 52 个账号。命名空间与账号无冲突，无 409。

补上按集群读取命名空间后复跑（同日，`-kite-url http://kite.gogdev.cn` 直连）：

- `c-m-hrczlc8w`（bigdata-center）的 48 个命名空间读到了，计划多出 12 个绑定组
  （`默认`/`System`/`优惠券`/`技术预研`/`数据应用` …）、41 个命名空间、116 行成员；
  `-apply` 新建 12 个组，已有 82 个组维持「已存在，成员无变化」。合计 94 个组、287 个命名空间。
- 唯一告警：Rancher 账号 `xijun` 在 Kite 里不存在，绑定已写入、首次登录后即生效。
- `dev` 与 `bigdata-center` 两个集群在 Kite 里都显示 `connected: false`，与本次 RBAC 写入无关。
- 权限复验（把测试账号加进 `Doris` 组的 `project-member` 后登录 Kite，复验完即移除）：

| 检查 | 结果 |
| --- | --- |
| 在授权命名空间 `doris` 建 ConfigMap | 201 |
| 读该命名空间 secrets | 200（edit 含 secrets） |
| 读该命名空间 rolebindings | 403（edit 不含） |
| 读未授权命名空间 `kube-system` 的 pods | 403 |
| 列全部命名空间 configmaps | 200 |
| 删除自建 ConfigMap | 200 |

- 成员行数是 903 而不是早前记录里的 973：后者把同一个主体的多行算重复了。现在按
  `(主体类型, 主体, 命名空间)` 归并后再计数，与直接拿快照算出来的期望值一致
  （82 个项目 × 各自项目成员 ∪ 集群级 8 个主题）。

## 7. 未验证的部分（首次上线前请核对）

- **已在真实 Rancher 上跑通并写入 Kite**（2026-09-21，只读 API 密钥）：采集 → 计划 →
  `-apply` → 用被授权账号复验权限，全部通过；现场数据与结论见 §6。
- 上一轮迁移已用 `-cleanup -yes` 撑除（旧口径的 `rancher-*` 5 个角色 + 82 个组），
  Kite 里只剩管理员手建的组；本轮是在空地上重写的。
- ~~命名空间 `devops` 被手建组 `maoyuxiang` 占用导致 409~~：该组已不存，
  本轮 `运维开发` 组正常拿到 7 个命名空间。
- ~~集群 `c-m-hrczlc8w`（bigdata-center）的命名空间读不到~~：**已修**。当时工具用的
  `/v1/namespaces` 只覆盖 `local`（快照里 343 条里带 `/` 的一条也没有，注解
  `c-m-hrczlc8w:p-*` 的一条也没有），该集群下 13 个项目的授权全落入「项目没有命名空间」的
  提示。实测确定路径：`/k8s/clusters/<集群 ID>/v1/namespaces` 能返回该集群的 48 个命名空间
  （旧版 Rancher 的 `/v3/clusters/<id>/namespaces` 与 `/v3/namespaces` 都是 404，前者不是
  可用替代）。现在工具会为「聚合结果里一条命名空间都没有」的集群补读这条路径，补不到会在报告里
  写明该集群的授权未迁移；离线模式对应 `k8s_clusters_<集群 ID>_v1_namespaces.json`。
  现场结果见 §6 末（12 个组、41 个命名空间）。
- API 密钥：`kite.gogdev.cn` 上建的 key（`kite2-…`）默认**没有任何角色**（Kite 里 API key 是
  独立伪用户，不继承创建者），必须先给该账号分配角色，否则 `/api/v1/admin/*` 一律
  403 `Admin role required`。另注：`token-*` 的 Rancher 密钥与 Kite 的 key 不能混用；
  `10.100.117.8:8080` 与 `kite.gogdev.cn`（10.10.11.111）是两套独立实例，用户库不通用。
- 未迁移的内容会全部列在报告的「提示与跳过项」里（Rancher 专有 API 组、
  未收录资源、无命名空间的项目、未映射集群、无法解析的主体），落库前请通读一遍。
- Kite 侧权限复核建议按 `docs/dev/feature-code-index.md` 的「权限」入口：
  登录一个受影响的账号，看命名空间可见范围与关键操作是否与 Rancher 上一致。
