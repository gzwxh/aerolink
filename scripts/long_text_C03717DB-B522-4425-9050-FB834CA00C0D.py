"""把 Rancher 的集群 / 项目 / namespace 关联起来。

数据来源与用到的字段:
    /v3/clusters    集群:  id、name
    /v3/projects    项目:  id(格式 "clusterId:projectId")、clusterId、name
    /v1/namespaces  命名空间: id,项目归属看 metadata.annotations
                    "field.cattle.io/projectId"(值为 "clusterId:projectId"),
                    metadata.labels 里的同名键只存 projectId

用法:
    python rancher.py                 -> {cluster1: {project1: ["ns1", "ns2"]}}
    python rancher.py <cluster name>  -> {project1: ["ns1", "ns2"]}
"""

import argparse
import json
import sys
from urllib.parse import urljoin

import httpx

ENDPOINT = "https://rancher.gogdev.cn"
USER = "token-bspc6"
TOKEN = "t97rrwddjp8spxzvdglc54rk8l2g99h7gqhjt7mkptwjwqxwxwvt29"

# Rancher 只对 /v1 和 /v3 路径下的请求做 token 鉴权,请求根路径会直接 401。
# 所以下面都用带版本的完整 URL,不靠 base_url 拼接。
API_V3 = f"{ENDPOINT}/v3"
API_V1 = f"{ENDPOINT}/v1"

CLUSTERS_ENDPOINT = f"{API_V3}/clusters"
PROJECTS_ENDPOINT = f"{API_V3}/projects"
NAMESPACES_ENDPOINT = f"{API_V1}/namespaces"

# Rancher 常用自签名证书,报 SSL 错误时改成 False
VERIFY = False
TIMEOUT = 30.0

PROJECT_ID_ANNOTATION = "field.cattle.io/projectId"


def make_client(base_url=API_V3, user=USER, token=TOKEN, verify=VERIFY, timeout=TIMEOUT):
    """返回带 Basic Auth 的客户端。

    base_url 必须落在 /v1 或 /v3 下 —— Rancher 只对这两个版本路径做 token 鉴权,
    请求域名根路径一律 401。

    具体资源请求仍用模块里的绝对 URL(CLUSTERS_ENDPOINT 等),
    所以同一客户端能同时访问 v1 和 v3。
    """
    base_url = base_url.rstrip("/")
    if not base_url.endswith(("/v1", "/v3")):
        raise ValueError(f"base_url 必须以 /v1 或 /v3 结尾,当前是 {base_url!r}")

    return httpx.Client(
        base_url=base_url,
        # Rancher 的 API token 用 Basic Auth: 用户名是 token id,密码是 token secret
        auth=(user, token),
        verify=verify,
        timeout=timeout,
    )


def check_response(response):
    """出错时把状态码、URL 和响应体一起抛出来 —— Rancher 的报错说明在 body 里。"""
    if response.status_code < 400:
        return

    hint = ""
    if response.status_code == 401:
        hint = (
            "\n401 是凭据没通过鉴权(不是路径问题),依次确认:"
            "\n  1. API token 是否已过期(Rancher 界面 → 用户设置 → API Keys);"
            "\n  2. Basic Auth 用户名是 token id(形如 token-xxxxx)、密码是 token secret,不要写反;"
            "\n  3. 用 curl -u 'token-xxxxx:secret' 请求同一个 URL 对比,先排除代码问题。"
        )
    raise SystemExit(
        f"请求失败: {response.request.method} {response.request.url} "
        f"-> {response.status_code}\n{response.text[:500]}{hint}"
    )


def get_all(client, url, params=None):
    """取完所有分页。

    兼容两种分页: Norman/Steve 风格的 pagination.next,
    以及原生 k8s 风格的 metadata.continue。
    """
    items = []
    query = dict(params or {})
    while url:
        response = client.get(url, params=query or None)
        check_response(response)
        body = response.json()
        items.extend(body.get("data") or body.get("items") or [])

        next_url = (body.get("pagination") or {}).get("next")
        if next_url:
            # next 可能是绝对链接,也可能是 "/v3/projects?marker=..." 这种相对链接。
            # 相对当前请求的 URL 解析,否则会被带版本的 base_url 再拼一次变成 /v3/v3/...
            url, query = urljoin(str(response.url), next_url), {}
            continue

        continue_token = (body.get("metadata") or {}).get("continue")
        if continue_token:
            query = {**(params or {}), "continue": continue_token}
            continue

        url = None
    return items


def fetch(client):
    """一次拿回集群、项目、命名空间三份原始数据。"""
    clusters = get_all(client, CLUSTERS_ENDPOINT)
    projects = get_all(client, PROJECTS_ENDPOINT)
    namespaces = get_all(client, NAMESPACES_ENDPOINT)
    return clusters, projects, namespaces


def namespace_name(namespace):
    """namespace 名字。Steve 聚合接口的 id 可能是 "clusterId:ns",这里去掉前缀。"""
    name = namespace.get("id") or (namespace.get("metadata") or {}).get("name")
    if name and ":" in name:
        name = name.split(":", 1)[1]
    return name


def namespace_project_id(namespace, full_id_by_project=None):
    """namespace 归属项目的完整 id,形如 "c-abc123:p-def456"。"""
    metadata = namespace.get("metadata") or {}
    annotations = metadata.get("annotations") or {}
    full_id = annotations.get(PROJECT_ID_ANNOTATION)
    if full_id:
        return full_id

    # 兜底:label 里只有 projectId,再从项目列表反查 clusterId
    labels = metadata.get("labels") or {}
    project_id = labels.get(PROJECT_ID_ANNOTATION)
    if project_id:
        return (full_id_by_project or {}).get(project_id)
    return None


def resolve_cluster(clusters, identifier):
    """允许用集群的 id / name / displayName 来指定集群。"""
    for cluster in clusters:
        if identifier in (cluster.get("id"), cluster.get("name"), cluster.get("displayName")):
            return cluster
    available = ", ".join(repr(c.get("name") or c["id"]) for c in clusters)
    raise SystemExit(f"找不到集群 {identifier!r},可用: {available}")


def build_namespace_map(clusters, projects, namespaces, cluster=None):
    """cluster 为空时返回 {cluster: {project: [ns]}},指定时返回 {project: [ns]}。"""
    project_by_id = {p["id"]: p for p in projects}
    cluster_by_id = {c["id"]: c for c in clusters}
    # "p-def456" -> "c-abc123:p-def456"
    full_id_by_project = {p["id"].split(":", 1)[-1]: p["id"] for p in projects}

    if cluster is None:
        wanted = set(cluster_by_id)
    else:
        wanted = {resolve_cluster(clusters, cluster)["id"]}

    # buckets: clusterId -> projectId -> [namespace, ...]
    # 先按项目建好空桶,这样没有 namespace 的项目也会出现在结果里
    buckets = {cluster_id: {} for cluster_id in wanted}
    for project in projects:
        cluster_id = project.get("clusterId") or project["id"].split(":", 1)[0]
        if cluster_id in buckets:
            buckets[cluster_id].setdefault(project["id"], [])

    unassigned = 0
    for namespace in namespaces:
        full_id = namespace_project_id(namespace, full_id_by_project)
        if not full_id or ":" not in full_id:
            unassigned += 1
            continue
        cluster_id, _ = full_id.split(":", 1)
        if cluster_id not in buckets:
            continue
        buckets[cluster_id].setdefault(full_id, []).append(namespace_name(namespace))

    if unassigned:
        print(f"warning: 有 {unassigned} 个 namespace 缺少 {PROJECT_ID_ANNOTATION} 注解,已跳过",
              file=sys.stderr)

    def project_key(project_id):
        project = project_by_id.get(project_id)
        if not project:
            return project_id
        return project.get("name") or project.get("displayName") or project_id

    def cluster_key(cluster_id):
        cluster = cluster_by_id.get(cluster_id)
        if not cluster:
            return cluster_id
        return cluster.get("name") or cluster.get("displayName") or cluster_id

    if cluster is not None:
        cluster_id = next(iter(wanted))
        return {
            project_key(project_id): sorted(names)
            for project_id, names in sorted(buckets[cluster_id].items())
        }

    return {
        cluster_key(cluster_id): {
            project_key(project_id): sorted(names)
            for project_id, names in sorted(project_map.items())
        }
        for cluster_id, project_map in sorted(buckets.items())
    }


def main():
    parser = argparse.ArgumentParser(description="列出 Rancher 上的 project/namespace")
    parser.add_argument("cluster", nargs="?", help="集群 name 或 id,不传则输出所有集群")
    args = parser.parse_args()

    with make_client() as client:
        clusters, projects, namespaces = fetch(client)

    result = build_namespace_map(clusters, projects, namespaces, args.cluster)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
