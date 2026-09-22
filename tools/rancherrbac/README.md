# 授权迁移工具（Rancher → AeroLink 权限绑定组）

把 Rancher 上「谁在哪些命名空间里有什么权限」搬成 AeroLink 的权限绑定组，相当于替管理员
把授权批量配好。只有两个动作：**读 Rancher**（永远只读）和**写 AeroLink**（默认不写）。

- 单个可执行文件，目标机不需要 Go、不需要本仓库（见 [§2 打包](#2-打包成单文件在别的环境跑)）。
- 支持配置文件、环境变量、命令行三种入口（见 [§3 配置文件](#3-配置文件)）。
- 默认 dry-run：只打印计划，确认无误后才 `-apply` 落库。
- 可重复执行：角色按名复用、规则一致就不写；绑定组的成员与命名空间默认与既有配置取并集。

映射口径、安全取舍与实测数据见 `docs/dev/plans/2026-09-21-rancher-rbac-migration.md`。

## 1. 准备凭据

| 需要 | 从哪来 | 用途 |
| --- | --- | --- |
| Rancher API 密钥 | Rancher 界面 → 右上角头像 → 用户设置 → API Keys → 新建 | 读集群 / 项目 / 命名空间 / 角色模板 / 授权绑定 |
| AeroLink API key | AeroLink 控制台 → 账号设置 → API Keys → 新建 | 读集群列表、写角色与权限绑定组 |

- Rancher 密钥填成 `Access Key:Secret Key`（形如 `token-xxxxx:yyyyy`），**只读权限就够**。
- AeroLink 侧需要「系统设置 → 集群管理」的读与「角色与权限绑定」的写（`settings.clusters` /
  `settings.rbac`）；读用户列表（只用于提示「账号还没被 AeroLink 见过」）另需 `settings.users`，
  拿不到时只跳过这项检查。
- **API key 建完还要给它的账号分配角色**：key 在 AeroLink 里是独立伪用户、**默认没有任何角色**，
  不分配的话工具连第一个请求都会被拒（403 `Admin role required`）。做法见 §5.0 第 3 步。
- 两把密钥都是明文凭据：放进配置文件后 `chmod 600`，不要进版本库。

## 2. 打包成单文件（在别的环境跑）

在开发机（有 Go）上：

```bash
scripts/build-rancherrbac.sh          # 当前平台 → bin/rancherrbac
scripts/build-rancherrbac.sh -a       # 全部登记平台 + 打包成 tar.gz / zip
make rancherrbac ARGS=-a              # 同上，走 Makefile 入口
```

`-a` 的产物形如 `bin/rancherrbac-<version>.tar.gz`，解压后目录里是各平台二进制与这份
README。拷到目标机后：

```bash
./rancherrbac -init-config rancherrbac.yaml   # 生成配置模板（权限 600，带注释）
vi rancherrbac.yaml                            # 填地址与密钥
./rancherrbac -config rancherrbac.yaml         # 看计划（只读）
./rancherrbac -config rancherrbac.yaml -apply  # 确认后落库
```

`rancherrbac -version` 打印版本号（构建时由 git tag 注入）。

## 3. 配置文件

支持 YAML（`.yaml` / `.yml`）与 JSON（`.json`），键名与命令行参数一一对应。模板由
`rancherrbac -init-config <文件>` 生成，里面的注释就是逐项说明。连接 AeroLink 用
`aerolink:` 段落（`aerolink.url` / `aerolink.token` / `aerolink.insecure`）；退役的旧键名
`kite:` 仍然可用，两者同时给出时以 `aerolink:` 为准。

怎么指定：

1. `-config <路径>` 显式指定（路径读不到会**报错**，不会静默改用默认值）；
2. 环境变量 `RANCHER_RBAC_CONFIG`；
3. 都不给时，按当前目录的 `rancherrbac.yaml` → `.yml` → `.json` 依次找。

`-config ""` 表示「不用配置文件」，也不去当前目录找。

**键名写错会直接报错**，不会静默忽略——配置里的错别字最难发现，而漏掉一个 `clusterMap`
会悄悄少迁一整个集群。

**写入类开关（`apply` / `cleanup` / `yes`）只能在命令行上给。** 配置文件会被反复复用，
把「落库」写死在里面，之后每次想看看计划的执行都会变成真写。

## 4. 取值优先级

```text
命令行  >  环境变量  >  配置文件  >  内置默认值
```

环境变量只有这四个：`RANCHER_URL`、`RANCHER_TOKEN`、`AEROLINK_URL`、`AEROLINK_TOKEN`
（外加定位配置文件的 `RANCHER_RBAC_CONFIG`）。退役的旧名 `KITE_URL` / `KITE_TOKEN` 仍然可用，
与新名同时设置时以新名为准。集群 / 用户 / 用户组映射只能写在配置文件或命令行上。

所以可以用「一份配置文件打底 + 临时用环境变量或命令行覆盖一端」：

```bash
# 配置文件里是生产 Rancher + 生产 AeroLink，这一次只把 AeroLink 换成测试环境
AEROLINK_URL=https://aerolink-test.example.com ./rancherrbac -config prod.yaml
```

运行时报告的第二行会打印实际生效的配置文件，便于确认用的是哪一份。

## 5. 生产操作步骤（按顺序执行）

工具只做两件事：**读 Rancher**（全程只读）和**写 AeroLink**（默认不写，`-apply` 才写）。
下面按「前置 → 计划 → 评审 → 落库 → 复核 → 回滚」给出可复制的命令，建议整体放在变更窗口内做。

### 5.0 前置（先做完这些再碰生产）

1. **确认是哪一套环境。** Rancher 与 AeroLink 的地址都要在配置里写死后核对一遍：内网常有多套 AeroLink
   实例（域名解析到不同 IP、用户库互不通用），在 A 台建的 API key 拿到 B 台就是 401。
2. **Rancher：建一把只读 API 密钥**（见 [§1](#1-准备凭据)），填成 `token-xxxxx:secret`。
3. **AeroLink：给 API key 的账号分配角色——最容易漏的一步。**
   AeroLink 里的 API key 是**独立的伪用户**，账号名就是创建 key 时填的名字，**默认没有任何角色**；
   不分配角色，工具连第一个请求都会被拒（403 `Admin role required`）。
   - 界面：**系统设置 → 权限管理 →「系统管理员」→ 添加 → 用户 = 该账号名**，角色选 `admin`
     （或一个同时含「系统设置 → 集群管理」读与「角色与权限绑定」写的角色）。
   - 或直接调接口（把 `<角色 ID>`、`<账号名>` 换成真实值）：

     ```bash
     curl -s -H "Authorization: $AEROLINK_TOKEN" "$AEROLINK_URL/api/v1/admin/roles/"    # 看角色 ID
     curl -s -H "Authorization: $AEROLINK_TOKEN" "$AEROLINK_URL/api/v1/admin/apikeys/"  # 看 key 的账号名
     curl -s -X POST -H "Authorization: $AEROLINK_TOKEN" -H 'Content-Type: application/json' \
       -d '{"subjectType":"user","subject":"<账号名>"}' \
       "$AEROLINK_URL/api/v1/admin/roles/<角色 ID>/assign"
     ```

   - 迁移做完后建议撤销这次授权（见 5.6），别让一把长期有效的 key 一直挂着管理员角色。
4. **备份 AeroLink 数据库。** 工具只写这五张表，按你们的备份手段（mysqldump / pg_dump /
   `sqlite3 aerolink.db ".backup backup.db"`）留一份，作为 5.6 之外的兜底：`roles`、
   `role_assignments`、`binding_groups`、`binding_group_namespaces`、`binding_group_members`。
5. **影响面先对齐预期：** 工具不动 Rancher（只有 GET）、不动下游集群里的 RBAC，只写 AeroLink 的
   角色与权限绑定组；写入即时生效，AeroLink 的 RBAC 缓存约 1 分钟。

### 5.1 拿二进制、写配置

```bash
scripts/build-rancherrbac.sh -a     # 开发机：构建全部平台并打包 → bin/rancherrbac-<version>.tar.gz
# 或解压已有分发包，把二进制与这份 README 拷到能同时访问 Rancher 与 AeroLink 的机器

./rancherrbac -init-config rancherrbac.yaml   # 生成带注释的模板（已存在则拒绝覆盖）
vi rancherrbac.yaml                          # 填 rancher.url / token 与 aerolink.url / token
chmod 600 rancherrbac.yaml                   # 里面有明文密钥
```

`apply` / `cleanup` / `yes` 这三个写入类开关**只能在命令行给**（见 [§3](#3-配置文件)）。

### 5.2 只读跑一遍计划

```bash
./rancherrbac -config rancherrbac.yaml \
  -dump-dir ./rancher-dump -plan-out ./plan.json | tee plan.log
```

- 即使只跑计划也要一把可用的 AeroLink key：工具会**先探 AeroLink 集群列表**，AeroLink 不通直接退出。
- `-dump-dir` 落盘原始数据（字段对不上时对着它查，也能原样回灌给 `-from-dir`）；`-plan-out`
  留档，便于与下一轮 diff（要留多轮就把文件名带上日期）。

### 5.3 评审计划（这一步别跳）

1. **集群映射**：每个 Rancher 集群都落到**正确的** AeroLink 集群了吗？没匹配上的集群会整体跳过，
   用 `-cluster-map <Rancher 集群 ID>=<AeroLink 集群名>` 显式指定后重跑。
2. **量级对得上**：绑定组数 ≈ 有命名空间的项目数；命名空间数与成员数和人工盘点或上一轮一致。
3. **「提示与跳过项」逐条过**——这就是本次**不会**迁移的内容：
   - 「项目在 Rancher 里没有命名空间」→ 该项目授权无处可授；
   - 「集群 X 的命名空间读取失败」→ **该集群整批不迁**，先解决访问问题（权限、网络）再跑；
   - 「聚合接口只覆盖 local 集群…按集群读取：…」→ 核对列出的集群正是预期的那几个、数量对得上；
   - Rancher 专有 API 组、AeroLink 未收录的资源面、无法解析的主体等，见 [§8](#8-已知边界与排错)。
4. **同名冲突预检**（工具不覆盖手工对象，但你要先知道会不会撞上）：

   ```bash
   curl -s -H "Authorization: $AEROLINK_TOKEN" "$AEROLINK_URL/api/v1/admin/roles/"         > aerolink-roles.json
   curl -s -H "Authorization: $AEROLINK_TOKEN" "$AEROLINK_URL/api/v1/admin/binding-groups/" > aerolink-groups.json
   python3 - <<'PY'
   import json
   plan = json.load(open('plan.json'))
   roles = {r['name'] for r in json.load(open('aerolink-roles.json'))['roles']}
   groups = {g['name'] for g in json.load(open('aerolink-groups.json'))['bindingGroups']}
   print('角色同名：', [r['name'] for r in plan['roles'] if r['name'] in roles])
   print('绑定组同名：', [(g['aerolinkCluster'], g['name']) for g in plan['groups'] if g['name'] in groups])
   PY
   ```

   撞上的对象在落库时怎么处理，见 5.4 的警告说明。
5. 与上一轮的 `plan.json` diff，确认改动范围就是预期的那部分。

### 5.4 落库

```bash
./rancherrbac -config rancherrbac.yaml -apply | tee apply-$(date +%F-%H%M).log
```

- `+` 新建、`=` 已存在（幂等）、`!` 警告，**逐条看警告**：
  - 「同名但不是本工具建的」→ 只报告、不覆盖；同名绑定组会**并集合并**。想全量覆盖才用
    `-replace-members` / `-replace-namespaces`，那会顶掉管理员手工加的行。
  - 「以下账号在 AeroLink 里还不存在」→ 绑定已写入，账号首次登录后自动生效，不影响落库结果。
- `409` 表示该命名空间被别的绑定组占着：工具**不会抢归属**，到控制台把占用方腾出来再重跑
  （幂等，不会重复写）。
- 管理接口的写操作都会进 AeroLink 的「系统设置 → 审计管理 → 操作日志」，事后可对账。

### 5.5 复核

```bash
# 幂等复核：应全是「已是最新 / 成员无变化」，没有新建
./rancherrbac -config rancherrbac.yaml -apply | tee apply-verify.log
```

- 控制台 **系统设置 → 权限管理 → 权限绑定**：组名就是 Rancher 上的项目名，命名空间与成员
  对得上；被并集合并过的同名组要重点看成员是不是多了内容。
- 独立对量（不只信工具的自报）：

  ```bash
  curl -s -H "Authorization: $AEROLINK_TOKEN" "$AEROLINK_URL/api/v1/admin/binding-groups/" | python3 -c "
  import json,sys
  gs=[g for g in json.load(sys.stdin)['bindingGroups'] if '授权迁移' in (g.get('description') or '')]
  print('迁移建的绑定组：', len(gs), '命名空间合计：', sum(len(g.get('namespaces') or []) for g in gs))
  "
  ```

- 用**受影响的真实账号**登录 AeroLink 实测：能进哪些命名空间、能不能建/删工作负载、能不能看
  secrets，与 Rancher 上的实际权限对一遍。AeroLink 的 RBAC 缓存约 1 分钟，改完等一会儿再验。
- 迁移覆盖不到的面（见 5.7）不算迁移失败，别按缺陷处理。

### 5.6 回滚

需要撤销时按 [§7](#7-回滚-cleanup) 执行（`-cleanup` 先看、`-cleanup -yes` 真删）。补充三点：

- 若返回 `mfa_verification_required`（删除类操作被 MFA 策略拦），换个账号，或到控制台手动删。
- 更彻底的回滚是还原 5.0 的数据库备份。
- 别忘了撤销 5.0 第 3 步给 API key 账号加的管理员角色。

### 5.7 迁移不到的东西（提前跟使用方说清）

- **集群级资源授不出去**（nodes / PV / storageclasses …）：权限绑定组按命名空间组织，只能靠
  带资源通配 `*` 的角色（`cluster-member` 这类）覆盖。
- Rancher 专有 API 组、AeroLink 没有的资源面、带 `resourceNames` 的规则（默认跳过；
  `-widen-resource-names` 等于提权，别随手开）。
- 不走 Rancher 项目的授权（直接建在命名空间上的 RoleBinding）不在本工具的视野内。
- 集群里没有命名空间的项目，授权无处落地，只会进报告。

### 5.8 语义要点（决定落库时会发生什么）

- **集群映射**：默认按集群名与 AeroLink 集群名匹配。匹配不上、或 AeroLink 里有多个同名集群时，
  该集群整体跳过并给出可执行的提示，必须用 `clusterMap`（或 `-cluster-map`）显式指定。
- **成员 / 命名空间是取并集**，不会抹掉管理员手工加进去的东西。要按计划全量覆盖用
  `-replace-members` / `-replace-namespaces`——注意前者会把整组成员替换成计划内容，
  手工加进来的行会被顶掉。
- **命名空间不会抢**：同一个集群里一个命名空间只能属于一个绑定组，被别的组占着时写入返
  409 并列出占用方，工具不会强行改归属。
- **同名对象不会被覆盖**：名称默认就是项目名 / 角色模板名，容易与管理员手工建的角色、
  绑定组同名。描述里带迁移标记的才认为是本工具建的；同名但描述对不上的只报告、不覆盖，
  绑定组会并集合并（配合 `-replace-members` 时要先看一眼警告）。

## 6. 离线模式（Rancher 拉不到时）

API 密钥用不了（IP 白名单、密钥过期、代理改写 Authorization 等）时，让人在能访问 Rancher
的地方导出几个集合，再离线跑：

```bash
RANCHER_TOKEN='token-xxxxx:yyyyy'   # 任何能在浏览器里正常用的凭据
mkdir -p rancher-dump
for p in /v3/clusters /v3/projects /v1/namespaces /v3/roleTemplates \
         /v3/users /v3/groups /v3/projectRoleTemplateBindings /v3/clusterRoleTemplateBindings; do
  curl -s -u "$RANCHER_TOKEN" "https://<rancher>$p?limit=1000" \
    -o "rancher-dump/$(printf %s "$p" | sed 's#/#_#g;s#^_##').json"
done

./rancherrbac -from-dir rancher-dump      # 不需要 rancher.url / token
```

- 文件名与 `-dump-dir` 写出的一致（`/v3/clusters` → `v3_clusters.json`），两者可以互相回灌；
  文件内容既可以是 Rancher 的原始响应（带 `data`），也可以直接是数组。
- **非 `local` 集群的命名空间要点开单独一份文件。** 聚合接口只返回 `local` 集群的命名空间，
  其余集群工具会按集群再读一次（见 [§8](#8-已知边界与排错)），离线时对应的文件是
  `k8s_clusters_<集群 ID>_v1_namespaces.json`——用 `-dump-dir` 跑一次就会一并写出，可直接回灌：

  ```bash
  curl -s -u "$RANCHER_TOKEN" "https://<rancher>/k8s/clusters/c-m-xxxx/v1/namespaces?limit=1000" \
    -o rancher-dump/k8s_clusters_c-m-xxxx_v1_namespaces.json
  ```

  缺这份文件不会报错，但报告里会写明该集群的授权未迁移。
- 空集合也要有文件（例如没有用户组就 `echo '[]' > rancher-dump/v3_groups.json`），缺文件会
  明确列出该准备哪几个，不会静默少迁。
- 响应里出现 `pagination.next` 说明还有下一页：对着该链接把 `data` 数组合并进同一个文件。

## 7. 回滚（-cleanup）

```bash
./rancherrbac -config rancherrbac.yaml -cleanup        # 只打印要删什么，不删
./rancherrbac -config rancherrbac.yaml -cleanup -yes   # 真删
```

删除范围严格限定在**本工具建的**对象：角色与绑定组的描述里带迁移标记
（`由授权迁移导入`）才会删，同名但描述对不上的（管理员手工建的）只报告、不动，内置角色
与受保护的绑定组也会跳过。给了 `-prefix` 时改为按前缀圈定范围。

注意：`-cleanup` 会连带删掉这些绑定组，之后重跑 `-apply` 会重建（角色规则与绑定关系都能
还原，但绑定组 ID 会变）。

## 8. 已知边界与排错

- **命名空间：聚合接口只覆盖 `local`，其余集群按集群补取。** 实测（`rancher.gogdev.cn`）
  `/v1/namespaces` 返回的条数与 `/k8s/clusters/local/v1/namespaces` 完全相同，`/v3/namespaces`
  直接 404。因此工具会为「聚合结果里一条命名空间都没有」的集群再读一次
  `/k8s/clusters/<集群 ID>/v1/namespaces`（同机实测可用：`bigdata-center` 的 48 个命名空间）。
  这批数据的集群归属直接取请求里的集群，不靠对象里猜；没有项目注解的仍不会被迁移。
  补取失败会在报告里写明该集群的授权不会迁移，不会静默少迁。
  离线模式（`-from-dir`）下它来自 `k8s_clusters_<集群 ID>_v1_namespaces.json`（见 §6）。
  `-namespaces-source v3` 仍可用来试该 Rancher 版本是否返回跨集群全量。
- **集群级资源授不出去。** 权限绑定组是按命名空间组织的，nodes / PV / storageclasses 这类
  集群级资源映射不出来，只能在报告里记录；要覆盖它们只能靠资源通配 `*` 的角色
  （`cluster-member` 这类就带 `*`）。
- **项目上下文的资源通配会展开成具体资源**，因为 AeroLink 里 `*` 的语义是「集群里的一切资源」，
  照搬 Rancher 项目级只读的 `*` 会把它放大成整个集群的只读权限。
- 鉴权失败（401 / 403）会把具体原因翻出来，包括「账号开了 MFA 二次校验」这种删除类操作
  会被拦的情况——这时 `-cleanup` 得换账号或去控制台操作。
- 排查时加 `-v` 打印每个 HTTP 请求。

## 9. 开发与验证

```bash
go test ./tools/rancherrbac/                     # 规则映射、字段归一化、配置分层、桩服务端到端、幂等、清理范围
./bin/golangci-lint run ./tools/rancherrbac/...
```

用仓库入口脚本时（开发机上）：

```bash
scripts/migrate-rancher-rbac.sh -config rancherrbac.yaml        # 有 bin/rancherrbac 就用它，否则 go run
RANCHERRBAC_BIN=/path/to/rancherrbac scripts/migrate-rancher-rbac.sh -help
```

## 10. 参数速查

```bash
./rancherrbac -help
```

| 参数 | 说明 |
| --- | --- |
| `-config` | 配置文件路径；不给时按 `$RANCHER_RBAC_CONFIG`、再按当前目录的默认文件名找 |
| `-init-config` | 生成带注释的配置模板，然后退出；不覆盖已存在的文件 |
| `-version` | 打印版本号 |
| `-aerolink-url` | AeroLink 控制台地址（默认取 `$AEROLINK_URL`） |
| `-aerolink-token` | AeroLink API key，即控制台里的 `aerolink<id>-<secret>`（改名前的 `kite<id>-<secret>` 同样可用；默认取 `$AEROLINK_TOKEN`） |
| `-aerolink-insecure` | 跳过 AeroLink 的 TLS 证书校验 |
| `-apply` | 真正写入 AeroLink；不加则只打印计划 |
| `-plan-out` | 把计划写成 JSON，便于评审与留档 |
| `-cleanup` / `-yes` | 反向操作：删除本工具建的角色与绑定组（`-yes` 跳过确认） |
| `-from-dir` / `-dump-dir` | 离线读导出的集合 JSON / 把拉到的原始数据落盘 |
| `-cluster-map` | Rancher 集群 ID → AeroLink 集群名（可重复） |
| `-user-map` / `-group-map` | 用户名 / 用户组在两边的对应关系（可重复） |
| `-namespaces-source` | `auto`（默认）/ `v1`（Steve）/ `v3`（Norman） |
| `-skip-cluster-grants` | 不迁移集群级绑定（CRTB） |
| `-replace-members` / `-replace-namespaces` | 成员 / 命名空间全量覆盖（默认取并集） |
| `-widen-resource-names` | 把限定对象名的规则放宽到整个资源类型（默认跳过，放宽等于提权） |
| `-prefix` | 角色名与绑定组名的前缀（默认空，直接用项目名与角色模板 ID） |
| `-timeout` / `-v` | 请求超时 / 打印每个 HTTP 请求 |
| `-kite-url` / `-kite-token` / `-kite-insecure` | 退役的旧参数名，仍然可用；与新名同时给出时以新名为准 |
