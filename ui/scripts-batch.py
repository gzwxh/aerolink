import io, re

# ---------- routes ----------
path = 'src/routes.tsx'
src = io.open(path, encoding='utf-8').read()

imports = []
routes = []
for type_, page in [
    ('statefulsets', 'StatefulSetListPage'),
    ('daemonsets', 'DaemonSetListPage'),
    ('pods', 'PodListPage'),
    ('jobs', 'JobListPage'),
    ('cronjobs', 'CronJobListPage'),
]:
    routes.append(
        "        {\n          path: '"
        + type_
        + "/create',\n          element: <DeploymentCreatePage resourceType=\""
        + type_
        + "\" />,\n        },\n        {\n          path: '"
        + type_
        + "/:namespace/create',\n          element: <DeploymentCreatePage resourceType=\""
        + type_
        + "\" />,\n        },\n        {\n          path: '"
        + type_
        + "/:namespace',\n          element: <"
        + page
        + " />,\n        },"
    )
    imports.append("import { " + page + " } from './pages/" + type_ + "-list-page'")

anchor = "import { DeploymentListPage } from './pages/deployment-list-page'"
for imp in imports:
    if imp not in src:
        src = src.replace(anchor, anchor + '\n' + imp, 1)

anchor2 = """        {
          path: 'deployments/:namespace',
          element: <DeploymentListPage />,
        },"""
for r in routes:
    marker = "path: '" + r.split("'")[1] + "'"
    if marker not in src:
        src = src.replace(anchor2, anchor2 + '\n' + r, 1)

io.open(path, 'w', encoding='utf-8', newline='').write(src)
print('routes-batch-done')

# ---------- list pages ----------
DIALOG_JSX = re.compile(r"\n\s*<DeploymentCreateDialog[\s\S]*?/>\r?\n")

for type_ in ['statefulsets', 'daemonsets', 'pods', 'jobs', 'cronjobs']:
    fname = 'src/pages/' + type_ + '-list-page.tsx'
    s = io.open(fname, encoding='utf-8').read()

    # remove dialog JSX
    s = DIALOG_JSX.sub('\n', s, count=1)
    # remove dialog import
    s = re.sub(
        r"import \{ DeploymentCreateDialog \} from '@/components/editors/deployment-create-dialog'\r?\n",
        '',
        s,
        count=1,
    )
    # remove leftover dialog state if present
    s = re.sub(
        r"\n\s*const \[isCreateDialogOpen, setIsCreateDialogOpen\] = useState\(false\)",
        '',
        s,
        count=1,
    )

    ns_expr = (
        "namespaceParam ||\n"
        "      localStorage.getItem(\n"
        "        getClusterScopedStorageKey('selectedNamespace')\n"
        "      ) ||\n"
        "      'default'"
    )
    create_fn = (
        "const handleCreateClick = () => {\n"
        "    const ns =\n"
        "      namespaceParam ||\n"
        "      localStorage.getItem(\n"
        "        getClusterScopedStorageKey('selectedNamespace')\n"
        "      ) ||\n"
        "      'default'\n"
        "    navigate(`/" + type_ + "/${encodeURIComponent(ns)}/create?tab=container-0`)\n"
        "  }"
    )

    if 'onCreateClick={() => setIsCreateDialogOpen(true)}' in s:
        s = s.replace(
            'onCreateClick={() => setIsCreateDialogOpen(true)}',
            'onCreateClick={handleCreateClick}',
            1,
        )
        # insert handleCreateClick before `return (`
        s = s.replace('  return (', '  ' + create_fn + '\n\n  return (', 1)
    elif 'handleCreateClick' not in s:
        s = s.replace('  return (', '  ' + create_fn + '\n\n  return (', 1)

    # ResourceTable: initialNamespace + onNamespaceChange after showCreateButton
    s = re.sub(
        r"(\n(\s*)showCreateButton=\{true\}\n)",
        "\n\\2initialNamespace={namespaceParam}\n"
        "\\2onNamespaceChange={(ns) => {\n"
        "\\2  navigate(\n"
        "\\2    ns && ns !== '_all'\n"
        "\\2      ? `/" + type_ + "/${encodeURIComponent(ns)}`\n"
        "\\2      : '/" + type_ + "',\n"
        "\\2    { replace: true }\n"
        "\\2  )\n"
        "\\2}}\n",
        s,
        count=1,
    )

    # imports: useParams + getClusterScopedStorageKey
    if 'useParams' not in s:
        s = s.replace(
            "useNavigate } from 'react-router-dom'",
            "useNavigate, useParams } from 'react-router-dom'",
        )
    if 'getClusterScopedStorageKey' not in s.split('handleCreateClick')[0]:
        m = re.search(r"import \{[^}]*\} from '@/lib/api'", s)
        if m:
            s = s.replace(
                m.group(0),
                m.group(0)
                + "\nimport { getClusterScopedStorageKey } from '@/lib/current-cluster'",
                1,
            )

    # destructure namespaceParam from useParams (add if missing)
    if 'const { namespace: namespaceParam } = useParams()' not in s:
        s = re.sub(
            r"(const navigate = useNavigate\(\)\r?\n)",
            r"\1  const { namespace: namespaceParam } = useParams()\n",
            s,
            count=1,
        )

    io.open(fname, 'w', encoding='utf-8', newline='').write(s)
    print(type_, 'patched')
